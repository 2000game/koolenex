# System B relmem programming — design

**Date:** 2026-07-17
**Status:** Design (pending review)
**Scope:** Make koolenex correctly verify and download to System B (mask `0x07B0`)
relmem devices over the live bus, validated against a captured ETS download.

## Background

koolenex can build correct download artifacts for all 65 owned devices
(`coverage-report.ts` proves our built byte image matches ETS's expected image
— "theoretical programmability"). It had never read from or written to a real
device until 2026-07-17, on-site at the church.

The first live `verify-device` on **1.1.13** (ABB Busch-Jaeger 6108/07 push-button
coupling unit) read back **all zeros** (255/355 "matching" bytes were only the
positions where our own image is also `0x00`). Investigation with two ETS
download captures (`writes2.xml`, `writenew.xml`) established the true root cause
— which is **not** what the earlier `koolenex-systemb-blocker` note assumed.

## Root cause (evidence-based)

**It is a dropped segment base address, not an extended-memory gap.**

- ETS programs these System B devices with ordinary **`A_Memory_Write`** at
  16-bit addresses `0x0103`–`0x060a`. No extended-memory service is used.
- The data ETS writes is byte-identical to koolenex's built image.
- Our relmem path uses the `WriteRelMem` step's **relative `offset` (0) as if it
  were the absolute address**, so it reads/writes at base `0x0000`:
  - `planVerify` relmem branch: `knx-download-plan.ts:388` (`addr: offset`).
  - `downloadDevice` `WriteRelMem` branch: `knx-connection.ts` (`(step.offset! + off)`).
- The true absolute base is **device-resident** and defined by the mask, not the
  `.knxproj`. Mask `MV-07B0` declares the app-data segment as
  `AddressSpace="RelativeMemory"` with its base held in an interface-object
  pointer property. The `.knxproj` `RelativeSegment` has `Offset="0"` and **no
  address attribute**.

**Empirical confirmation:** reading 1.1.13's memory at the corrected base
`0x0200` returned **353/355 bytes matching** our built image (vs 255/355 all-zero
at `0x0000`).

## How ETS resolves the base — PID 7 (`PID_TABLE_REFERENCE`)

Both captures show ETS reading **Interface Object `<objIdx>`, Property 7** to get
each segment's absolute base, then writing the segment there. Confirmed pointer
values on our devices:

| Interface object | PID 7 pointer | Segment |
|---|---|---|
| obj 4 | `0x0200` | app parameter data (LSM 4, 355 bytes — our `WriteRelMem objIdx=4`) |
| obj 5 | `0x0100` | PEI/LSM 3 segment (96 bytes) |
| obj 1 | `0x0500` | group address table |
| obj 2 | `0x0600` | association table |
| obj 3 | `0x0400` | group object table |

The `objIdx` we need is **already present** in each `WriteRelMem` / `RelSegment`
/ `LoadImageProp` step, so no new mapping is required — we read PID 7 of that
object.

## The failure mode and the mandatory safety guard

`writenew.xml` captured a **failed** ETS download to 1.1.12 followed by a
successful retry:

- **Failed attempt:** after unload/reallocate, `PropRead obj=5 pid=7` returned
  **`0x00000000`** (allocation not settled). ETS then wrote memory at
  **`0x0003`** (= base `0` + offset 3) and the session aborted with a
  `T_Disconnect`.
- **Retry:** identical sequence, but `PropRead obj=5 pid=7` → `0x0100` and
  `obj=4 pid=7` → `0x0200`; the writes then landed correctly.

**Design rule (hard gate): never issue a memory write if the resolved PID 7
pointer is `0x00000000`.** A zero pointer means the segment is not allocated;
writing then targets near-zero addresses and fails (this is exactly ETS's own
first-attempt failure). This guard applies to both verify and download.

1.1.13 is already allocated (obj 4 PID 7 = `0x0200`), so a partial re-download is
the low-risk first target.

## Design

Units are small and independently testable. Each states what it does, how it is
used, and what it depends on.

### 1. `resolveSegmentBase(bus, deviceAddr, objIdx)` — base resolver

- **Does:** reads PID 7 (`PID_TABLE_REFERENCE`) of interface object `objIdx` over
  the bus; parses the 4-byte pointer; returns the absolute base address, or a
  distinct `unallocated` result when the pointer is `0x00000000`.
- **Used by:** verify and download, once per relmem segment before touching
  memory.
- **Depends on:** `connection.readProperty(deviceAddr, objIdx, 7)` (already
  exists on `knx-connection.ts`).

### 2. Apply base in `planVerify` (relmem branch)

- Change `addr: offset` → `addr: base + offset`, where `base` is resolved per
  segment's `objIdx`. Because `planVerify` is a pure function, it takes resolved
  bases as an input (a `Map<objIdx, base>` or per-region `base`), keeping bus I/O
  out of the planner. The route (`/bus/verify-device`) resolves bases first, then
  calls `planVerify`.
- Also resolve and apply bases for the GA/assoc/group-object tables (obj 1/2/3)
  where they are read back.

### 3. Apply base in `downloadDevice` (WriteRelMem + tables)

- Resolve base per segment; write at `base + step.offset`.
- **Enforce the zero-pointer guard:** if any required base resolves to
  `unallocated`, abort the download with a clear error before writing anything.
- Match ETS's observed sequence: PID 7 resolution → LoadStateMachine
  (Unload/Load/allocate via PID 5) → sparse chunked `A_Memory_Write` →
  `LoadImageProp` → LoadCompleted. Fidelity is judged by the capture-diff harness
  (unit 5), not by guesswork.

### 4. Fix the 2-byte image-builder discrepancy

Independent of the base issue: our built image has `54a8` at segment offset
`0x7b`–`0x7c` (device addr `0x27b`) where both ETS and the device hold `0x0000`.
Trace this in the param-memory builder (`buildParamMem` / `paramMemLayout`) and
correct it so our image is byte-identical to ETS. Tracked as a small separate fix
with its own test.

### 5. Capture-diff validation harness (test tool, not shipped)

- **Does:** parses an ETS `.xml` communication log (`writes2.xml`,
  `writenew.xml`) into a canonical op list (memory writes with absolute
  addresses, property writes, load-state events), then byte-diffs koolenex's
  generated download op stream against it.
- **Why:** this is the safety gate. It proves the download logic is correct
  **against real ETS ground truth without writing to any device**. Only after a
  clean (or explained) diff do we attempt a live write.
- **Depends on:** the same `buildDeviceProgramming` artifacts the route uses.

## Data flow (download)

```
route /bus/program-device
  └─ buildDeviceProgramming(dev)        → steps, paramMem, gaTable, …
  └─ for each relmem segment objIdx:
        base = resolveSegmentBase(bus, addr, objIdx)   ← read PID 7
        if base == unallocated → ABORT (zero guard)
  └─ downloadDevice(..., resolvedBases)  → LSM sequence + writes at base+offset
```

## Testing strategy

1. **Unit:** `resolveSegmentBase` parses pointer bytes; returns `unallocated` on
   `0x00000000`. Table-driven from the captured PID 7 responses.
2. **Unit:** `planVerify` relmem now emits `base + offset` regions (fixture with a
   known base).
3. **Harness (unit 5):** koolenex's generated op stream for 1.1.13 byte-matches
   `writes2.xml` (allowing benign chunk-boundary differences, documented).
4. **Image builder:** regression test asserting no `54a8`-style discrepancy at
   `0x27b`.
5. **Live, read-only:** `verify-device` on 1.1.13 at the resolved base → expect
   full byte-match. Run before any write.
6. **Live write (on-site, with ETS recovery net):** `program-device` to 1.1.13;
   re-verify; ETS can reprogram if anything is wrong.

## Scope

**In scope:** System B (`0x07B0`) relmem devices — the 10 reachable owned devices
(all ABB push-button / RTR units); 1.1.13 as the first live target. PID 7 base
resolution, the zero-pointer guard, the capture-diff harness, and the 2-byte
image fix.

**Out of scope (this spec):**
- Extended-memory services (`A_MemoryExtended_*`) — not needed for these devices.
- System 7 (absmem) and property-only devices — separate paths, already partly
  working; not touched here beyond shared base-resolution where relevant.
- Full from-scratch unload/reallocate downloads where PID 7 initially returns
  zero (the `writenew.xml` failure path). We target already-allocated devices
  first; the general reallocate-and-wait flow is a follow-up.
- Partial/mask-tracked (changed-bytes-only) downloads.

## Open questions

- Exact benign differences between our op stream and ETS's chunking (chunk
  boundaries, ordering of table vs. param writes) — resolved empirically via the
  harness; document any intentional deviations.
- Whether to retry-on-zero-pointer (reconnect and re-read, as ETS does) or simply
  abort with guidance — start with **abort + clear error**; add retry later if
  needed.
