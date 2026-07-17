# Follow-up: Golden-image catalog (ETS layer-3 divergence)

> Status: open · opened 2026-07-17 · GitHub issues are disabled on the fork, tracked here.

## Problem

koolenex computes a device's download image from the ETS application program + project parameter values + the declarative dynamic structure (`choose`/`when`). But ETS also runs **manufacturer functional logic** at download time that is only partly declarative in the XML. We cannot fully see or replay that layer, so a from-scratch computation can diverge from what ETS actually writes.

### Case study (System B relmem, ABB 6108/07, device 1.1.13)

After fixing the segment-base resolution (PID 7), live `verify-device` matches **353/355** bytes. The only 2 diffs are at segment offsets `0x7b/0x7c` (device addr `0x27b/0x27c`):

- These are the RGB **status-lighting colour thresholds** — `33%`/`66%` = bytes `84`/`168` (koolenex catalog defaults).
- ETS writes `0` there because the LED is in **Orientierungsbeleuchtung** mode, where the thresholds are meaningless.
- The suppression is **not** expressed in the parameter dynamic structure: the threshold `ParameterRefRef R-973` is gated only by `P-617=0` (LED-Funktion) and `P-619=1` (status object = 1-byte %), both true. It sits **outside** both `P-618` (Betriebsart) `choose` blocks. ETS applies the Betriebsart suppression in its functional/module layer, which koolenex has no access to.

So koolenex's parameter-level evaluation is *correct*; the divergence is ETS layer-3 logic. Reverse-engineering it per manufacturer is not tractable.

## Proposed direction: golden-image catalog

Store the **resolved** programming result instead of recomputing it. Two sources, both reusing the base-resolution + memory read/write we just built:

- **A. Read-back clone (strongest):** read a device's full resolved memory over the bus (works now, at the resolved PID-7 base) and store it as the golden image per app+config (or per device). Replay to program/restore an identical device. ETS's layer-3 resolution comes for free because it's already baked into the bytes.
- **B. Capture replay:** parse an ETS download capture (`writes2.xml`) into a recipe (address→bytes, property writes, load sequence), store, replay byte-exact.

Compute-from-catalog stays for editing/what-if; golden images are the authoritative ground truth for exact replay **and** validation (the ETS capture-diff harness already does the validation half).

## Scope to explore

- [ ] Schema for a per-app / per-device golden-image + load-sequence store (private repo or DB table); versioning.
- [ ] Read-back capture flow: full-segment read (all interface objects via PID 7) → normalized image.
- [ ] Replay path reusing `downloadDevice` + `resolvedBases` + the zero-pointer guard.
- [ ] Decide identity key (app id + config hash vs. per physical device).
- [ ] Extend the capture-diff harness to golden images as the validation oracle.
- [ ] Revisit the 2-byte `0x27b` divergence: confirm it is inert (device in Orientierung mode) and document as a known layer-3 case, or model the Betriebsart suppression if a general rule emerges from more captures.

## References

- Spec: `docs/superpowers/specs/2026-07-17-system-b-relmem-programming-design.md`
- Plan: `docs/superpowers/plans/2026-07-17-system-b-relmem-programming.md`
- Harness + capture parser: `server/ets-capture.ts`, `tests/ets-capture-crosscheck.test.ts`
- Base resolution: `server/knx-segment-base.ts`
