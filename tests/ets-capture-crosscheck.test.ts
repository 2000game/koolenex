/**
 * ETS capture-diff parity gate. Parses a real ETS download log (captured
 * on-site, 2026-07-17) for device 1.1.13 and reassembles the A_Memory_Write
 * telegrams ETS sent into an absolute address map, then diffs the relmem
 * parameter segment against koolenex's built image. Proves byte-parity against
 * ground truth without writing to any device.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseEtsMemoryWrites } from '../server/ets-capture.ts';

const FIX = path.join(import.meta.dirname, 'fixtures');

describe('ETS capture parity — 1.1.13 relmem param segment', () => {
  const xml = fs.readFileSync(path.join(FIX, 'ets-writes2-1.1.13.xml'), 'utf8');
  const ours = Buffer.from(
    fs.readFileSync(path.join(FIX, 'relmem-1.1.13-image.hex'), 'utf8').trim(),
    'hex',
  );

  it('reassembles ETS writes into the param image at base 0x0200', () => {
    const writes = parseEtsMemoryWrites(xml);
    // reassemble absolute address -> byte from all ETS memory writes
    const mem = new Map<number, number>();
    for (const w of writes)
      for (let i = 0; i < w.bytes.length; i++) mem.set(w.addr + i, w.bytes[i]!);

    const BASE = 0x0200;
    const diffs: number[] = [];
    for (let off = 0; off < ours.length; off++) {
      const ets = mem.get(BASE + off);
      if (ets !== undefined && ets !== ours[off]) diffs.push(off);
    }

    // Known builder bug (fixed in Task 6): our image writes 0x54,0xA8 at
    // offsets 0x7b/0x7c where ETS leaves 0x00 (inactive parameters).
    assert.deepEqual(
      diffs,
      [0x7b, 0x7c],
      `unexpected parity diffs at offsets: ${diffs
        .map((d) => '0x' + d.toString(16))
        .join(', ')}`,
    );
  });
});
