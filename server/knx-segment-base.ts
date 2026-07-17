// server/knx-segment-base.ts
//
// Resolve the absolute base address of a relmem (RelativeSegment) parameter
// segment on a System B / BCU2-style device. The base is not in the .knxproj;
// it lives in the device and is read from interface-object Property 7
// (PID_TABLE_REFERENCE), the pointer ETS itself reads before writing.

/** PID_TABLE_REFERENCE — the interface-object property holding a segment's
 *  absolute base address on BCU2/System B masks. */
export const PID_TABLE_REFERENCE = 7;

/**
 * Parse a PID 7 property value into an absolute base address. The value is a
 * 4-byte big-endian pointer. A `0x00000000` pointer means the segment is NOT
 * allocated — writing then targets near-zero addresses and fails (the observed
 * ETS first-attempt failure). Returns null for that case and for short values.
 */
export function parseTableReference(buf: Buffer): number | null {
  if (buf.length < 4) return null;
  const addr = buf.readUInt32BE(0);
  return addr === 0 ? null : addr;
}
