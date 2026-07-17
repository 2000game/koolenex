// server/ets-capture.ts
//
// Parse an ETS "CommunicationLog" telegram XML export into the memory writes
// ETS sent. Used only by tests to diff koolenex's generated download against a
// real ETS download (ground-truth parity), without touching a device.

/** Extract every ETS-originated A_Memory_Write (short-form APCI 0xA). */
export function parseEtsMemoryWrites(
  xml: string,
): Array<{ addr: number; bytes: Buffer }> {
  const out: Array<{ addr: number; bytes: Buffer }> = [];
  const rx = /Service="(L_Data\.con)"[^>]*RawData="([0-9A-Fa-f]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(xml))) {
    const b = Buffer.from(m[2]!, 'hex');
    if (b.length < 13) continue;
    // CEMI: mc(0) addil(1) ctrl1(2) ctrl2(3) src(4-5) dst(6-7) len(8) tpci(9)...
    const tpci = b[9]!;
    if ((tpci & 0xc0) !== 0x40) continue; // numbered data packets only
    const apci = ((tpci & 0x03) << 8) | b[10]!;
    if (((apci >> 6) & 0xf) !== 0xa) continue; // A_Memory_Write
    const count = apci & 0x3f;
    const addr = (b[11]! << 8) | b[12]!;
    out.push({ addr, bytes: b.subarray(13, 13 + count) });
  }
  return out;
}
