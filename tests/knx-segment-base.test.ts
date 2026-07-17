import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTableReference } from '../server/knx-segment-base.ts';

describe('parseTableReference', () => {
  it('parses a 4-byte big-endian pointer', () => {
    assert.equal(parseTableReference(Buffer.from('00000200', 'hex')), 0x0200);
    assert.equal(parseTableReference(Buffer.from('00000100', 'hex')), 0x0100);
    assert.equal(parseTableReference(Buffer.from('00000500', 'hex')), 0x0500);
  });

  it('returns null for the unallocated zero pointer', () => {
    assert.equal(parseTableReference(Buffer.from('00000000', 'hex')), null);
  });

  it('returns null for a too-short buffer', () => {
    assert.equal(parseTableReference(Buffer.alloc(0)), null);
    assert.equal(parseTableReference(Buffer.from('0002', 'hex')), null);
  });
});

import { resolveRelmemBases } from '../server/knx-segment-base.ts';

describe('resolveRelmemBases', () => {
  const STEPS = [
    { type: 'RelSegment', lsmIdx: 4 },
    { type: 'WriteRelMem', objIdx: 4, offset: 0, size: 4 },
  ];

  it('reads PID 7 for each relmem objIdx and returns bases', async () => {
    const calls: unknown[] = [];
    const bus = {
      readPropertyMany: async (_addr: string, reads: unknown[]) => {
        calls.push(reads);
        return [Buffer.from('00000200', 'hex')];
      },
    };
    const r = await resolveRelmemBases(bus, '1.1.13', STEPS);
    assert.deepEqual(calls[0], [{ objIdx: 4, propId: 7 }]);
    assert.deepEqual(r.bases, { 4: 0x0200 });
    assert.deepEqual(r.unallocated, []);
  });

  it('flags a zero pointer as unallocated', async () => {
    const bus = {
      readPropertyMany: async () => [Buffer.from('00000000', 'hex')],
    };
    const r = await resolveRelmemBases(bus, '1.1.13', STEPS);
    assert.deepEqual(r.bases, {});
    assert.deepEqual(r.unallocated, [4]);
  });
});
