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
