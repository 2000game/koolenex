/**
 * Tests for the async import job model:
 *   - Concurrent imports return 409 IMPORT_BUSY
 *   - GET /status returns 404 for unknown importId
 *   - Password retry flow reuses the held buffer (no second upload)
 *   - TTL eviction drops stale jobs
 *   - Terminal grace keeps results queryable for ~30 s, then 404s
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { type AddressInfo } from 'net';

const SMOKE_PROJECT = path.join(import.meta.dirname, 'smoke-test.knxproj');
const SMOKE_PROJECT_PW = path.join(
  import.meta.dirname,
  'password-protected-smoke-test.knxproj',
);

if (!fs.existsSync(SMOKE_PROJECT) || !fs.existsSync(SMOKE_PROJECT_PW)) {
  describe('import-async', () => {
    it('skipped — smoke fixtures not found', () => {});
  });
  process.exit(0);
}

const importJobs = await import('../server/routes/import-jobs.ts');

let server: any, baseUrl: string, db: any;

async function req(
  method: string,
  urlPath: string,
  body?: any,
  isFormData = false,
) {
  const url = baseUrl + urlPath;
  const headers: Record<string, string> = {};
  const opts: RequestInit = { method, headers };
  if (body && !isFormData) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function pollUntil(
  importId: string,
  predicate: (snap: any) => boolean,
  maxMs = 30_000,
) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { status, data } = await req(
      'GET',
      `/projects/import/${importId}/status`,
    );
    if (status === 200 && predicate(data)) return data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pollUntil timeout for ${importId}`);
}

before(async () => {
  db = await import('../server/db.ts');
  await db.init({ inMemory: true });
  const { router: routes } = await import('../server/routes/index.ts');
  const { ValidationError } = await import('../server/validate.ts');
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.errors.join('; ') });
        return;
      }
      res.status(500).json({ error: err.message || 'Internal server error' });
    },
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/api`;
      resolve();
    });
  });
});

after(() => {
  importJobs._resetForTests();
  server?.close();
});

describe('async import: status endpoint', () => {
  it('GET /projects/import/:importId/status returns 404 for unknown id', async () => {
    const { status } = await req(
      'GET',
      '/projects/import/nope-not-a-real-id/status',
    );
    assert.equal(status, 404);
  });

  it('terminal job remains queryable for the grace window', async () => {
    const buf = fs.readFileSync(SMOKE_PROJECT);
    const form = new FormData();
    form.append('file', new Blob([buf]), 'smoke-test.knxproj');
    const { data: kickoff } = await req('POST', '/projects/import', form, true);
    assert(kickoff.importId);
    const snap = await pollUntil(
      kickoff.importId,
      (s) => s.status === 'done' || s.status === 'failed',
    );
    assert.equal(snap.status, 'done');
    // Cleanup
    if (snap.projectId) await req('DELETE', `/projects/${snap.projectId}`);
  });
});

describe('async import: concurrency', () => {
  it('refuses a second import while one is still parsing', async () => {
    importJobs._resetForTests();
    const buf = fs.readFileSync(SMOKE_PROJECT);

    // Create an active job manually (skips parse) so we can probe the 409
    // path deterministically without racing the parser.
    importJobs.createJob({
      mode: 'import',
      fileName: 'fake.knxproj',
      fileBuffer: Buffer.from(buf),
    });
    assert(importJobs.getActiveImportId());

    const form2 = new FormData();
    form2.append('file', new Blob([buf]), 'second.knxproj');
    const { status, data } = await req('POST', '/projects/import', form2, true);
    assert.equal(status, 409);
    assert.equal(data.code, 'IMPORT_BUSY');
    assert(data.activeImportId);

    importJobs._resetForTests();
  });
});

describe('async import: password flow', () => {
  it('password-protected import requires password, then resumes via /password', async () => {
    importJobs._resetForTests();
    const buf = fs.readFileSync(SMOKE_PROJECT_PW);
    const form = new FormData();
    form.append('file', new Blob([buf]), 'pw.knxproj');
    const { status, data: kickoff } = await req(
      'POST',
      '/projects/import',
      form,
      true,
    );
    assert.equal(status, 200);
    assert(kickoff.importId);

    // Poll until the parser detects encryption and asks for password.
    const pwSnap = await pollUntil(
      kickoff.importId,
      (s) => s.status === 'password-required',
    );
    assert.equal(pwSnap.status, 'password-required');

    // Wrong password — should bounce back to password-required with retry.
    const wrong = await req(
      'POST',
      `/projects/import/${kickoff.importId}/password`,
      { password: 'wrongpassword' },
    );
    assert.equal(wrong.status, 200);
    const retrySnap = await pollUntil(
      kickoff.importId,
      (s) => s.status === 'password-required' && s.passwordRetry === true,
    );
    assert.equal(retrySnap.passwordRetry, true);

    // Correct password — matches the password-protected smoke fixture.
    const ok = await req(
      'POST',
      `/projects/import/${kickoff.importId}/password`,
      { password: 'k00l3n3x!' },
    );
    assert.equal(ok.status, 200);
    const done = await pollUntil(
      kickoff.importId,
      (s) => s.status === 'done' || s.status === 'failed',
    );
    assert.equal(
      done.status,
      'done',
      `expected done, got ${JSON.stringify(done)}`,
    );
    assert.equal(done.summary.devices, 6);

    // Cleanup
    if (done.projectId) await req('DELETE', `/projects/${done.projectId}`);
  });

  it('POST /password on an unknown import returns 404', async () => {
    const { status } = await req(
      'POST',
      '/projects/import/no-such-id/password',
      { password: 'whatever' },
    );
    assert.equal(status, 404);
  });

  it('POST /password on a job that is not awaiting password returns 409', async () => {
    importJobs._resetForTests();
    const buf = fs.readFileSync(SMOKE_PROJECT);
    // Create a job in 'parsing' state and immediately try to submit a password.
    const job = importJobs.createJob({
      mode: 'import',
      fileName: 'smoke.knxproj',
      fileBuffer: Buffer.from(buf),
    });
    const { status } = await req(
      'POST',
      `/projects/import/${job.importId}/password`,
      { password: 'irrelevant' },
    );
    assert.equal(status, 409);
    importJobs._resetForTests();
  });
});

describe('async import: TTL eviction', () => {
  it('evictExpired drops stale non-terminal jobs', () => {
    importJobs._resetForTests();
    let now = 1_000_000;
    importJobs._setNowForTests(() => now);
    const buf = Buffer.from('placeholder');
    const job = importJobs.createJob({
      mode: 'import',
      fileName: 'stale.knxproj',
      fileBuffer: buf,
    });
    assert(importJobs.getJob(job.importId));
    // Advance 11 minutes
    now += 11 * 60_000;
    importJobs.evictExpired();
    assert.equal(importJobs.getJob(job.importId), null);
    assert.equal(importJobs.getActiveImportId(), null);
    importJobs._resetNowForTests();
    importJobs._resetForTests();
  });

  it('terminal jobs are evicted after the grace window', () => {
    importJobs._resetForTests();
    let now = 2_000_000;
    importJobs._setNowForTests(() => now);
    const job = importJobs.createJob({
      mode: 'import',
      fileName: 'done.knxproj',
      fileBuffer: Buffer.from('placeholder'),
    });
    importJobs.setTerminal(job.importId, {
      status: 'failed',
      error: 'test',
      code: 'PARSE_FAILED',
    });
    // Within the grace window (30 s) the job is still queryable.
    now += 10_000;
    importJobs.evictExpired();
    assert(importJobs.getJob(job.importId));
    // Past the grace window the job is gone.
    now += 30_000;
    importJobs.evictExpired();
    assert.equal(importJobs.getJob(job.importId), null);
    importJobs._resetNowForTests();
    importJobs._resetForTests();
  });
});
