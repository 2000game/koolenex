/**
 * In-memory registry for asynchronous .knxproj import jobs.
 *
 * The HTTP POST /projects/import handler returns immediately with an importId;
 * the actual parse + DB insert run later as a background task. The client
 * learns the outcome via WebSocket (`bus.broadcast`) or by polling
 * GET /projects/import/:importId/status (used for browser-refresh recovery).
 *
 * Lifecycle:
 *   parsing → password-required → parsing → done | failed
 *   parsing → done | failed
 *
 * Memory: at most one import is active at a time. The upload buffer is held
 * until the job reaches a terminal status, then dropped. Terminal jobs remain
 * queryable for TERMINAL_GRACE_MS so a late /status poll can see the result.
 * Idle jobs are evicted after TTL_MS.
 */

import crypto from 'crypto';
import { logger } from '../log.ts';
import { getBus } from './bus.ts';

export type ImportStatus = 'parsing' | 'password-required' | 'done' | 'failed';

export interface ImportSummary {
  devices: number;
  groupAddresses: number;
  comObjects: number;
  links: number;
}

export interface ImportJob {
  importId: string;
  mode: 'import' | 'reimport';
  reimportProjectId?: number;
  fileName: string;
  fileBuffer: Buffer | null;
  status: ImportStatus;
  password?: string;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  // result on done:
  projectId?: number;
  summary?: ImportSummary;
  // error on failed / password retry:
  error?: string;
  code?: string;
  passwordRetry?: boolean;
}

export interface ImportStatusSnapshot {
  importId: string;
  mode: 'import' | 'reimport';
  fileName: string;
  status: ImportStatus;
  projectId?: number;
  summary?: ImportSummary;
  error?: string;
  code?: string;
  passwordRetry?: boolean;
}

const TTL_MS = 10 * 60_000;
const TERMINAL_GRACE_MS = 30_000;

const _imports = new Map<string, ImportJob>();
let _activeImportId: string | null = null;

// ── Time source (overridable for tests) ─────────────────────────────────────
let _now = (): number => Date.now();
export function _setNowForTests(fn: () => number): void {
  _now = fn;
}
export function _resetNowForTests(): void {
  _now = (): number => Date.now();
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function getActiveImportId(): string | null {
  return _activeImportId;
}

export function getJob(id: string): ImportJob | null {
  return _imports.get(id) || null;
}

export function createJob(input: {
  mode: 'import' | 'reimport';
  reimportProjectId?: number;
  fileName: string;
  fileBuffer: Buffer;
  password?: string;
}): ImportJob {
  const importId = crypto.randomUUID();
  const now = _now();
  const job: ImportJob = {
    importId,
    mode: input.mode,
    reimportProjectId: input.reimportProjectId,
    fileName: input.fileName,
    fileBuffer: input.fileBuffer,
    status: 'parsing',
    password: input.password,
    createdAt: now,
    updatedAt: now,
  };
  _imports.set(importId, job);
  _activeImportId = importId;
  logger.info('import', 'job created', {
    importId,
    mode: job.mode,
    fileName: job.fileName,
    bytes: job.fileBuffer?.length ?? 0,
  });
  broadcast('import:started', {
    importId,
    mode: job.mode,
    fileName: job.fileName,
    projectId: job.reimportProjectId,
  });
  return job;
}

export function setStatus(
  importId: string,
  patch: Partial<
    Pick<ImportJob, 'status' | 'password' | 'passwordRetry' | 'error' | 'code'>
  >,
): void {
  const job = _imports.get(importId);
  if (!job) return;
  Object.assign(job, patch);
  job.updatedAt = _now();
  if (patch.status === 'password-required') {
    broadcast('import:password-required', {
      importId,
      retry: !!job.passwordRetry,
    });
  }
}

export function setTerminal(
  importId: string,
  patch: {
    status: 'done' | 'failed';
    projectId?: number;
    summary?: ImportSummary;
    error?: string;
    code?: string;
  },
): void {
  const job = _imports.get(importId);
  if (!job) return;
  job.status = patch.status;
  job.projectId = patch.projectId;
  job.summary = patch.summary;
  job.error = patch.error;
  job.code = patch.code;
  job.updatedAt = _now();
  job.terminalAt = _now();
  job.fileBuffer = null;
  job.password = undefined;
  if (_activeImportId === importId) _activeImportId = null;

  if (patch.status === 'done') {
    logger.info('import', 'job done', {
      importId,
      mode: job.mode,
      projectId: job.projectId,
      summary: job.summary,
    });
    broadcast('import:done', {
      importId,
      mode: job.mode,
      projectId: job.projectId,
      summary: job.summary,
    });
  } else {
    logger.info('import', 'job failed', {
      importId,
      error: job.error,
      code: job.code,
    });
    broadcast('import:failed', {
      importId,
      error: job.error,
      code: job.code,
    });
  }
}

export function snapshot(job: ImportJob): ImportStatusSnapshot {
  return {
    importId: job.importId,
    mode: job.mode,
    fileName: job.fileName,
    status: job.status,
    projectId: job.projectId,
    summary: job.summary,
    error: job.error,
    code: job.code,
    passwordRetry: job.passwordRetry,
  };
}

// ── Eviction ────────────────────────────────────────────────────────────────

export function evictExpired(): void {
  const now = _now();
  for (const [id, job] of _imports) {
    if (job.terminalAt != null) {
      if (now - job.terminalAt > TERMINAL_GRACE_MS) _imports.delete(id);
    } else {
      if (now - job.updatedAt > TTL_MS) {
        // Stale non-terminal job — drop the buffer and forget it.
        if (_activeImportId === id) _activeImportId = null;
        _imports.delete(id);
        logger.warn('import', 'job evicted (TTL)', { importId: id });
      }
    }
  }
}

let _sweeperHandle: NodeJS.Timeout | null = null;
export function startSweeper(intervalMs = 60_000): void {
  if (_sweeperHandle) return;
  _sweeperHandle = setInterval(evictExpired, intervalMs);
  _sweeperHandle.unref();
}
export function stopSweeper(): void {
  if (_sweeperHandle) {
    clearInterval(_sweeperHandle);
    _sweeperHandle = null;
  }
}

// ── Test helpers ────────────────────────────────────────────────────────────

export function _resetForTests(): void {
  _imports.clear();
  _activeImportId = null;
  stopSweeper();
}

// ── Internal ────────────────────────────────────────────────────────────────

function broadcast(type: string, payload: Record<string, unknown>): void {
  const bus = getBus();
  if (!bus) return;
  bus.broadcast(type, payload);
}
