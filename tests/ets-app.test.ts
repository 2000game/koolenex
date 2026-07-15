/**
 * Tests for server/ets-app.ts's buildAppIndex()/buildParamModel() — in
 * particular the Union <Memory BitOffset> propagation bug (fix #3, patch 3).
 *
 * A <Union> element's bit position within its byte comes from the Union's
 * OWN <Memory BitOffset> child (its child Parameters conventionally carry
 * BitOffset="0"). Before the fix, addParam() only read the Union Memory's
 * Offset (byte position) and ignored its BitOffset, so a sub-byte Union
 * field landed in the wrong nibble — e.g. the MDT UP-2124/2125/2126
 * "BehaviourAtLocking_*" fields (real product XML:
 * `<Union SizeInBit="4"><Memory Offset="29" BitOffset="4"/>
 *  <Parameter … Offset="0" BitOffset="0"/></Union>`) were written to the
 * HIGH nibble (bitOffset 0) instead of the LOW nibble (bitOffset 4),
 * producing 0x20 where ETS wrote 0x22.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAppIndex } from '../server/ets-app.ts';

// Minimal synthetic ETS6 application-program XML exercising exactly the
// Union/Memory/Parameter path addParam() walks — no .knxproj, no DB.
const UNION_APP_XML = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-1">
          <Static>
            <ParameterTypes>
              <ParameterType Id="PT-1">
                <TypeNumber SizeInBit="4" />
              </ParameterType>
            </ParameterTypes>
            <Parameters>
              <Union SizeInBit="4">
                <Memory Offset="29" BitOffset="4" />
                <Parameter Id="P-1" ParameterType="PT-1" Value="2" Text="Union field" Offset="0" BitOffset="0" />
              </Union>
            </Parameters>
            <ParameterRefs>
              <ParameterRef Id="PR-1" RefId="P-1" />
            </ParameterRefs>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;

describe('ets-app.ts: Union <Memory BitOffset> propagation', () => {
  it('folds the Union Memory BitOffset into the child param bitOffset', () => {
    const idx = buildAppIndex(Buffer.from(UNION_APP_XML, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const model = idx!.buildParamModel();
    const entry = model.paramMemLayout['PR-1'];
    assert(entry, 'PR-1 should be present in paramMemLayout');
    assert.equal(
      entry.offset,
      29,
      'byte offset should come from the Union Memory Offset',
    );
    // Pre-fix this was 0 (only the child Parameter's own BitOffset="0" was
    // used) — writeBits(29, bitOff=0, size=4, 2) sets the HIGH nibble (0x20).
    // Post-fix it must be 4 (the Union Memory's BitOffset), which sets the
    // LOW nibble — matching ETS.
    assert.equal(entry.bitOffset, 4);
    assert.equal(entry.bitSize, 4);
  });

  it('does not affect standalone (non-Union) params: no baseBitOffset applied', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-2">
          <Static>
            <ParameterTypes>
              <ParameterType Id="PT-2">
                <TypeNumber SizeInBit="8" />
              </ParameterType>
            </ParameterTypes>
            <Parameters>
              <Parameter Id="P-2" ParameterType="PT-2" Value="5" Text="Plain param">
                <Memory Offset="10" BitOffset="0" />
              </Parameter>
            </Parameters>
            <ParameterRefs>
              <ParameterRef Id="PR-2" RefId="P-2" />
            </ParameterRefs>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const model = idx!.buildParamModel();
    const entry = model.paramMemLayout['PR-2'];
    assert(entry, 'PR-2 should be present in paramMemLayout');
    assert.equal(entry.offset, 10);
    assert.equal(entry.bitOffset, 0);
  });
});
