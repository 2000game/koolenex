/**
 * Tests for A_Memory_Read: the connected-mode APDU builder and the
 * A_Memory_Response parser. These are the safety-critical pure functions for the
 * read-first device validation path (no writes to hardware).
 *
 * KNX A_Memory_Read/Response wire layout (connected-mode PDU):
 *   octet6 [7:2]=TPCI  [1:0]=APCI bits 3-2
 *   octet7 [7:6]=APCI bits 1-0  [5:0]=number (byte count, max 63)
 *   octet8 = address high, octet9 = address low
 *   (Response only) octet10.. = `number` data bytes
 * APCI: Memory_Read = 0b1000 (8), Memory_Response = 0b1001 (9).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  apduMemoryRead,
  parseMemoryResponse,
  apduMemoryExtendedRead,
  parseMemoryExtendedResponse,
  buildCEMI,
  parseCEMI,
  TPCI,
} from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';

/**
 * A fake device: answers every A_Memory_Read with the corresponding slice of a
 * backing memory buffer, so readMemory() can be exercised without hardware.
 */
class FakeMemoryDevice extends KnxConnection {
  sent: Buffer[] = [];
  constructor(
    private readonly deviceAddr: string,
    private readonly memory: Buffer,
  ) {
    super();
    this.connected = true;
    this.localAddr = '1.0.1';
  }
  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (frame && frame.apciName === 'Memory_Read') {
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      const data = this.memory.slice(address, address + count);
      const word = (TPCI.DATA_CONNECTED << 10) | (9 << 6) | count;
      const respApdu = Buffer.concat([
        Buffer.from([
          (word >> 8) & 0xff,
          word & 0xff,
          (address >> 8) & 0xff,
          address & 0xff,
        ]),
        data,
      ]);
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    }
    return Promise.resolve();
  }
  disconnect(): void {
    this.connected = false;
  }
}

describe('apduMemoryRead', () => {
  it('encodes seq, byte-count in octet7, and 2-byte address (standard layout)', () => {
    // seq=0 → TPCI DATA_CONNECTED = 0x10; count=3; address=0x1234
    // word = (0x10<<10) | (8<<6) | 3 = 0x4203
    const apdu = apduMemoryRead(0, 3, 0x1234);
    assert.deepEqual([...apdu], [0x42, 0x03, 0x12, 0x34]);
  });

  it('places the sequence number in the TPCI field', () => {
    // seq=5 → TPCI = 0x15; count=3; address=0x1234
    // word = (0x15<<10) | 0x200 | 3 = 0x5603
    const apdu = apduMemoryRead(5, 3, 0x1234);
    assert.deepEqual([...apdu], [0x56, 0x03, 0x12, 0x34]);
  });

  it('caps the count into the low 6 bits of octet7', () => {
    // count=63 (0x3f) is the max; address 0x00A0
    const apdu = apduMemoryRead(0, 63, 0x00a0);
    assert.deepEqual([...apdu], [0x42, 0x3f, 0x00, 0xa0]);
  });
});

describe('parseMemoryResponse', () => {
  it('decodes address and exactly `count` data bytes from a device response', () => {
    // Build the A_Memory_Response the device would send: count=3, addr=0x1234,
    // data=[0xAA,0xBB,0xCC]. word = (0x10<<10)|(9<<6)|3 = 0x4243.
    const apdu = Buffer.from([0x42, 0x43, 0x12, 0x34, 0xaa, 0xbb, 0xcc]);
    const cemi = buildCEMI('1.1.4', '0.0.1', apdu, false);
    const frame = parseCEMI(cemi);
    assert.ok(frame);
    assert.equal(frame.apciName, 'Memory_Response');

    const parsed = parseMemoryResponse(frame);
    assert.equal(parsed.address, 0x1234);
    assert.deepEqual([...parsed.data], [0xaa, 0xbb, 0xcc]);
  });

  it('ignores trailing bytes beyond the reported count', () => {
    // count=2 but 3 data bytes present → only the first 2 are the payload.
    const apdu = Buffer.from([0x42, 0x42, 0x00, 0x60, 0x01, 0x02, 0x99]);
    const frame = parseCEMI(buildCEMI('1.1.4', '0.0.1', apdu, false));
    assert.ok(frame);
    const parsed = parseMemoryResponse(frame);
    assert.equal(parsed.address, 0x0060);
    assert.deepEqual([...parsed.data], [0x01, 0x02]);
  });
});

describe('apduMemoryExtendedRead', () => {
  it('encodes the 0x1FD APCI with count + 3-byte address (System B/7)', () => {
    // seq=0 → TPCI 0x10; word = (0x10<<10)|0x1FD = 0x41FD → [0x41,0xFD]
    // then count=8, address=0x123456 (3 bytes)
    const apdu = apduMemoryExtendedRead(0, 8, 0x123456);
    assert.deepEqual([...apdu], [0x41, 0xfd, 0x08, 0x12, 0x34, 0x56]);
  });

  it('carries the sequence number in the TPCI field', () => {
    const apdu = apduMemoryExtendedRead(3, 1, 0x000060);
    // tpci = 0x13 → word = (0x13<<10)|0x1FD = 0x4DFD
    assert.deepEqual([...apdu], [0x4d, 0xfd, 0x01, 0x00, 0x00, 0x60]);
  });
});

describe('parseMemoryExtendedResponse', () => {
  it('decodes return code, 3-byte address, and data', () => {
    // A_MemoryExtended_Read_Response 0x1FE: [rc][addr(3)][data]
    // word = (0x10<<10)|0x1FE = 0x41FE
    const apdu = Buffer.from([0x41, 0xfe, 0x00, 0x12, 0x34, 0x56, 0xaa, 0xbb]);
    const frame = parseCEMI(buildCEMI('1.1.2', '1.0.2', apdu, false));
    assert.ok(frame);
    // parseCEMI must recognise the 10-bit extended APCI, not mistake it for ADC
    assert.equal(frame.apciName, 'MemoryExtended_Read_Response');

    const parsed = parseMemoryExtendedResponse(frame);
    assert.equal(parsed.returnCode, 0);
    assert.equal(parsed.address, 0x123456);
    assert.deepEqual([...parsed.data], [0xaa, 0xbb]);
  });

  it('surfaces a non-zero return code (access error)', () => {
    const apdu = Buffer.from([0x41, 0xfe, 0x01, 0x00, 0x00, 0x60]);
    const frame = parseCEMI(buildCEMI('1.1.2', '1.0.2', apdu, false));
    assert.ok(frame);
    const parsed = parseMemoryExtendedResponse(frame);
    assert.equal(parsed.returnCode, 1);
    assert.equal(parsed.data.length, 0);
  });
});

describe('KnxConnection.readMemory', () => {
  it('reassembles a multi-chunk read from device memory', async () => {
    // Device memory: byte[address] == address & 0xff for a known region.
    const mem = Buffer.alloc(0x0200);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    const dev = new FakeMemoryDevice('1.1.4', mem);

    // Read 20 bytes from 0x0100 in 8-byte chunks → spans 3 reads.
    const out = await dev.readMemory('1.1.4', 0x0100, 20, 8);

    assert.equal(out.length, 20);
    assert.deepEqual([...out], [...mem.slice(0x0100, 0x0100 + 20)]);
    // Read frames sent (excluding CONNECT/DISCONNECT control): 3 chunks.
    const reads = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'Memory_Read');
    assert.equal(reads.length, 3);
  });
});
