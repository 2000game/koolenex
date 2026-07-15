// ── KNX table builders ────────────────────────────────────────────────────────

// ── ETS dynamic tree types (matches ets-app.ts DynItem emission) ────────────
// The stored model shape is a single recursive `items` array of tagged
// DynItems: dynTree.main.items -> DynItem[], where each item's `type` is one
// of cib/channel/block/choose/paramRef/assign/comRef/rename/separator. This
// mirrors the `DynItem` union in server/ets-app.ts — NOT the legacy
// channels/cib/pb + paramRefs/blocks/choices shape that emission never
// actually produces.

export interface DynWhen {
  test?: string[];
  isDefault?: boolean;
  items?: DynItem[];
}

export interface DynItem {
  type:
    | 'paramRef'
    | 'block'
    | 'channel'
    | 'cib'
    | 'choose'
    | 'assign'
    | 'comRef'
    | 'rename'
    | 'separator';
  // paramRef
  refId?: string;
  // block / channel / cib
  items?: DynItem[];
  // choose
  paramRefId?: string;
  defaultValue?: string | null;
  whens?: DynWhen[];
  // assign
  target?: string;
  source?: string | null;
  value?: string | null;
}

export interface DynTree {
  main?: { items?: DynItem[] } | null;
  moduleDefs?: { id: string; items: DynItem[] }[];
}

export interface ParamDef {
  defaultValue?: string;
  [key: string]: unknown;
}

export interface ParamMemEntry {
  offset: number | null;
  bitOffset: number;
  bitSize: number;
  defaultValue?: string;
  isText?: boolean;
  isFloat?: boolean;
  coefficient?: number;
  fromMemoryChild?: boolean;
  isVisible?: boolean;
}

export interface LoadProcedureStep {
  type: string;
  size?: number;
  fill?: number;
  lsmIdx?: number;
  data?: string | null;
  [key: string]: unknown;
}

export interface AbsSegData {
  size: number;
  hex?: string | null;
}

export interface DeviceModel {
  loadProcedures?: LoadProcedureStep[];
  relSegData?: Record<number, string>;
  absSegData?: Record<string, AbsSegData>;
  paramMemLayout?: Record<string, ParamMemEntry>;
  dynTree?: DynTree;
  params?: Record<string, ParamDef>;
}

export interface ParamSegmentResult {
  paramSize: number;
  paramFill: number;
  relSegHex: string | null;
  /**
   * Absolute base address of the resolved AbsoluteSegment (null for
   * RelSegment/WriteRelMem devices, which address memory relatively).
   */
  paramBase: number | null;
}

export interface GaLink {
  address?: string;
  main_g: number;
  middle_g: number;
  sub_g: number;
}

export interface CoRow {
  object_number: number;
  ga_address: string;
}

// Build GA table bytes: [count(1)] + [GA_encoded(2) x count]
export interface MemoryDiffChunk {
  address: number;
  expected: string;
  actual: string;
}

export interface MemoryDiffResult {
  total: number;
  matching: number;
  differing: number;
  chunks: MemoryDiffChunk[];
}

/**
 * Byte-compare a computed image against actual device memory read back from the
 * bus. Compares over the shorter of the two lengths and coalesces consecutive
 * differing bytes into chunks, each tagged with its absolute device address
 * (baseAddress + offset). Used by the read-first verification flow — no writes.
 */
export function diffMemory(
  expected: Buffer,
  actual: Buffer,
  baseAddress: number,
): MemoryDiffResult {
  const total = Math.min(expected.length, actual.length);
  const chunks: MemoryDiffChunk[] = [];
  let differing = 0;
  let run: { start: number; exp: number[]; act: number[] } | null = null;

  const flush = (): void => {
    if (!run) return;
    chunks.push({
      address: baseAddress + run.start,
      expected: Buffer.from(run.exp).toString('hex'),
      actual: Buffer.from(run.act).toString('hex'),
    });
    run = null;
  };

  for (let i = 0; i < total; i++) {
    if (expected[i] !== actual[i]) {
      differing++;
      if (!run) run = { start: i, exp: [], act: [] };
      run.exp.push(expected[i]!);
      run.act.push(actual[i]!);
    } else {
      flush();
    }
  }
  flush();

  return { total, matching: total - differing, differing, chunks };
}

export function buildGATable(gaLinks: GaLink[]): Buffer {
  const count = gaLinks.length;
  const buf = Buffer.alloc(1 + count * 2);
  buf[0] = count & 0xff;
  gaLinks.forEach((ga, i) => {
    const b0 = ((ga.main_g & 0x1f) << 3) | (ga.middle_g & 0x07);
    const b1 = ga.sub_g & 0xff;
    buf[1 + i * 2] = b0;
    buf[2 + i * 2] = b1;
  });
  return buf;
}

// Build association table bytes: [count(1)] + [CO_num(1), GA_idx(1)] x count
export function buildAssocTable(coRows: CoRow[], gaLinks: GaLink[]): Buffer {
  const gaIndexMap: Record<string, number> = {};
  gaLinks.forEach((ga, i) => {
    if (ga.address) gaIndexMap[ga.address] = i;
  });

  const entries: [number, number][] = [];
  for (const co of coRows) {
    const gas = (co.ga_address || '').split(/\s+/).filter(Boolean);
    for (const gaAddr of gas) {
      const gaIdx = gaIndexMap[gaAddr];
      if (gaIdx != null) entries.push([co.object_number & 0xff, gaIdx & 0xff]);
    }
  }

  entries.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const buf = Buffer.alloc(1 + entries.length * 2);
  buf[0] = entries.length & 0xff;
  entries.forEach(([co, ga], i) => {
    buf[1 + i * 2] = co;
    buf[2 + i * 2] = ga;
  });
  return buf;
}

// Test whether a numeric/string value matches an ETS when-test condition.
export function etsTestMatch(
  val: string | number,
  tests: (string | number)[] | null | undefined,
): boolean {
  const n = parseFloat(String(val));
  for (const t of tests || []) {
    const rm =
      typeof t === 'string' && t.match(/^(!=|=|[<>]=?)(-?\d+(?:\.\d+)?)$/);
    if (rm) {
      if (isNaN(n)) continue;
      const rv = parseFloat(rm[2]!);
      const op = rm[1];
      if (op === '<' && n < rv) return true;
      if (op === '>' && n > rv) return true;
      if (op === '<=' && n <= rv) return true;
      if (op === '>=' && n >= rv) return true;
      if (op === '=' && n === rv) return true;
      if (op === '!=' && n !== rv) return true;
    } else if (String(t) === val) {
      return true;
    }
  }
  return false;
}

const CONTAINER_TYPES = new Set(['block', 'channel', 'cib']);

// Build the set of paramRefs that are unconditionally reachable from the
// top-level `items` tree without passing through any `choose` branch.
export function buildUnconditionalChannelSet(
  dynTree: DynTree | null | undefined,
): Set<string> {
  const s = new Set<string>();
  function walk(items: DynItem[] | undefined): void {
    for (const it of items || []) {
      if (it.type === 'paramRef' && it.refId) s.add(it.refId);
      else if (CONTAINER_TYPES.has(it.type)) walk(it.items);
      // choose: skip — its contents are conditional
    }
  }
  walk(dynTree?.main?.items);
  return s;
}

// paramRefs reachable through the CURRENTLY-ACTIVE `choose` branches.
export function evalConditionallyActiveParamRefs(
  dynTree: DynTree | null | undefined,
  params: Record<string, ParamDef>,
  currentValues: Record<string, unknown>,
): Set<string> {
  const conditional = new Set<string>();
  const getVal = (prKey: string): string => {
    if (prKey in currentValues) return String(currentValues[prKey]);
    return String(params[prKey]?.defaultValue ?? '');
  };
  function walk(items: DynItem[] | undefined, inChoice: boolean): void {
    for (const it of items || []) {
      if (it.type === 'paramRef') {
        if (inChoice && it.refId) conditional.add(it.refId);
      } else if (CONTAINER_TYPES.has(it.type)) {
        walk(it.items, inChoice);
      } else if (it.type === 'choose') {
        evalChoose(it);
      }
    }
  }
  function evalChoose(ch: DynItem): void {
    const raw = getVal(ch.paramRefId!);
    const val = String(
      raw !== '' && raw != null ? raw : (ch.defaultValue ?? ''),
    );
    let matched = false;
    let def: DynWhen | undefined;
    for (const w of ch.whens || []) {
      if (w.isDefault) {
        def = w;
        continue;
      }
      if (etsTestMatch(val, w.test ?? null)) {
        matched = true;
        walk(w.items, true);
      }
    }
    if (!matched && def) walk(def.items, true);
  }
  walk(dynTree?.main?.items, false);
  return conditional;
}

// Encode a value as KNX 2-byte float (DPT 9.x) and write big-endian at byteOffset.
// Format: sign(1) + exponent(4) + mantissa(11). value = 0.01 x mantissa x 2^exponent
export function writeKnxFloat16(
  buf: Buffer,
  byteOffset: number,
  value: number,
): void {
  if (byteOffset + 2 > buf.length) return;
  let m = Math.round(value * 100);
  let e = 0;
  while (m < -2048 || m > 2047) {
    m = Math.round(m / 2);
    e++;
    if (e > 15) break;
  }
  const sign = m < 0 ? 1 : 0;
  if (sign) m = m + 2048;
  const raw = (sign << 15) | ((e & 0xf) << 11) | (m & 0x7ff);
  buf[byteOffset] = (raw >> 8) & 0xff;
  buf[byteOffset + 1] = raw & 0xff;
}

// Write `bitSize` bits of `value` into buf at byte `byteOffset`, starting from bit `bitOffset`.
export function writeBits(
  buf: Buffer,
  byteOffset: number,
  bitOffset: number,
  bitSize: number,
  value: number,
): void {
  if (byteOffset >= buf.length || bitSize <= 0) return;
  const mask = bitSize >= 32 ? 0xffffffff : (1 << bitSize) - 1;
  value = value & mask;
  // Byte-aligned multi-byte: write big-endian (KNX/ETS standard)
  if (bitOffset === 0 && bitSize % 8 === 0) {
    const byteCount = bitSize / 8;
    for (let i = 0; i < byteCount; i++) {
      const bIdx = byteOffset + i;
      if (bIdx >= buf.length) continue;
      buf[bIdx] = (value >>> ((byteCount - 1 - i) * 8)) & 0xff;
    }
    return;
  }
  // Sub-byte: bitOffset from MSB (KNX convention: bitOffset=0 is bit 7 of the byte).
  if (bitOffset + bitSize > 8) {
    const bitsInFirstByte = 8 - bitOffset;
    writeBits(
      buf,
      byteOffset,
      bitOffset,
      bitsInFirstByte,
      value >>> (bitSize - bitsInFirstByte),
    );
    writeBits(buf, byteOffset + 1, 0, bitSize - bitsInFirstByte, value);
    return;
  }
  const shift = 8 - bitOffset - bitSize;
  const bmask = ((1 << bitSize) - 1) << shift;
  buf[byteOffset] = (buf[byteOffset]! & ~bmask) | ((value << shift) & bmask);
}

export interface DynAssign {
  target: string;
  source: string | null;
  value: string | null;
}

// Collect Assign operations whose when-branch is currently active.
export function collectActiveAssigns(
  dynTree: DynTree | null | undefined,
  params: Record<string, ParamDef>,
  currentValues: Record<string, unknown>,
): DynAssign[] {
  const result: DynAssign[] = [];
  const getVal = (prKey: string): string => {
    if (prKey in currentValues) return String(currentValues[prKey]);
    return String(params[prKey]?.defaultValue ?? '');
  };
  function walk(items: DynItem[] | undefined): void {
    for (const it of items || []) {
      if (it.type === 'assign' && it.target) {
        result.push({
          target: it.target,
          source: it.source ?? null,
          value: it.value ?? null,
        });
      } else if (CONTAINER_TYPES.has(it.type)) {
        walk(it.items);
      } else if (it.type === 'choose') {
        evalChoose(it);
      }
    }
  }
  function evalChoose(ch: DynItem): void {
    const raw = getVal(ch.paramRefId!);
    const val = String(
      raw !== '' && raw != null ? raw : (ch.defaultValue ?? ''),
    );
    let matched = false;
    let def: DynWhen | undefined;
    for (const w of ch.whens || []) {
      if (w.isDefault) {
        def = w;
        continue;
      }
      if (etsTestMatch(val, w.test ?? null)) {
        matched = true;
        walk(w.items);
      }
    }
    if (!matched && def) walk(def.items);
  }
  walk(dynTree?.main?.items);
  return result;
}

// Determine parameter segment size and base data for a device model.
export function resolveParamSegment(model: DeviceModel): ParamSegmentResult {
  const lps = model.loadProcedures ?? [];
  // Try RelativeSegment path first (most common)
  const writeMemStep = lps.find((s) => s.type === 'WriteRelMem');
  const relSegStep = lps.find((s) => s.type === 'RelSegment');
  if (writeMemStep || relSegStep) {
    const paramSize = writeMemStep?.size ?? relSegStep?.size ?? 0;
    const paramFill = relSegStep?.fill ?? 0xff;
    const paramLsmIdx = relSegStep?.lsmIdx ?? 4;
    const relSegHex = model.relSegData?.[paramLsmIdx] ?? null;
    return { paramSize, paramFill, relSegHex, paramBase: null };
  }
  // Try AbsoluteSegment path
  const absSegs = model.absSegData ?? {};
  const layout = model.paramMemLayout ?? {};
  const paramOffsets = Object.values(layout)
    .map((v) => v.offset)
    .filter((v): v is number => v != null);
  if (paramOffsets.length === 0 || Object.keys(absSegs).length === 0) {
    return { paramSize: 0, paramFill: 0xff, relSegHex: null, paramBase: null };
  }
  const maxOffset = Math.max(...paramOffsets);
  // Pick the TIGHTEST-fitting segment whose size covers every parameter
  // offset — not merely the first one larger than maxOffset. On multi-segment
  // AbsoluteSegment devices (e.g. MDT AKS-0416.03 / 1.1.3) an unrelated,
  // larger segment (the address table) can also exceed maxOffset by pure
  // coincidence; the real parameter segment is the smallest segment that
  // still contains the whole [0, maxOffset] range (confirmed against ETS's
  // own load-state "segment" (event 3) descriptor, which encodes the true
  // base/size).
  let best: [string, AbsSegData] | null = null;
  for (const entry of Object.entries(absSegs)) {
    const seg = entry[1];
    if (seg.size > maxOffset && (!best || seg.size < best[1].size)) {
      best = entry;
    }
  }
  if (best) {
    const [addrKey, seg] = best;
    return {
      paramSize: seg.size,
      paramFill: 0x00,
      relSegHex: seg.hex ?? null,
      paramBase: Number(addrKey),
    };
  }
  // Fallback: use the largest segment
  const largest = Object.entries(absSegs).sort(
    (a, b) => b[1].size - a[1].size,
  )[0];
  if (largest) {
    return {
      paramSize: largest[1].size,
      paramFill: 0x00,
      relSegHex: largest[1].hex ?? null,
      paramBase: Number(largest[0]),
    };
  }
  return { paramSize: 0, paramFill: 0xff, relSegHex: null, paramBase: null };
}

// Build parameter memory segment from the paramMemLayout.
export function buildParamMem(
  size: number,
  paramMemLayout: Record<string, ParamMemEntry>,
  currentValues: Record<string, unknown>,
  fill = 0xff,
  relSegHex: string | null = null,
  dynTree: DynTree | null = null,
  params: Record<string, ParamDef> | null = null,
): Buffer {
  const relSegBase = relSegHex ? Buffer.from(relSegHex, 'hex') : null;

  let buf: Buffer;
  if (relSegBase) {
    buf = Buffer.alloc(size, fill);
    relSegBase.copy(buf, 0, 0, Math.min(relSegBase.length, size));
  } else {
    buf = Buffer.alloc(size, fill);
  }

  const conditionallyActive =
    dynTree && params
      ? evalConditionallyActiveParamRefs(dynTree, params, currentValues)
      : null;
  const unconditionalChannel = dynTree
    ? buildUnconditionalChannelSet(dynTree)
    : null;

  for (const [prId, info] of Object.entries(paramMemLayout)) {
    if (info.offset === null || info.offset === undefined) continue;

    if (info.fromMemoryChild) {
      if (!info.isVisible && prId in currentValues) {
        // User explicitly set a hidden param — write it
      } else if (unconditionalChannel && unconditionalChannel.has(prId)) {
        // Unconditionally visible — write it
      } else {
        const passConditional =
          conditionallyActive && conditionallyActive.has(prId);
        if (!passConditional) continue;
      }
    }

    const rawVal =
      prId in currentValues
        ? (currentValues[prId] as string | number | null)
        : info.defaultValue;
    if (rawVal === '' || rawVal === null || rawVal === undefined) continue;

    if (info.isText) {
      const byteSize = Math.floor(info.bitSize / 8);
      if (info.offset + byteSize > buf.length) continue;
      const strBuf = Buffer.from(String(rawVal), 'latin1');
      strBuf.copy(buf, info.offset, 0, Math.min(strBuf.length, byteSize));
      continue;
    }
    if (info.isFloat) {
      const fVal = parseFloat(String(rawVal));
      if (isNaN(fVal)) continue;
      const scaledVal = info.coefficient ? fVal / info.coefficient : fVal;
      if (info.bitSize === 16) {
        writeKnxFloat16(buf, info.offset, scaledVal);
      } else if (info.bitSize === 32) {
        if (info.offset + 4 <= buf.length)
          buf.writeFloatBE(scaledVal, info.offset);
      } else if (info.bitSize === 64) {
        if (info.offset + 8 <= buf.length)
          buf.writeDoubleBE(scaledVal, info.offset);
      }
      continue;
    }
    const numVal = parseFloat(String(rawVal));
    if (isNaN(numVal)) continue;
    const intVal = info.coefficient
      ? Math.round(numVal / info.coefficient)
      : Math.round(numVal);
    writeBits(buf, info.offset, info.bitOffset, info.bitSize, intVal);
  }

  // Process Assign operations
  if (dynTree && params) {
    const activeAssigns = collectActiveAssigns(dynTree, params, currentValues);
    for (const { target, source, value } of activeAssigns) {
      const targetInfo = paramMemLayout[target];
      if (
        !targetInfo ||
        targetInfo.offset === null ||
        targetInfo.offset === undefined
      )
        continue;
      let assignRawVal: string | number | null | undefined;
      if (source) {
        const sourceParam = params[source];
        if (!sourceParam) continue;
        assignRawVal =
          source in currentValues
            ? (currentValues[source] as string | number | null)
            : sourceParam.defaultValue;
      } else {
        assignRawVal = value;
      }
      if (
        assignRawVal === '' ||
        assignRawVal === null ||
        assignRawVal === undefined
      )
        continue;
      const intVal = parseInt(String(assignRawVal), 10);
      if (isNaN(intVal)) continue;
      writeBits(
        buf,
        targetInfo.offset,
        targetInfo.bitOffset,
        targetInfo.bitSize,
        intVal,
      );
    }
  }

  return buf;
}
