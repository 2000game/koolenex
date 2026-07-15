/**
 * Tests for bus route endpoints (server/routes/bus.ts).
 * Uses createTestServer() with a mock KnxBusManager injected via setBus().
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'events';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, req, type TestServer } from './helpers.ts';
import { planVerify, type PlanStep } from '../server/knx-download-plan.ts';
import {
  buildGATable,
  buildAssocTable,
  buildParamMem,
  resolveParamSegment,
} from '../server/routes/knx-tables.ts';
import { APPS_DIR } from '../server/routes/shared.ts';

// ── Mock KnxBusManager ───────────────────────────────────────────────────────

class MockBus extends EventEmitter {
  connected = false;
  host: string | null = null;
  port: number | null = 3671;
  type: string | null = null;
  projectId: number | string | null = null;
  _wss: unknown = null;
  _remapFn: ((tg: any) => any) | null = null;
  _scanAbort = false;

  // Track calls for assertions
  calls: Array<{ method: string; args: unknown[] }> = [];

  setRemapper(fn: (tg: any) => any): void {
    this._remapFn = fn;
  }

  attachWSS(): void {}

  broadcast(): void {}

  connect(
    host: string,
    port: number,
    projectId?: number | string | null,
  ): Promise<{ host: string; port: number }> {
    this.calls.push({ method: 'connect', args: [host, port, projectId] });
    this.connected = true;
    this.host = host;
    this.port = port;
    this.type = 'udp';
    this.projectId = projectId ?? null;
    return Promise.resolve({ host, port });
  }

  connectUsb(
    devicePath: string,
    projectId?: number | string | null,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ method: 'connectUsb', args: [devicePath, projectId] });
    this.connected = true;
    this.type = 'usb';
    this.projectId = projectId ?? null;
    return Promise.resolve({ path: devicePath });
  }

  disconnect(): void {
    this.calls.push({ method: 'disconnect', args: [] });
    this.connected = false;
    this.host = null;
    this.type = null;
  }

  write(ga: string, value: unknown, dpt?: string): any {
    this.calls.push({ method: 'write', args: [ga, value, dpt] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { ok: true, ga, value, dpt };
  }

  async read(ga: string): Promise<{ ga: string; value: string }> {
    this.calls.push({ method: 'read', args: [ga] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { ga, value: '1' };
  }

  async ping(
    gaAddresses: string[],
    deviceAddress: string | null,
  ): Promise<{ reachable: boolean; ga: string | null }> {
    this.calls.push({ method: 'ping', args: [gaAddresses, deviceAddress] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { reachable: true, ga: gaAddresses[0] ?? null };
  }

  async identify(deviceAddress: string): Promise<void> {
    this.calls.push({ method: 'identify', args: [deviceAddress] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
  }

  async scan(
    area: number,
    line: number,
    timeoutMs: number,
    onProgress?: (p: any) => void,
  ): Promise<Array<{ address: string; descriptor: string }>> {
    this.calls.push({ method: 'scan', args: [area, line, timeoutMs] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return [];
  }

  abortScan(): void {
    this.calls.push({ method: 'abortScan', args: [] });
    this._scanAbort = true;
  }

  async readDeviceInfo(deviceAddr: string): Promise<any> {
    this.calls.push({ method: 'readDeviceInfo', args: [deviceAddr] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { descriptor: '07b0', address: deviceAddr };
  }

  async programIA(newAddr: string): Promise<{ ok: boolean; newAddr: string }> {
    this.calls.push({ method: 'programIA', args: [newAddr] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { ok: true, newAddr };
  }

  async downloadDevice(): Promise<void> {
    this.calls.push({ method: 'downloadDevice', args: [...arguments] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
  }

  // Optional canned device image: address -> byte. readMemory serves from it
  // (defaulting to 0xFF for unmapped bytes) so verify-device round-trips can be
  // driven to an exact match or mismatch. propImage does the same for props.
  memImage: Map<number, number> | null = null;
  propImage: Map<string, Buffer> | null = null;

  async readMemory(
    deviceAddr: string,
    address: number,
    length: number,
  ): Promise<Buffer> {
    this.calls.push({
      method: 'readMemory',
      args: [deviceAddr, address, length],
    });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    if (!this.memImage) return Buffer.alloc(length);
    const out = Buffer.alloc(length, 0xff);
    for (let i = 0; i < length; i++) {
      const b = this.memImage.get(address + i);
      if (b != null) out[i] = b;
    }
    return out;
  }

  async readProperty(
    deviceAddr: string,
    objIdx: number,
    propId: number,
  ): Promise<Buffer> {
    this.calls.push({
      method: 'readProperty',
      args: [deviceAddr, objIdx, propId],
    });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return this.propImage?.get(`${objIdx}/${propId}`) ?? Buffer.alloc(0);
  }

  listUsbDevices(): any[] {
    return [];
  }

  listAllHidDevices(): any[] {
    return [];
  }

  status(): any {
    return {
      connected: this.connected,
      type: this.type,
      host: this.host,
      port: this.port,
      hasLib: true,
    };
  }
}

// ── Test setup ──────────────────────────────────────────────────────────────

let ts: TestServer;
let mockBus: MockBus;

before(async () => {
  ts = await createTestServer();
  mockBus = new MockBus();
  // Inject mock bus via the router's setBus method
  const { router } = await import('../server/routes/index.ts');
  (router as any).setBus(mockBus);
});

after(() => ts.close());

beforeEach(() => {
  mockBus.calls = [];
  mockBus.connected = false;
  mockBus.host = null;
  mockBus.port = 3671;
  mockBus.type = null;
  mockBus.projectId = null;
});

// ── GET /bus/status ─────────────────────────────────────────────────────────

describe('GET /bus/status', () => {
  it('returns bus status', async () => {
    const r = await req(ts.baseUrl, 'GET', '/bus/status');
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.connected, false);
    assert.equal(data.hasLib, true);
  });

  it('reflects connected state', async () => {
    mockBus.connected = true;
    mockBus.host = '192.168.1.1';
    mockBus.type = 'udp';

    const r = await req(ts.baseUrl, 'GET', '/bus/status');
    const data = r.data as any;
    assert.equal(data.connected, true);
    assert.equal(data.host, '192.168.1.1');
    assert.equal(data.type, 'udp');
  });
});

// ── POST /bus/connect ───────────────────────────────────────────────────────

describe('POST /bus/connect', () => {
  it('connects with host and default port', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '192.168.1.1',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.ok, true);
    assert.equal(data.host, '192.168.1.1');
    assert.equal(data.port, 3671);

    assert.equal(mockBus.calls[0].method, 'connect');
    assert.equal(mockBus.calls[0].args[0], '192.168.1.1');
    assert.equal(mockBus.calls[0].args[1], 3671);
  });

  it('connects with custom port', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '10.0.0.1',
      port: 3672,
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.calls[0].args[1], 3672);
  });

  it('passes projectId', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '10.0.0.1',
      projectId: 42,
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.calls[0].args[2], 42);
  });

  it('saves host and port to settings', async () => {
    await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '10.0.0.5',
      port: 3675,
    });
    const host = ts.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key='knxip_host'",
    );
    const port = ts.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key='knxip_port'",
    );
    assert.equal(host!.value, '10.0.0.5');
    assert.equal(port!.value, '3675');
  });

  it('rejects missing host', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {});
    assert.equal(r.status, 400);
  });

  it('returns 502 on connection failure', async () => {
    const origConnect = mockBus.connect.bind(mockBus);
    mockBus.connect = () => Promise.reject(new Error('Connection refused'));
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '10.0.0.1',
    });
    assert.equal(r.status, 502);
    mockBus.connect = origConnect;
  });
});

// ── POST /bus/connect-usb ───────────────────────────────────────────────────

describe('POST /bus/connect-usb', () => {
  it('connects via USB', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect-usb', {
      devicePath: '/dev/hidraw0',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.ok, true);
    assert.equal(data.type, 'usb');
    assert.equal(mockBus.calls[0].method, 'connectUsb');
  });

  it('rejects missing devicePath', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect-usb', {});
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/disconnect ────────────────────────────────────────────────────

describe('POST /bus/disconnect', () => {
  it('disconnects', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/disconnect');
    assert.equal(r.status, 200);
    assert.equal((r.data as any).ok, true);
    assert.equal(mockBus.calls[0].method, 'disconnect');
  });
});

// ── POST /bus/project ───────────────────────────────────────────────────────

describe('POST /bus/project', () => {
  it('sets project ID on bus', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/project', {
      projectId: 42,
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.projectId, 42);
  });

  it('clears project ID with null', async () => {
    mockBus.projectId = 42;
    const r = await req(ts.baseUrl, 'POST', '/bus/project', {
      projectId: null,
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.projectId, null);
  });
});

// ── POST /bus/write ─────────────────────────────────────────────────────────

describe('POST /bus/write', () => {
  it('writes to GA', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/write', {
      ga: '1/0/0',
      value: true,
      dpt: '1',
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.calls[0].method, 'write');
    assert.equal(mockBus.calls[0].args[0], '1/0/0');
  });

  it('returns 502 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/write', {
      ga: '1/0/0',
      value: true,
    });
    assert.equal(r.status, 502);
  });

  it('rejects missing ga', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/write', { value: true });
    assert.equal(r.status, 400);
  });

  it('logs telegram to bus_telegrams when projectId provided', async () => {
    mockBus.connected = true;

    // Create a project first so projectId exists
    ts.db.run("INSERT INTO projects (name) VALUES ('Test')");
    const proj = ts.db.get<{ id: number }>(
      'SELECT id FROM projects ORDER BY id DESC LIMIT 1',
    );

    await req(ts.baseUrl, 'POST', '/bus/write', {
      ga: '1/0/0',
      value: 1,
      dpt: '1',
      projectId: proj!.id,
    });

    const tg = ts.db.get<{ dst: string; type: string }>(
      'SELECT dst, type FROM bus_telegrams WHERE project_id=? ORDER BY id DESC LIMIT 1',
      [proj!.id],
    );
    assert.ok(tg);
    assert.equal(tg.dst, '1/0/0');
    assert.equal(tg.type, 'GroupValue_Write');
  });
});

// ── POST /bus/read ──────────────────────────────────────────────────────────

describe('POST /bus/read', () => {
  it('reads from GA', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/read', { ga: '1/0/0' });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.ga, '1/0/0');
    assert.equal(data.value, '1');
    assert.equal(mockBus.calls[0].method, 'read');
  });

  it('returns 502 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/read', { ga: '1/0/0' });
    assert.equal(r.status, 502);
  });

  it('rejects missing ga', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/read', {});
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/ping ──────────────────────────────────────────────────────────

describe('POST /bus/ping', () => {
  it('pings with GA addresses', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/ping', {
      gaAddresses: ['1/0/0'],
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.reachable, true);
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/ping', {
      gaAddresses: ['1/0/0'],
    });
    assert.equal(r.status, 409);
  });
});

// ── POST /bus/identify ──────────────────────────────────────────────────────

describe('POST /bus/identify', () => {
  it('identifies device', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/identify', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 200);
    assert.equal((r.data as any).ok, true);
    assert.equal(mockBus.calls[0].method, 'identify');
    assert.equal(mockBus.calls[0].args[0], '1.1.1');
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/identify', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 409);
  });

  it('rejects missing deviceAddress', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/identify', {});
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/scan ──────────────────────────────────────────────────────────

describe('POST /bus/scan', () => {
  it('starts scan and returns immediately', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/scan', {
      area: 1,
      line: 1,
    });
    assert.equal(r.status, 200);
    assert.equal((r.data as any).ok, true);
    assert.equal(mockBus.calls[0].method, 'scan');
  });

  it('uses default area/line/timeout', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/scan', {});
    assert.equal(r.status, 200);
    // Defaults: area=1, line=1, timeout=200
    assert.deepEqual(mockBus.calls[0].args, [1, 1, 200]);
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/scan', {});
    assert.equal(r.status, 409);
  });
});

// ── POST /bus/scan/abort ────────────────────────────────────────────────────

describe('POST /bus/scan/abort', () => {
  it('aborts scan', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/scan/abort');
    assert.equal(r.status, 200);
    assert.equal((r.data as any).ok, true);
    assert.ok(mockBus.calls.some((c) => c.method === 'abortScan'));
  });
});

// ── POST /bus/device-info ───────────────────────────────────────────────────

describe('POST /bus/device-info', () => {
  it('reads device info', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/device-info', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.descriptor, '07b0');
    assert.equal(data.address, '1.1.1');
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/device-info', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 409);
  });
});

// ── POST /bus/program-ia ────────────────────────────────────────────────────

describe('POST /bus/program-ia', () => {
  it('programs individual address', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-ia', {
      newAddr: '1.1.5',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.ok, true);
    assert.equal(data.newAddr, '1.1.5');
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-ia', {
      newAddr: '1.1.5',
    });
    assert.equal(r.status, 409);
  });

  it('rejects missing newAddr', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/program-ia', {});
    assert.equal(r.status, 400);
  });
});

// ── GET /bus/usb-devices ────────────────────────────────────────────────────

describe('GET /bus/usb-devices', () => {
  it('returns device list', async () => {
    const r = await req(ts.baseUrl, 'GET', '/bus/usb-devices');
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.ok(Array.isArray(data.devices));
  });
});

describe('GET /bus/usb-devices/all', () => {
  it('returns all HID devices', async () => {
    const r = await req(ts.baseUrl, 'GET', '/bus/usb-devices/all');
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.ok(Array.isArray(data.devices));
  });
});

// ── POST /bus/program-device ────────────────────────────────────────────────

describe('POST /bus/program-device', () => {
  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 409);
  });

  it('returns 404 for non-existent device', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: '1.1.99',
      projectId: 999,
    });
    assert.equal(r.status, 404);
  });

  it('rejects missing deviceAddress', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {});
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/read-memory ───────────────────────────────────────────────────

describe('POST /bus/read-memory', () => {
  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/read-memory', {
      deviceAddress: '1.1.1',
      address: 0x100,
      length: 16,
    });
    assert.equal(r.status, 409);
  });

  it('reads memory and returns hex when connected', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/read-memory', {
      deviceAddress: '1.1.1',
      address: 0x100,
      length: 4,
    });
    assert.equal(r.status, 200);
    const data = r.data as { hex: string; length: number };
    assert.equal(data.length, 4);
    assert.equal(data.hex, '00000000');
    assert.ok(mockBus.calls.some((c) => c.method === 'readMemory'));
  });

  it('rejects an out-of-range address', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/read-memory', {
      deviceAddress: '1.1.1',
      address: 0x1_0000,
      length: 4,
    });
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/verify-device ─────────────────────────────────────────────────

describe('POST /bus/verify-device', () => {
  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 409);
  });

  it('returns 404 for non-existent device', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: '1.1.99',
      projectId: 999,
    });
    assert.equal(r.status, 404);
  });

  it('rejects missing deviceAddress', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {});
    assert.equal(r.status, 400);
  });
});

// ── verify-device across ALL device families (read-back byte-diff) ───────────
// Proves the generalized read-back path: an AbsSegment device and a
// property-configured device can both be validated purely by reading the
// device and diffing against the computed bytes — the "program by comparing,
// never writing" capability. Everything here is FICTIONAL: the two device
// application models below are invented for the test and written into the
// app-model directory during setup (removed on teardown); the mock bus serves
// a canned image. No real project, manufacturer product data, or hardware is
// involved.

// A fictional AbsSegment device: address table (LSM 1), association table
// (LSM 2), parameter segment (LSM 3) at 0x4400.
const ABS_APP = 'M-00FA_A-0001-01-ABCD';
const ABS_MODEL = {
  appId: ABS_APP,
  loadProcedures: [
    { type: 'Connect' },
    { type: 'Unload', lsmIdx: 1 },
    { type: 'Unload', lsmIdx: 2 },
    { type: 'Unload', lsmIdx: 3 },
    { type: 'Load', lsmIdx: 1 },
    { type: 'AbsSegment', lsmIdx: 1, address: 16384, size: 7 },
    { type: 'TaskSegment', lsmIdx: 1, address: 16384 },
    { type: 'LoadCompleted', lsmIdx: 1 },
    { type: 'Load', lsmIdx: 2 },
    { type: 'AbsSegment', lsmIdx: 2, address: 16896, size: 4 },
    { type: 'TaskSegment', lsmIdx: 2, address: 16896 },
    { type: 'LoadCompleted', lsmIdx: 2 },
    { type: 'Load', lsmIdx: 3 },
    { type: 'AbsSegment', lsmIdx: 3, address: 17408, size: 8 },
    { type: 'TaskSegment', lsmIdx: 3, address: 17408 },
    { type: 'LoadCompleted', lsmIdx: 3 },
    { type: 'Restart' },
    { type: 'Disconnect' },
  ],
  absSegData: { '17408': { size: 8, hex: '0000000000000000' } },
  paramMemLayout: {
    [`${ABS_APP}_P-1_R-1`]: {
      offset: 4,
      bitOffset: 0,
      bitSize: 8,
      defaultValue: '170',
      isText: false,
      isFloat: false,
      fromMemoryChild: false,
      isVisible: true,
    },
  },
  params: { [`${ABS_APP}_P-1_R-1`]: { defaultValue: '170' } },
  dynTree: { main: { items: [] } },
};

// A fictional property-configured device (no downloadable memory image): its
// load procedure is only identity CompareProps + a trigger WriteProp.
const PROP_APP = 'M-00FA_A-0002-01-EF01';
const PROP_MODEL = {
  appId: PROP_APP,
  loadProcedures: [
    { type: 'Connect' },
    { type: 'CompareProp', objIdx: 0, propId: 12, data: '00fa' },
    { type: 'CompareProp', objIdx: 0, propId: 78, data: '0000fa07000a' },
    { type: 'WriteProp', objIdx: 0, propId: 201, data: '' },
    { type: 'Disconnect' },
  ],
  paramMemLayout: {},
  params: {},
  dynTree: { main: { items: [] } },
};

const GA_LINKS = [
  { address: '0/0/1', main_g: 0, middle_g: 0, sub_g: 1 },
  { address: '0/0/2', main_g: 0, middle_g: 0, sub_g: 2 },
  { address: '2/1/2', main_g: 2, middle_g: 1, sub_g: 2 },
  { address: '2/1/3', main_g: 2, middle_g: 1, sub_g: 3 },
];
const CO_ROWS = [
  { object_number: 0, ga_address: '2/1/2' },
  { object_number: 12, ga_address: '2/1/3 2/1/2' },
  { object_number: 48, ga_address: '0/0/1 0/0/2' },
];

const writtenModels: string[] = [];
function writeModel(appRef: string, model: unknown): void {
  fs.mkdirSync(APPS_DIR, { recursive: true });
  const p = path.join(APPS_DIR, `${appRef}.json`);
  fs.writeFileSync(p, JSON.stringify(model));
  writtenModels.push(p);
}

// Seed a device + its GA/com-object rows; returns the device id.
function seedDevice(
  dbmod: typeof import('../server/db.ts'),
  projectId: number,
  addr: string,
  appRef: string,
  gaLinks: {
    address: string;
    main_g: number;
    middle_g: number;
    sub_g: number;
  }[],
  coRows: { object_number: number; ga_address: string }[],
): number {
  dbmod.run(
    `INSERT INTO devices (project_id, individual_address, name, app_ref, param_values) VALUES (?,?,?,?,?)`,
    [projectId, addr, `dev-${addr}`, appRef, '{}'],
  );
  const dev = dbmod.get<{ id: number }>(
    'SELECT id FROM devices WHERE project_id=? AND individual_address=?',
    [projectId, addr],
  )!;
  for (const g of gaLinks)
    dbmod.run(
      `INSERT OR IGNORE INTO group_addresses (project_id, address, name, main_g, middle_g, sub_g) VALUES (?,?,?,?,?,?)`,
      [projectId, g.address, g.address, g.main_g, g.middle_g, g.sub_g],
    );
  for (const c of coRows)
    dbmod.run(
      `INSERT INTO com_objects (project_id, device_id, object_number, ga_address) VALUES (?,?,?,?)`,
      [projectId, dev.id, c.object_number, c.ga_address],
    );
  return dev.id;
}

after(() => {
  for (const p of writtenModels) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
});

describe('POST /bus/verify-device — AbsSegment read-back diff', () => {
  let projectId: number;
  const deviceAddr = '1.1.30';

  before(() => {
    writeModel(ABS_APP, ABS_MODEL);
    ts.db.run(`INSERT INTO projects (name) VALUES ('verify-abs')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='verify-abs'`,
    )!.id;
    seedDevice(ts.db, projectId, deviceAddr, ABS_APP, GA_LINKS, CO_ROWS);
  });

  // Recompute the exact bytes verify-device will expect, so the mock bus can
  // serve a byte-perfect (or deliberately corrupted) image.
  function expectedMemMap(): Map<number, number> {
    const gaTable = buildGATable(GA_LINKS);
    const assocTable = buildAssocTable(CO_ROWS, GA_LINKS);
    const { paramSize, paramFill, relSegHex, paramBase } = resolveParamSegment(
      ABS_MODEL as never,
    );
    const paramMem =
      paramSize > 0
        ? buildParamMem(
            paramSize,
            ABS_MODEL.paramMemLayout as never,
            {},
            paramFill,
            relSegHex,
            ABS_MODEL.dynTree as never,
            ABS_MODEL.params as never,
          )
        : null;
    const plan = planVerify(
      ABS_MODEL.loadProcedures as PlanStep[],
      gaTable,
      assocTable,
      paramMem,
      paramBase,
      ABS_MODEL.absSegData as never,
      ABS_MODEL.appId,
    );
    assert.equal(plan.family, 'absmem');
    assert.ok(plan.mem.length > 0);
    const map = new Map<number, number>();
    for (const r of plan.mem)
      for (let i = 0; i < r.expected.length; i++)
        map.set(r.addr + i, r.expected[i]!);
    return map;
  }

  it('reports match=true when the device holds the exact computed bytes', async () => {
    mockBus.connected = true;
    mockBus.memImage = expectedMemMap();
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.memImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    assert.equal(body.family, 'absmem');
    assert.equal(body.match, true);
    assert.equal(body.totalDiffering, 0);
    assert.ok(body.segments.length > 0);
    assert.ok(mockBus.calls.some((c) => c.method === 'readMemory'));
  });

  it('reports match=false when a single config byte differs', async () => {
    mockBus.connected = true;
    const map = expectedMemMap();
    // Corrupt one byte inside the parameter segment (>= 0x4400).
    const target = [...map.keys()].find((a) => a >= 0x4400)!;
    map.set(target, (map.get(target)! ^ 0xff) & 0xff);
    mockBus.memImage = map;
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.memImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    assert.equal(body.match, false);
    assert.ok(body.totalDiffering >= 1);
  });
});

describe('POST /bus/verify-device — property-configured device', () => {
  let projectId: number;
  const deviceAddr = '1.0.0';

  before(() => {
    writeModel(PROP_APP, PROP_MODEL);
    ts.db.run(`INSERT INTO projects (name) VALUES ('verify-prop')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='verify-prop'`,
    )!.id;
    seedDevice(ts.db, projectId, deviceAddr, PROP_APP, [], []);
  });

  it('matches when identity properties read back as expected', async () => {
    mockBus.connected = true;
    // The app compares PID 12 (manufacturer) and PID 78 (hardware type).
    mockBus.propImage = new Map([
      ['0/12', Buffer.from('00fa', 'hex')],
      ['0/78', Buffer.from('0000fa07000a', 'hex')],
    ]);
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    assert.equal(body.family, 'prop');
    assert.equal(body.match, true);
    assert.ok(body.props.length >= 2);
    assert.ok(mockBus.calls.some((c) => c.method === 'readProperty'));
  });

  it('flags a mismatch when a property differs', async () => {
    mockBus.connected = true;
    mockBus.propImage = new Map([
      ['0/12', Buffer.from('9999', 'hex')], // wrong manufacturer
      ['0/78', Buffer.from('0000fa07000a', 'hex')],
    ]);
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    const body = r.data as any;
    assert.equal(body.match, false);
  });
});
