/**
 * KnxConnection — base class for KNX bus communication.
 * Contains all shared protocol logic (CEMI, APDU, management sessions, etc.)
 * Transport-specific subclasses (UDP, USB) implement sendCEMI() and connect/disconnect.
 */

import EventEmitter from 'events';
import { logger } from './log.ts';
import { decodeDptBuffer } from './knx-dpt.ts';
import {
  buildCEMI,
  TPCI,
  apduGroup,
  apduGroupRead,
  apduGroupWrite,
  apduConnected,
  apduControl,
  apduMemoryRead,
  parseMemoryResponse,
  apduMemoryExtendedRead,
  parseMemoryExtendedResponse,
  apduPropertyValueWrite,
  apduPropertyValueRead,
  encodePhysical,
  eventType,
  type CemiFrame,
} from './knx-cemi.ts';
import {
  planDownload,
  isAbsSegmentProcedure,
  type PlanStep,
  type AbsSegSeed,
} from './knx-download-plan.ts';

// Re-export from knx-dpt.ts
export { encodeDpt, decodeDptBuffer } from './knx-dpt.ts';

// Re-export from knx-cemi.ts
export {
  MC,
  APCI_EXT,
  buildCEMI,
  parseCEMI,
  encodePhysical,
  decodePhysical,
  encodeGroup,
  decodeGroup,
  apduGroup,
  apduConnected,
  apduConnectedFull,
  apduPropertyValueWrite,
  apduPropertyValueRead,
  apduControl,
  eventType,
} from './knx-cemi.ts';
export type { CemiFrame } from './knx-cemi.ts';
export {
  _apduGroupRead,
  _apduGroupWrite,
  _apduGroupResponse,
  _apduControl,
  _apduPropertyValueRead,
  _apduPropertyValueWrite,
  _TPCI,
  _APCI,
} from './knx-cemi.ts';

// ── Telegram type ──────────────────────────────────────────────────────────────

interface Telegram {
  timestamp: string;
  src: string;
  dst: string;
  type: string;
  raw_value: string;
  decoded: string;
  priority: string;
}

// ── Download step type ─────────────────────────────────────────────────────────

export interface DownloadStep {
  type: string;
  objIdx: number;
  propId: number;
  data?: Buffer;
  size?: number;
  offset?: number;
  // AbsoluteSegment (MDT-style) load-procedure fields — see knx-download-plan.ts
  lsmIdx?: number;
  address?: number;
}

export interface DownloadProgress {
  msg: string;
  pct?: number;
  done?: boolean;
}

/** Extra context needed to plan an AbsoluteSegment (MDT-style) download. */
export interface DownloadExtra {
  paramBase?: number | null;
  absSegData?: Record<number, AbsSegSeed>;
  appId?: string;
}

// ── Device info type ───────────────────────────────────────────────────────────

export interface DeviceInfo {
  descriptor: string;
  address: string;
  serialNumber?: string;
  manufacturerId?: number;
  programVersion?: {
    manufacturerId: number;
    deviceType: number;
    appVersion: number;
  };
  orderInfo?: string;
  hardwareType?: string;
  firmwareRevision?: number;
  error?: string;
}

// ── Scan progress type ─────────────────────────────────────────────────────────

export interface ScanProgress {
  address: string;
  reachable: boolean;
  descriptor: string | null;
  done: number;
  total: number;
}

// ── Management session helpers ──────────────────────────────────────────────────

interface ManagementSessionFns {
  sendData: (apciName: string, extraBuf?: Buffer | null) => Promise<void>;
  waitResponse: (apciNameExpected: string, ms?: number) => Promise<CemiFrame>;
  nextSeq: () => number;
}

// ── KnxConnection base class ───────────────────────────────────────────────────

export class KnxConnection extends EventEmitter {
  localAddr: string;
  connected: boolean;
  _scanAbort: boolean;

  constructor() {
    super();
    this.localAddr = '0.0.0'; // physical addr (assigned by gateway or USB device)
    this.connected = false;
    this._scanAbort = false;
  }

  /**
   * Send a CEMI frame over the transport. Must be implemented by subclasses.
   * @param {Buffer} cemi - raw CEMI frame
   * @returns {Promise<void>}
   */
  sendCEMI(_cemi: Buffer): Promise<void> {
    throw new Error('sendCEMI() must be implemented by transport subclass');
  }

  /** Disconnect from the bus. Must be implemented by transport subclass. */
  disconnect(): void {
    throw new Error('disconnect() must be implemented by transport subclass');
  }

  /** Called by transport subclass when a CEMI frame is received from the bus. */
  _onCEMI(cemi: CemiFrame): void {
    if (cemi.isGroup && cemi.apciName) {
      const raw = cemi.apduData.toString('hex');
      const decoded = decodeDptBuffer(cemi.apduData);
      const telegram: Telegram = {
        timestamp: new Date().toISOString(),
        src: cemi.src,
        dst: cemi.dst,
        type: eventType(cemi.apciName),
        raw_value: raw,
        decoded,
        priority: 'low',
      };
      this.emit('telegram', telegram);
    } else if (!cemi.isGroup) {
      this.emit('_mgmt', cemi);
    }
  }

  // ── Group communication ───────────────────────────────────────────────────────

  async write(
    ga: string,
    value: unknown,
    dpt: string | number = '1',
  ): Promise<{
    ok: boolean;
    ga: string;
    value: unknown;
    dpt: string | number;
  }> {
    if (!this.connected) throw new Error('Not connected');
    const apdu = apduGroupWrite(value, dpt);
    const cemi = buildCEMI(this.localAddr, ga, apdu, true);
    await this.sendCEMI(cemi);
    return { ok: true, ga, value, dpt };
  }

  // Note: no request correlation ID — concurrent reads to the same GA could
  // consume each other's responses. KNX has no request/response correlation
  // at the group level, so this is a protocol-level limitation, not a bug.
  read(
    ga: string,
    timeoutMs: number = 4000,
  ): Promise<{ ga: string; value: string }> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const onTelegram = (tg: Telegram): void => {
        if (tg.dst === ga && tg.type === 'GroupValue_Response') {
          clearTimeout(timer);
          this.off('telegram', onTelegram);
          resolve({ ga, value: tg.decoded });
        }
      };
      const timer = setTimeout(() => {
        this.off('telegram', onTelegram);
        reject(new Error('Read timeout'));
      }, timeoutMs);
      this.on('telegram', onTelegram);
      const cemi = buildCEMI(this.localAddr, ga, apduGroupRead(), true);
      this.sendCEMI(cemi).catch((err: Error) => {
        clearTimeout(timer);
        this.off('telegram', onTelegram);
        reject(err);
      });
    });
  }

  // ── Management session ────────────────────────────────────────────────────────

  async managementSession(
    deviceAddr: string,
    fn: (fns: ManagementSessionFns) => Promise<void>,
    timeoutMs: number = 5000,
  ): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    let seq = 0;

    const sendControl = async (
      tpciCode: number,
      s: number = 0,
    ): Promise<void> => {
      const apdu = apduControl(tpciCode, s);
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
      await this.sendCEMI(cemi);
    };

    const sendData = async (
      apciName: string,
      extraBuf: Buffer | null = null,
    ): Promise<void> => {
      const apdu = apduConnected(seq, apciName, extraBuf);
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
      await this.sendCEMI(cemi);
    };

    const waitResponse = (
      apciNameExpected: string,
      ms: number = timeoutMs,
    ): Promise<CemiFrame> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.off('_mgmt', handler);
          reject(
            new Error(`Management timeout waiting for ${apciNameExpected}`),
          );
        }, ms);
        const handler = (cemi: CemiFrame): void => {
          if (cemi.src === deviceAddr && cemi.apciName === apciNameExpected) {
            clearTimeout(timer);
            this.off('_mgmt', handler);
            resolve(cemi);
          }
        };
        this.on('_mgmt', handler);
      });

    // Connection-oriented transport requires us to T_Ack every numbered data
    // frame the device sends (its responses), before issuing the next request —
    // otherwise the peer desyncs and stops responding after the first exchange.
    // (Confirmed against ETS's own bus trace, which acks each device response.)
    const ackHandler = (cemi: CemiFrame): void => {
      if (cemi.src !== deviceAddr || cemi.tpciType !== 'DATA_CONNECTED') return;
      const rxSeq = (cemi.apdu[0]! >> 2) & 0xf;
      // Fire-and-forget the T_Ack, but swallow a failed send (e.g. a KNXnet/IP
      // ACK timeout on a flaky link) so it never becomes an unhandled promise
      // rejection that crashes the process. The awaiting read/verify surfaces
      // the failure through its own waitResponse timeout.
      sendControl(TPCI.ACK, rxSeq).catch(() => {});
    };
    this.on('_mgmt', ackHandler);

    await sendControl(TPCI.CONNECT);
    await delay(100);

    try {
      await fn({ sendData, waitResponse, nextSeq: () => seq++ });
    } finally {
      this.off('_mgmt', ackHandler);
      try {
        await sendControl(TPCI.DISCONNECT);
      } catch (_) {}
    }
  }

  // ── Ping ──────────────────────────────────────────────────────────────────────

  ping(
    gaAddresses: string[],
    deviceAddr: string,
    timeoutMs: number = 2000,
  ): Promise<{ reachable: boolean; ga: string | null }> {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve) => {
      let done = false;
      const finish = (reachable: boolean, ga: string | null = null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('telegram', onTelegram);
        this.off('_mgmt', onMgmt);
        resolve({ reachable, ga });
      };

      const timer = setTimeout(() => finish(false), timeoutMs);

      const gaSet = new Set(gaAddresses);
      const onTelegram = (tg: Telegram): void => {
        if ((deviceAddr && tg.src === deviceAddr) || gaSet.has(tg.dst))
          finish(true, tg.dst);
      };
      this.on('telegram', onTelegram);

      const onMgmt = (cemi: CemiFrame): void => {
        if (
          cemi.src === deviceAddr &&
          cemi.apciName === 'DeviceDescriptor_Response'
        )
          finish(true, deviceAddr);
      };
      this.on('_mgmt', onMgmt);

      this.managementSession(
        deviceAddr,
        async ({ sendData, waitResponse }) => {
          await sendData('DeviceDescriptor_Read', null);
          await waitResponse('DeviceDescriptor_Response', timeoutMs - 200);
          finish(true, deviceAddr);
        },
        timeoutMs,
      ).catch(() => {});
    });
  }

  // ── Individual address programming ────────────────────────────────────────────

  async programIA(
    newAddr: string,
    _timeoutMs: number = 5000,
  ): Promise<{ ok: boolean; newAddr: string }> {
    if (!this.connected) throw new Error('Not connected');
    const addrBuf = encodePhysical(newAddr);
    const apdu = apduGroup('PhysicalAddress_Write', 0, addrBuf);
    const cemi = buildCEMI(this.localAddr, '0.0.0', apdu, false);
    await this.sendCEMI(cemi);
    return { ok: true, newAddr };
  }

  // ── Application download ──────────────────────────────────────────────────────

  /**
   * Read `length` bytes of device memory starting at `address`, over the bus.
   * Non-destructive: issues A_Memory_Read requests only. Used by the read-first
   * validation flow to compare a device's actual memory against a computed image.
   */
  async readMemory(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize: number = 12,
  ): Promise<Buffer> {
    if (!this.connected) throw new Error('Not connected');
    let out: Buffer = Buffer.alloc(length);
    await this.managementSession(deviceAddr, async (fns) => {
      out = await this.readRegionInSession(
        fns,
        deviceAddr,
        address,
        length,
        chunkSize,
      );
    });
    return out;
  }

  /**
   * Read several memory regions of one device inside a SINGLE management
   * session (one Connect/Disconnect for the whole batch), rather than opening
   * a fresh connection-oriented session per region. Mirrors how a real
   * download drives all of a device's transfers over one session. Returns one
   * Buffer per requested region, in order.
   */
  async readMemoryMany(
    deviceAddr: string,
    regions: Array<{ address: number; length: number }>,
    chunkSize: number = 12,
  ): Promise<Buffer[]> {
    if (!this.connected) throw new Error('Not connected');
    const results: Buffer[] = [];
    await this.managementSession(deviceAddr, async (fns) => {
      for (const r of regions)
        results.push(
          await this.readRegionInSession(
            fns,
            deviceAddr,
            r.address,
            r.length,
            chunkSize,
          ),
        );
    });
    return results;
  }

  /**
   * Read one memory region using an already-open management session. The
   * device echoes the requested address in every A_Memory_Response; we reject
   * any response whose address does not match the chunk we asked for, so a
   * stale or reordered response can never be copied into the wrong offset of
   * the read-back buffer.
   */
  private async readRegionInSession(
    fns: ManagementSessionFns,
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize: number,
  ): Promise<Buffer> {
    const { waitResponse, nextSeq } = fns;
    const out = Buffer.alloc(length);
    for (let off = 0; off < length; off += chunkSize) {
      const n = Math.min(chunkSize, length - off);
      const seq = nextSeq();
      const wantAddr = (address + off) & 0xffff;
      const apdu = apduMemoryRead(seq, n, wantAddr);
      const respP = waitResponse('Memory_Response', 3000);
      await this.sendCEMI(buildCEMI(this.localAddr, deviceAddr, apdu, false));
      const frame = await respP;
      const { address: gotAddr, data } = parseMemoryResponse(frame);
      if (gotAddr !== wantAddr)
        throw new Error(
          `Memory_Response address mismatch: requested 0x${wantAddr.toString(
            16,
          )}, device answered 0x${gotAddr.toString(16)}`,
        );
      data.copy(out, off);
    }
    return out;
  }

  /**
   * Read a single interface-object property value (A_PropertyValue_Read).
   * Non-destructive. Returns the property VALUE bytes only — the 4-byte
   * response header (objIdx, propId, count, startIndex) is stripped. Used by
   * read-back verification of property-configured devices (e.g. KNX IP
   * routers) that carry no downloadable parameter-memory image.
   */
  async readProperty(
    deviceAddr: string,
    objIdx: number,
    propId: number,
  ): Promise<Buffer> {
    const [value] = await this.readPropertyMany(deviceAddr, [
      { objIdx, propId },
    ]);
    return value ?? Buffer.alloc(0);
  }

  /**
   * Read several interface-object property values of one device inside a
   * SINGLE management session. Returns one VALUE buffer per read (the 4-byte
   * response header stripped), in order.
   */
  async readPropertyMany(
    deviceAddr: string,
    reads: Array<{ objIdx: number; propId: number }>,
  ): Promise<Buffer[]> {
    if (!this.connected) throw new Error('Not connected');
    const values: Buffer[] = [];
    await this.managementSession(
      deviceAddr,
      async ({ waitResponse, nextSeq }) => {
        for (const { objIdx, propId } of reads) {
          const seq = nextSeq();
          const apdu = apduPropertyValueRead(seq, objIdx, propId);
          const respP = waitResponse('OTHER', 3000);
          await this.sendCEMI(
            buildCEMI(this.localAddr, deviceAddr, apdu, false),
          );
          const res = await respP;
          const data = res?.apduData;
          if (!data)
            throw new Error(
              `No PropertyValue_Response for obj=${objIdx} pid=${propId}`,
            );
          values.push(
            data.length > 4 ? Buffer.from(data.subarray(4)) : Buffer.alloc(0),
          );
        }
      },
    );
    return values;
  }

  /**
   * Read device memory using the extended memory services (A_MemoryExtended_Read,
   * 0x1FD) — required by System B / System 7 devices, which do not answer the
   * legacy A_Memory_Read. Non-destructive. 24-bit address space.
   */
  async readMemoryExtended(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize: number = 11,
  ): Promise<Buffer> {
    if (!this.connected) throw new Error('Not connected');
    const out = Buffer.alloc(length);
    await this.managementSession(
      deviceAddr,
      async ({ waitResponse, nextSeq }) => {
        for (let off = 0; off < length; off += chunkSize) {
          const n = Math.min(chunkSize, length - off);
          const seq = nextSeq();
          const apdu = apduMemoryExtendedRead(seq, n, address + off);
          const respP = waitResponse('MemoryExtended_Read_Response', 3000);
          await this.sendCEMI(
            buildCEMI(this.localAddr, deviceAddr, apdu, false),
          );
          const frame = await respP;
          const { returnCode, data } = parseMemoryExtendedResponse(frame);
          if (returnCode !== 0)
            throw new Error(
              `MemoryExtended read error rc=${returnCode} at 0x${(address + off).toString(16)}`,
            );
          data.copy(out, off);
        }
      },
    );
    return out;
  }

  async downloadDevice(
    deviceAddr: string,
    steps: DownloadStep[],
    gaTable: Buffer | null,
    assocTable: Buffer | null,
    paramMem: Buffer | null,
    onProgress?: (progress: DownloadProgress) => void,
    extra?: DownloadExtra,
  ): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    const log = (msg: string): void => {
      if (onProgress) onProgress({ msg });
    };

    // AbsoluteSegment (MDT-style) load procedures — Connect/Unload/Load/
    // AbsSegment/TaskSegment/LoadCompleted/Restart/Disconnect — are planned
    // by the pure planDownload() function (see knx-download-plan.ts) and
    // this executor just replays the resulting ops as CEMI frames. Legacy
    // RelSegment/WriteRelMem/LoadImageProp (ABB-style) devices keep using
    // the inline loop below unchanged.
    if (isAbsSegmentProcedure(steps)) {
      await this.managementSession(deviceAddr, async ({ nextSeq }) => {
        const MEM_CHUNK = 44;

        const ops = planDownload(
          steps as PlanStep[],
          gaTable,
          assocTable,
          paramMem,
          extra?.paramBase ?? null,
          extra?.absSegData ?? {},
          extra?.appId ?? '',
        );

        for (const op of ops) {
          switch (op.kind) {
            case 'connect':
            case 'disconnect': {
              // The connection-oriented session is already opened/closed by
              // managementSession() around this whole download; nothing to
              // send here.
              log(op.kind === 'connect' ? 'Connect' : 'Disconnect');
              break;
            }
            case 'propWrite': {
              log(`PropWrite ObjIdx=${op.obj} PropId=${op.pid}`);
              const seq = nextSeq();
              const apdu = apduPropertyValueWrite(seq, op.obj, op.pid, op.data);
              const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
              await this.sendCEMI(cemi);
              await delay(50);
              break;
            }
            case 'memWrite': {
              log(
                `MemWrite Addr=0x${op.addr.toString(16)} Len=${op.bytes.length}`,
              );
              for (let off = 0; off < op.bytes.length; off += MEM_CHUNK) {
                const chunk = op.bytes.subarray(off, off + MEM_CHUNK);
                const addr = op.addr + off;
                const seq = nextSeq();
                const chunkExtra = Buffer.concat([
                  Buffer.from([chunk.length, (addr >> 8) & 0xff, addr & 0xff]),
                  chunk,
                ]);
                const apdu = apduConnected(seq, 'Memory_Write', chunkExtra);
                const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
                await this.sendCEMI(cemi);
                await delay(30);
              }
              break;
            }
            case 'restart': {
              log('Restart');
              const seq = nextSeq();
              const apdu = apduConnected(seq, 'Restart');
              const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
              await this.sendCEMI(cemi);
              break;
            }
          }
        }

        log('Download complete');
        if (onProgress)
          onProgress({ msg: 'Download complete', pct: 100, done: true });
      });
      return;
    }

    await this.managementSession(deviceAddr, async ({ nextSeq }) => {
      const MEM_CHUNK = 10;

      const propWrite = async (
        objIdx: number,
        propId: number,
        data: Buffer,
      ): Promise<void> => {
        const seq = nextSeq();
        const apdu = apduPropertyValueWrite(seq, objIdx, propId, data);
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
        await this.sendCEMI(cemi);
        await delay(50);
      };

      for (const step of steps) {
        switch (step.type) {
          case 'WriteProp': {
            log(`WriteProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            if (step.data && step.data.length) {
              await propWrite(step.objIdx, step.propId, step.data);
            }
            break;
          }
          case 'CompareProp': {
            log(`CompareProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            break;
          }
          case 'WriteRelMem': {
            log(`WriteRelMem ObjIdx=${step.objIdx} Size=${step.size}`);
            if (!paramMem) throw new Error('Parameter memory not available');
            const mem = paramMem.slice(0, step.size);
            for (let off = 0; off < mem.length; off += MEM_CHUNK) {
              const chunk = mem.slice(off, off + MEM_CHUNK);
              const seq = nextSeq();
              const extra2 = Buffer.concat([
                Buffer.from([
                  chunk.length,
                  ((step.offset! + off) >> 8) & 0xff,
                  (step.offset! + off) & 0xff,
                ]),
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
          case 'LoadImageProp': {
            log(`LoadImageProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            const imgData =
              step.objIdx === 1 && gaTable
                ? gaTable
                : step.objIdx === 2 && assocTable
                  ? assocTable
                  : Buffer.from([0x04]);
            await propWrite(step.objIdx, step.propId, imgData);
            break;
          }
        }
      }

      log('Download complete');
      if (onProgress)
        onProgress({ msg: 'Download complete', pct: 100, done: true });
    });
  }

  // ── Identify ──────────────────────────────────────────────────────────────────

  async identify(deviceAddr: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    const memWrite = (seq: number, addr: number, dataByte: number): Buffer => {
      const extra = Buffer.from([
        0x01,
        (addr >> 8) & 0xff,
        addr & 0xff,
        dataByte,
      ]);
      return apduConnected(seq, 'Memory_Write', extra);
    };

    await this.managementSession(deviceAddr, async ({ nextSeq }) => {
      const seq0 = nextSeq();
      const on = buildCEMI(
        this.localAddr,
        deviceAddr,
        memWrite(seq0, 0x0060, 0x01),
        false,
      );
      await this.sendCEMI(on);
      await delay(3000);
      const seq1 = nextSeq();
      const off = buildCEMI(
        this.localAddr,
        deviceAddr,
        memWrite(seq1, 0x0060, 0x00),
        false,
      );
      await this.sendCEMI(off);
    });
  }

  // ── Device info ───────────────────────────────────────────────────────────────

  async readDeviceInfo(deviceAddr: string): Promise<DeviceInfo> {
    if (!this.connected) throw new Error('Not connected');

    const probe = await this._probeSingle(deviceAddr, 2000);
    if (!probe) throw new Error(`Device ${deviceAddr} did not respond`);

    const info: DeviceInfo = {
      descriptor: probe.descriptor,
      address: deviceAddr,
    };

    try {
      await this.managementSession(
        deviceAddr,
        async ({ waitResponse, nextSeq }) => {
          const propRead = async (
            objIdx: number,
            propId: number,
          ): Promise<Buffer | null> => {
            const seq = nextSeq();
            const apdu = apduPropertyValueRead(seq, objIdx, propId);
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
            await this.sendCEMI(cemi);
            const res = await waitResponse('OTHER', 2000);
            return res?.apduData || null;
          };

          const tryProp = async (
            propId: number,
            label: string,
            handler: (data: Buffer) => void,
          ): Promise<void> => {
            try {
              const data = await propRead(0, propId);
              if (data) handler(data);
            } catch (e) {
              logger.warn(
                'knx',
                `${deviceAddr} prop ${label} (${propId}) read failed`,
                {
                  error: (e as Error).message,
                },
              );
            }
          };

          await tryProp(11, 'serialNumber', (data) => {
            if (data.length >= 10)
              info.serialNumber = data.slice(4).toString('hex');
          });
          await tryProp(12, 'manufacturerId', (data) => {
            if (data.length >= 6) info.manufacturerId = data.readUInt16BE(4);
          });
          await tryProp(13, 'programVersion', (data) => {
            if (data.length >= 9) {
              const pv = data.slice(4);
              info.programVersion = {
                manufacturerId: pv.readUInt16BE(0),
                deviceType: pv.readUInt16BE(2),
                appVersion: pv[4]!,
              };
            }
          });
          await tryProp(15, 'orderInfo', (data) => {
            if (data.length > 4) {
              const raw = data.slice(4);
              const nullIdx = raw.indexOf(0);
              const text = (nullIdx >= 0 ? raw.slice(0, nullIdx) : raw)
                .toString('ascii')
                .trim();
              info.orderInfo = text || raw.toString('hex');
            }
          });
          await tryProp(78, 'hardwareType', (data) => {
            if (data.length >= 10)
              info.hardwareType = data.slice(4).toString('hex');
          });
          await tryProp(9, 'firmwareRevision', (data) => {
            if (data.length >= 5) info.firmwareRevision = data[4];
          });
        },
      );
    } catch (e) {
      info.error = (e as Error).message;
    }

    return info;
  }

  // ── Bus scan ──────────────────────────────────────────────────────────────────

  _probeSingle(
    deviceAddr: string,
    timeoutMs: number,
  ): Promise<{ descriptor: string } | null> {
    if (!this.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: { descriptor: string } | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('_mgmt', onMgmt);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const onMgmt = (cemi: CemiFrame): void => {
        if (
          cemi.src === deviceAddr &&
          cemi.apciName === 'DeviceDescriptor_Response'
        )
          finish({ descriptor: cemi.apduData?.toString('hex') || '' });
      };
      this.on('_mgmt', onMgmt);
      const apdu = apduGroup('DeviceDescriptor_Read');
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
      this.sendCEMI(cemi).catch(() => {});
    });
  }

  scan(
    area: number,
    line: number,
    timeoutMs: number,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<Array<{ address: string; descriptor: string }>> {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    this._scanAbort = false;
    return (async () => {
      const found: Array<{ address: string; descriptor: string }> = [];
      for (let dev = 0; dev <= 255; dev++) {
        if (this._scanAbort) break;
        const addr = `${area}.${line}.${dev}`;
        const result = await this._probeSingle(addr, timeoutMs);
        if (result)
          found.push({ address: addr, descriptor: result.descriptor });
        if (onProgress)
          onProgress({
            address: addr,
            reachable: !!result,
            descriptor: result?.descriptor || null,
            done: dev + 1,
            total: 256,
          });
      }
      return found;
    })();
  }

  abortScan(): void {
    this._scanAbort = true;
  }

  status(): { connected: boolean; hasLib: boolean } {
    return { connected: this.connected, hasLib: true };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
