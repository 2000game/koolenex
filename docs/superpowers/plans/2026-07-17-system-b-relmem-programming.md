# System B relmem programming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify and download to System B (`0x07B0`) relmem devices at the correct, device-resident segment base address, guarded against the zero-pointer failure mode, and validated byte-for-byte against a captured ETS download.

**Architecture:** The absolute base of a relmem segment is not in the `.knxproj`; it lives in the device and is read via interface-object Property 7 (`PID_TABLE_REFERENCE`). We add a pure pointer parser, thread a resolved-base map through the pure planners (`planVerify`, a new `planRelmemWrites`), resolve bases over the bus in the routes with a hard zero-pointer guard, and add an offline capture-diff harness that proves parity against `writes2.xml` before any live write.

**Tech Stack:** Node.js + TypeScript (ESM), `node:test` runner, sql.js. Tests run with `node --test tests/<file>.test.ts`.

## Global Constraints

- Prettier: single quotes, trailing commas all. Run `make format lint test` before committing.
- Tests: `node:test` with `node:assert/strict`, `describe`/`it`. Import server modules with `.ts` extension (nodenext).
- Pure planners (`server/knx-download-plan.ts`) must stay pure — no bus, socket, DB, or hardware access. Bus I/O lives in routes / `knx-bus.ts`.
- `bus.readPropertyMany(deviceAddr, [{objIdx, propId}])` returns one value `Buffer` per read, 4-byte response header already stripped.
- Safety: **never issue a memory write when the resolved PID 7 base is `0x00000000`** (unallocated) — abort with a clear error first.
- Do not attempt any live device write as part of this plan. Live verify (read-only) is allowed; live download is a separate, user-driven step after the harness passes.

---

### Task 1: `parseTableReference` — PID 7 pointer parser

**Files:**
- Create: `server/knx-segment-base.ts`
- Test: `tests/knx-segment-base.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseTableReference(buf: Buffer): number | null` — returns the absolute base address (big-endian uint32 from the first 4 bytes), or `null` when the value is shorter than 4 bytes or the pointer is `0x00000000` (unallocated).

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/knx-segment-base.test.ts`
Expected: FAIL — cannot find module `knx-segment-base.ts`.

- [ ] **Step 3: Write minimal implementation**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/knx-segment-base.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/knx-segment-base.ts tests/knx-segment-base.test.ts
git commit -m "feat: parseTableReference for PID 7 segment base pointers"
```

---

### Task 2: Apply resolved base in `planVerify` (relmem)

**Files:**
- Modify: `server/knx-download-plan.ts` (relmem branch, ~lines 379–397; signature ~line 346)
- Test: `tests/knx-verify-plan.test.ts` (add cases)

**Interfaces:**
- Consumes: `parseTableReference` is not used here (planner stays pure).
- Produces: `planVerify(steps, gaTable, assocTable, paramMem, paramBase, absSegData?, appId?, relBaseByObj?)` — new optional final param `relBaseByObj?: Record<number, number>` (interface-object index → absolute base). The relmem branch emits regions at `addr = base + offset` where `base = relBaseByObj[objIdx] ?? 0`. Default `{}` preserves current behaviour (base 0).

- [ ] **Step 1: Write the failing test**

Add to `tests/knx-verify-plan.test.ts`:

```typescript
describe('planVerify relmem base resolution', () => {
  const REL_STEPS: PlanStep[] = [
    { type: 'RelSegment', lsmIdx: 4, size: 4 },
    { type: 'WriteRelMem', objIdx: 4, offset: 0, size: 4 },
  ];
  const PARAM = Buffer.from('deadbeef', 'hex');

  it('reads at offset only when no base is supplied (legacy default)', () => {
    const plan = planVerify(REL_STEPS, null, null, PARAM, null);
    assert.equal(plan.family, 'relmem');
    assert.equal(plan.mem[0]!.addr, 0x0000);
  });

  it('reads at base + offset when a base is supplied for the objIdx', () => {
    const plan = planVerify(REL_STEPS, null, null, PARAM, null, {}, '', {
      4: 0x0200,
    });
    assert.equal(plan.mem[0]!.addr, 0x0200);
    assert.equal(plan.mem[0]!.expected.toString('hex'), 'deadbeef');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/knx-verify-plan.test.ts`
Expected: FAIL — second case gets `addr` `0x0000` (or a TS arity error on the 8th argument).

- [ ] **Step 3: Implement**

Change the `planVerify` signature to add the final optional parameter:

```typescript
export function planVerify(
  steps: PlanStep[],
  gaTable: Buffer | null,
  assocTable: Buffer | null,
  paramMem: Buffer | null,
  paramBase: number | null,
  absSegData: Record<number, AbsSegSeed> = {},
  appId: string = '',
  relBaseByObj: Record<number, number> = {},
): VerifyPlan {
```

In the relmem branch, replace the region push (currently `addr: offset`) with:

```typescript
    for (const s of relSegs) {
      const offset = s.offset as number;
      const size = s.size as number;
      const objIdx = s.objIdx ?? 4;
      const base = relBaseByObj[objIdx] ?? 0;
      mem.push({
        addr: base + offset,
        expected: paramMem.subarray(0, size),
        label: `relmem@0x${(base + offset).toString(16)}`,
      });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/knx-verify-plan.test.ts`
Expected: PASS (existing cases still pass — default base is 0; new cases pass).

- [ ] **Step 5: Commit**

```bash
git add server/knx-download-plan.ts tests/knx-verify-plan.test.ts
git commit -m "feat: planVerify applies resolved relmem base address"
```

---

### Task 3: Resolve bases over the bus + wire into verify-device route (zero-guard)

**Files:**
- Modify: `server/knx-segment-base.ts` (add `resolveRelmemBases`)
- Modify: `server/routes/bus.ts` (`/bus/verify-device`, ~lines 877–960)
- Test: `tests/knx-segment-base.test.ts` (add cases with a fake bus)

**Interfaces:**
- Consumes: `parseTableReference` (Task 1); `bus.readPropertyMany`.
- Produces: `resolveRelmemBases(bus, deviceAddr, steps): Promise<{ bases: Record<number, number>; unallocated: number[] }>` where `bus` is `{ readPropertyMany(addr, reads): Promise<Buffer[]> }`. Reads PID 7 for each distinct `WriteRelMem` `objIdx`; a zero/short pointer lands in `unallocated`, everything else in `bases`.

- [ ] **Step 1: Write the failing test**

Add to `tests/knx-segment-base.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/knx-segment-base.test.ts`
Expected: FAIL — `resolveRelmemBases` is not exported.

- [ ] **Step 3: Implement `resolveRelmemBases`**

Append to `server/knx-segment-base.ts`:

```typescript
interface RelmemStep {
  type: string;
  objIdx?: number;
}

interface PropertyReader {
  readPropertyMany(
    deviceAddr: string,
    reads: Array<{ objIdx: number; propId: number }>,
  ): Promise<Buffer[]>;
}

/**
 * Read PID 7 over the bus for each distinct WriteRelMem interface object and
 * resolve its absolute base. Objects whose pointer is unallocated (0x00000000)
 * are returned in `unallocated` so the caller can refuse to write.
 */
export async function resolveRelmemBases(
  bus: PropertyReader,
  deviceAddr: string,
  steps: RelmemStep[],
): Promise<{ bases: Record<number, number>; unallocated: number[] }> {
  const objIdxs = [
    ...new Set(
      steps
        .filter((s) => s.type === 'WriteRelMem')
        .map((s) => s.objIdx ?? 4),
    ),
  ];
  if (objIdxs.length === 0) return { bases: {}, unallocated: [] };

  const values = await bus.readPropertyMany(
    deviceAddr,
    objIdxs.map((objIdx) => ({ objIdx, propId: PID_TABLE_REFERENCE })),
  );

  const bases: Record<number, number> = {};
  const unallocated: number[] = [];
  objIdxs.forEach((objIdx, i) => {
    const base = parseTableReference(values[i] ?? Buffer.alloc(0));
    if (base == null) unallocated.push(objIdx);
    else bases[objIdx] = base;
  });
  return { bases, unallocated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/knx-segment-base.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the verify-device route**

In `server/routes/bus.ts`, import at the top with the other imports:

```typescript
import { resolveRelmemBases } from '../knx-segment-base.ts';
```

In `/bus/verify-device`, after `buildDeviceProgramming` returns and before `planVerify` is called, resolve bases and guard. Replace the `planVerify(...)` call with:

```typescript
  // System B relmem segments live at a device-resident base (PID 7), not at
  // the step's relative offset. Resolve it over the bus and refuse to verify
  // an unallocated segment (a zero base would read the wrong low-memory region
  // and report a bogus all-zeros mismatch).
  const { bases, unallocated } = await resolveRelmemBases(
    b,
    deviceAddress,
    steps as Array<{ type: string; objIdx?: number }>,
  );
  if (unallocated.length) {
    return res.status(409).json({
      error: 'segment_unallocated',
      message: `Interface object(s) ${unallocated.join(', ')} report an unallocated segment (PID 7 = 0); device is not in a verifiable state.`,
    });
  }

  const plan = planVerify(
    steps as PlanStep[],
    gaTable,
    assocTable,
    paramMem,
    paramBase,
    absSegData,
    appId,
    bases,
  );
```

- [ ] **Step 6: Run the full suite + lint/format**

Run: `make format lint test`
Expected: all tests pass; no lint errors.

- [ ] **Step 7: Commit**

```bash
git add server/knx-segment-base.ts server/routes/bus.ts tests/knx-segment-base.test.ts
git commit -m "feat: resolve relmem base via PID 7 in verify-device with zero-pointer guard"
```

---

### Task 4: `planRelmemWrites` — pure relmem download planner + use in `downloadDevice`

**Files:**
- Modify: `server/knx-download-plan.ts` (add `planRelmemWrites`)
- Modify: `server/knx-connection.ts` (`downloadDevice` WriteRelMem branch, ~lines 683–708; add `resolvedBases` to `DownloadExtra`)
- Test: `tests/knx-download-plan.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing new (pure).
- Produces: `planRelmemWrites(steps, paramMem, bases, chunkSize?): Array<{ addr: number; bytes: Buffer }>` — for each `WriteRelMem` step, chunks `paramMem[0..size]` into `chunkSize` (default 10) writes at `addr = (bases[objIdx] ?? 0) + offset + off`.
- `DownloadExtra` gains `resolvedBases?: Record<number, number>`; `downloadDevice`'s WriteRelMem branch writes at `base + step.offset + off`.

- [ ] **Step 1: Write the failing test**

Add to `tests/knx-download-plan.test.ts`:

```typescript
import { planRelmemWrites } from '../server/knx-download-plan.ts';

describe('planRelmemWrites', () => {
  const STEPS: PlanStep[] = [
    { type: 'WriteRelMem', objIdx: 4, offset: 0, size: 5 },
  ];
  const PARAM = Buffer.from('0102030405', 'hex');

  it('chunks param memory at base + offset', () => {
    const ops = planRelmemWrites(STEPS, PARAM, { 4: 0x0200 }, 2);
    assert.deepEqual(
      ops.map((o) => o.addr),
      [0x0200, 0x0202, 0x0204],
    );
    assert.equal(Buffer.concat(ops.map((o) => o.bytes)).toString('hex'), '0102030405');
  });

  it('falls back to base 0 when the objIdx has no resolved base', () => {
    const ops = planRelmemWrites(STEPS, PARAM, {}, 2);
    assert.equal(ops[0]!.addr, 0x0000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/knx-download-plan.test.ts`
Expected: FAIL — `planRelmemWrites` is not exported.

- [ ] **Step 3: Implement `planRelmemWrites`**

Add to `server/knx-download-plan.ts`:

```typescript
/**
 * Pure planner for legacy RelSegment/WriteRelMem downloads: chunk the parameter
 * image into A_Memory_Write-sized pieces at the segment's ABSOLUTE address
 * (resolved base + relative offset). Mirrors the executor loop in
 * downloadDevice so it can be diffed against a captured ETS download offline.
 */
export function planRelmemWrites(
  steps: PlanStep[],
  paramMem: Buffer | null,
  bases: Record<number, number>,
  chunkSize = 10,
): Array<{ addr: number; bytes: Buffer }> {
  const ops: Array<{ addr: number; bytes: Buffer }> = [];
  if (!paramMem) return ops;
  for (const s of steps) {
    if (
      s.type !== 'WriteRelMem' ||
      typeof s.offset !== 'number' ||
      typeof s.size !== 'number'
    )
      continue;
    const base = bases[s.objIdx ?? 4] ?? 0;
    const mem = paramMem.subarray(0, s.size);
    for (let off = 0; off < mem.length; off += chunkSize) {
      ops.push({
        addr: base + s.offset + off,
        bytes: mem.subarray(off, off + chunkSize),
      });
    }
  }
  return ops;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/knx-download-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Use the base in `downloadDevice`**

In `server/knx-connection.ts`, find the `DownloadExtra` interface and add:

```typescript
  resolvedBases?: Record<number, number>;
```

In the `WriteRelMem` branch (~line 683), compute the base once and apply it to the address bytes:

```typescript
          case 'WriteRelMem': {
            log(`WriteRelMem ObjIdx=${step.objIdx} Size=${step.size}`);
            if (!paramMem) throw new Error('Parameter memory not available');
            const base = extra?.resolvedBases?.[step.objIdx ?? 4] ?? 0;
            const mem = paramMem.slice(0, step.size);
            for (let off = 0; off < mem.length; off += MEM_CHUNK) {
              const chunk = mem.slice(off, off + MEM_CHUNK);
              const seq = nextSeq();
              const addr = base + step.offset! + off;
              const extra2 = Buffer.concat([
                Buffer.from([chunk.length, (addr >> 8) & 0xff, addr & 0xff]),
                chunk,
              ]);
              const apdu = apduConnected(seq, 'Memory_Write', extra2);
              const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
              await this.sendCEMI(cemi);
              await delay(30);
              if (onProgress)
                onProgress({
                  msg: `WriteRelMem ${off}/${mem.length}`,
                  pct: (off / mem.length) * 80,
                });
            }
            break;
          }
```

- [ ] **Step 6: Run tests + lint/format**

Run: `make format lint test`
Expected: pass (existing `knx-connection` tests unaffected — default base 0).

- [ ] **Step 7: Commit**

```bash
git add server/knx-download-plan.ts server/knx-connection.ts tests/knx-download-plan.test.ts
git commit -m "feat: planRelmemWrites and base-aware WriteRelMem download"
```

---

### Task 5: ETS capture-diff harness (offline parity gate)

**Files:**
- Create: `tests/fixtures/ets-writes2-1.1.13.xml` (copy of `~/Downloads/writes2.xml`)
- Create: `tests/fixtures/relmem-1.1.13-image.hex` (355-byte expected param image, hex on one line — the `expectedHex` we already computed at base 0x0200)
- Create: `server/ets-capture.ts` (pure XML → ops parser)
- Test: `tests/ets-capture-crosscheck.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `parseEtsMemoryWrites(xml: string): Array<{ addr: number; bytes: Buffer }>` — extracts every ETS-sent `A_Memory_Write` (short-form APCI `0xA`) from an ETS communication log as `{ addr, bytes }`.

- [ ] **Step 1: Create fixtures**

```bash
cp "$HOME/Downloads/writes2.xml" tests/fixtures/ets-writes2-1.1.13.xml
```

Generate the expected image fixture from the verify data already captured this session (the 355-byte image ETS/koolenex agree on except the two builder-bug bytes). Write the hex string (from `verify13.json` `segments[0].expectedHex`) to `tests/fixtures/relmem-1.1.13-image.hex` as a single line.

- [ ] **Step 2: Write the failing test**

```typescript
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
      `unexpected parity diffs at offsets: ${diffs.map((d) => '0x' + d.toString(16)).join(', ')}`,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/ets-capture-crosscheck.test.ts`
Expected: FAIL — `ets-capture.ts` not found.

- [ ] **Step 4: Implement the parser**

```typescript
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/ets-capture-crosscheck.test.ts`
Expected: PASS — parity holds everywhere except the two known builder-bug bytes `0x7b`/`0x7c`.

- [ ] **Step 6: Commit**

```bash
git add server/ets-capture.ts tests/ets-capture-crosscheck.test.ts tests/fixtures/ets-writes2-1.1.13.xml tests/fixtures/relmem-1.1.13-image.hex
git commit -m "test: ETS capture-diff harness proving 1.1.13 relmem parity"
```

---

### Task 6: Fix inactive-parameter override in `buildParamMem` (0x7b/0x7c)

**Files:**
- Modify: `server/routes/knx-tables.ts` (`buildParamMem`, ~line 473 onward)
- Test: `tests/knx-tables.test.ts` (add case) and tighten `tests/ets-capture-crosscheck.test.ts`

**Interfaces:**
- Consumes: existing `buildParamMem` and `evalConditionallyActiveParamRefs`.
- Produces: no signature change. Behaviour change: a conditionally-inactive parameter must NOT overwrite the base-image byte with its default; it keeps the `relSegHex` base value (which ETS leaves untouched).

**Background:** offsets 123/124 (`0x7b`/`0x7c`) hold params `P-657` (default `84`=`0x54`) and `P-676` (default `168`=`0xA8`), both `isVisible:false`. ETS and the device leave them `0x00`; our builder applies the defaults. The two params are conditionally inactive in this configuration — `buildParamMem` already computes `conditionallyActive` via `evalConditionallyActiveParamRefs` but still writes their defaults.

- [ ] **Step 1: Write the failing test**

Add to `tests/ets-capture-crosscheck.test.ts` a strict-parity variant (initially failing), OR extend the existing test's expectation. Change the existing assertion from `assert.deepEqual(diffs, [0x7b, 0x7c], ...)` to:

```typescript
    assert.deepEqual(
      diffs,
      [],
      `param image must match ETS byte-for-byte; diffs at: ${diffs.map((d) => '0x' + d.toString(16)).join(', ')}`,
    );
```

Also regenerate `tests/fixtures/relmem-1.1.13-image.hex` from the corrected builder in Step 4 (the fixture must reflect the fixed image with `0x00` at `0x7b`/`0x7c`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ets-capture-crosscheck.test.ts`
Expected: FAIL — diffs `[0x7b, 0x7c]` ≠ `[]`.

- [ ] **Step 3: Investigate and fix**

Read `buildParamMem` and locate where each parameter's value is written into the buffer. Confirm the guard `conditionallyActive` (a set/lookup of active param refs) is consulted. Apply: when `conditionallyActive` is non-null and a parameter's ref is NOT active, `continue` (skip the write) so the base-image byte survives. Concretely, at the point where the entry value is about to be composed into `buf`:

```typescript
    // ETS does not write parameters that are conditionally inactive in the
    // current configuration — it leaves the base-image byte untouched. Match
    // that so our download image is byte-identical to ETS.
    if (conditionallyActive && !conditionallyActive.has(paramRefId)) continue;
```

(Use the actual active-set variable and the entry's param-ref key as they appear in `buildParamMem`; verify by re-reading the surrounding code.)

- [ ] **Step 4: Regenerate the fixture from the fixed builder**

Write a one-off script (or extend an existing tool) that runs `buildDeviceProgramming` for 1.1.13 against `koolenex.db` and writes the resulting 355-byte `paramMem` hex to `tests/fixtures/relmem-1.1.13-image.hex`. Verify `hex[0x7b*2..0x7c*2+1]` is now `0000`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/ets-capture-crosscheck.test.ts tests/knx-tables.test.ts`
Expected: PASS — full byte-for-byte parity, and no regressions in `knx-tables`.

- [ ] **Step 6: Run the full suite + lint/format**

Run: `make format lint test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/routes/knx-tables.ts tests/ets-capture-crosscheck.test.ts tests/knx-tables.test.ts tests/fixtures/relmem-1.1.13-image.hex
git commit -m "fix: do not write conditionally-inactive params into relmem image"
```

---

### Task 7: Resolve base + zero-guard in the program-device (download) route

**Files:**
- Modify: `server/routes/bus.ts` (`/bus/program-device`, ~lines 814–870)
- Test: `tests/bus-routes.test.ts` (add a case with a fake bus)

**Interfaces:**
- Consumes: `resolveRelmemBases` (Task 3); `planRelmemWrites`/`resolvedBases` path (Task 4).
- Produces: `/bus/program-device` resolves relmem bases before calling `downloadDevice`, aborts with `409 segment_unallocated` on a zero pointer, and passes `resolvedBases` in the `extra` argument.

- [ ] **Step 1: Write the failing test**

Add to `tests/bus-routes.test.ts` (follow the existing fake-bus pattern in that file; if `/bus/program-device` has no coverage yet, model it on the existing verify/route tests). The test asserts that when the fake bus's `readPropertyMany` returns `00000000`, the route responds `409` with `error: 'segment_unallocated'` and `downloadDevice` is never called:

```typescript
it('program-device aborts on an unallocated segment (zero PID 7)', async () => {
  let downloadCalled = false;
  const fakeBus = makeFakeBus({
    connected: true,
    readPropertyMany: async () => [Buffer.from('00000000', 'hex')],
    downloadDevice: async () => {
      downloadCalled = true;
    },
  });
  const res = await postProgramDevice(fakeBus, { deviceAddress: '1.1.13', deviceId: 15 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'segment_unallocated');
  assert.equal(downloadCalled, false);
});
```

(Adapt `makeFakeBus` / `postProgramDevice` to the harness helpers already used in `tests/bus-routes.test.ts`; if none exist, construct the route with `createTestServer()` from `tests/helpers.ts` and inject a bus stub the same way the existing bus-route tests do.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bus-routes.test.ts`
Expected: FAIL — route currently downloads regardless of the pointer.

- [ ] **Step 3: Implement**

In `/bus/program-device`, after `buildDeviceProgramming` and before `downloadDevice`, add:

```typescript
  // Resolve device-resident relmem bases (PID 7) and refuse to write to an
  // unallocated segment — a zero base would target near-zero addresses and
  // fail (the observed ETS first-attempt failure mode).
  const { bases, unallocated } = await resolveRelmemBases(
    b,
    deviceAddress,
    steps as Array<{ type: string; objIdx?: number }>,
  );
  if (unallocated.length) {
    return res.status(409).json({
      error: 'segment_unallocated',
      message: `Interface object(s) ${unallocated.join(', ')} report an unallocated segment (PID 7 = 0); refusing to write.`,
    });
  }
```

Then pass `resolvedBases` into the download call's `extra` argument:

```typescript
    await b.downloadDevice(
      deviceAddress,
      steps,
      gaTable,
      assocTable,
      paramMem,
      onProgress,
      { paramBase, absSegData, appId, resolvedBases: bases },
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bus-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + lint/format**

Run: `make format lint test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/routes/bus.ts tests/bus-routes.test.ts
git commit -m "feat: base resolution and zero-pointer guard in program-device route"
```

---

## Post-plan live validation (user-driven, not a code task)

After all tasks pass and `make format lint test` is green:

1. **Read-only:** reconnect the bus, run `verify-device` on 1.1.13 → expect a full byte match (family relmem, `totalDiffering: 0`) at the resolved base.
2. **Live write (on-site, ETS recovery available):** run `program-device` on 1.1.13; re-verify; if anything is wrong, reprogram with ETS.

## Self-review notes

- **Spec coverage:** base resolver (T1), verify base application (T2), live base resolution + zero-guard for verify (T3), pure download planner + base-aware executor (T4), capture-diff harness (T5), 2-byte image fix (T6), download-route guard (T7). All spec sections mapped.
- **Deferred per spec scope:** extended-memory services, System 7/absmem changes, the from-scratch reallocate-and-wait flow (`writenew.xml` retry semantics), and partial/mask-tracked downloads.
- **Type consistency:** `relBaseByObj` (planVerify) and `bases`/`resolvedBases` (`resolveRelmemBases`, `planRelmemWrites`, `DownloadExtra`) are all `Record<number, number>` keyed by interface-object index; `parseTableReference` returns `number | null`; `resolveRelmemBases` returns `{ bases, unallocated }`.
