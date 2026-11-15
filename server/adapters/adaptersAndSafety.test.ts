import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runDiscreteEventSimulation } from './simulator';
import { parseLogsAndAggregate } from './logParser';
import { validateTargetUrlSsrf } from './ssrfGuard';
import { checkProbeAuthorization, hashVerificationToken } from './ownership';
import {
  clampProbeLimits,
  isPathDisallowedByRobots,
  resetProbeLocksForTest,
  runAuthorizedLowRateProbe,
} from './probe';
import { fitRobustMM1 } from '../math/fitting';
import { SAFETY_LIMITS } from '../core/safetyLimits';
import { computeAuditHash, GENESIS_AUDIT_HASH, verifyAuditChain, type AuditEntryRecord } from '../core/audit';
import { UmbralDatabase } from '../db/database';
import { executeExperimentPipeline } from '../services/experiments';

test('Discrete-event simulator converges to theoretical M/M/1 latency W = 1/(mu - lambda) for rho < 0.9', () => {
  const mu = 50;
  const lambda = 30; // rho = 0.6, theoretical W = 1/20 = 0.050 s
  const sim = runDiscreteEventSimulation({
    scenario: 'STEADY',
    mu,
    c: 1,
    K: null,
    timeoutS: 5,
    cv: 1,
    lambdaStart: lambda,
    lambdaPeak: lambda,
    durationS: 120,
    windowS: 10,
    seed: 12345,
  });

  const theoreticalW = 1 / (mu - lambda);
  const relErr = Math.abs(sim.overallMeanLatency - theoreticalW) / theoreticalW;
  assert.equal(sim.provenance, 'SIMULATED');
  assert.ok(relErr < 0.12, `Simulated W=${sim.overallMeanLatency} too far from ${theoreticalW} (relErr=${relErr})`);
});

test('Log parser handles valid, truncated, and corrupt lines and recovers known mu within <5%', () => {
  // Build deterministic synthetic CSV + corrupt lines simulating mu = 80 req/s
  const trueMu = 80;
  const lines: string[] = ['timestamp,latency_s,status'];
  const baseTs = 1700000000;
  const rates = [15, 25, 40, 55, 65];
  for (let w = 0; w < rates.length; w++) {
    const lam = rates[w];
    const windowStart = baseTs + w * 10;
    const count = lam * 10;
    for (let i = 0; i < count; i++) {
      const ts = (windowStart + (i / count) * 9.9).toFixed(3);
      const lat = (1 / (trueMu - lam)).toFixed(6);
      lines.push(`${ts},${lat},200`);
    }
  }
  // Add truncated and corrupt lines
  lines.push('corrupt-line-no-commas');
  lines.push('not-a-date,0.05,200');
  lines.push(`${baseTs + 60},-0.2,200`);

  const parsed = parseLogsAndAggregate(lines.join('\n'), 5);
  assert.equal(parsed.invalidLines, 3);
  assert.ok(parsed.validLines === (15 + 25 + 40 + 55 + 65) * 10);

  const fit = fitRobustMM1(parsed.windows);
  const relErr = Math.abs(fit.muEstimated - trueMu) / trueMu;
  assert.ok(relErr < 0.05, `Recovered mu=${fit.muEstimated} vs trueMu=${trueMu} (err=${relErr})`);

  // Also check Nginx Combined format
  const nginxSample = [
    '10.0.0.1 - - [12/Nov/2026:15:00:01 +0000] "GET /api/items HTTP/1.1" 200 512 "-" "curl/8.0" rt=0.025',
    '10.0.0.1 - - [12/Nov/2026:15:00:02 +0000] "GET /api/items HTTP/1.1" 200 512 "-" "curl/8.0" rt=0.030',
    'truncated nginx line [bad',
  ].join('\n');
  const nginxParsed = parseLogsAndAggregate(nginxSample, 5);
  assert.equal(nginxParsed.formatDetected, 'NGINX_COMBINED');
  assert.equal(nginxParsed.validLines, 2);
  assert.equal(nginxParsed.invalidLines, 1);
});

test('SSRF guard blocks cloud metadata, private IPs (when disallowed), DNS rebinding, and cross-host redirects', async () => {
  // Cloud metadata always blocked even if private allowed
  const metaRes = await validateTargetUrlSsrf('http://169.254.169.254/latest/meta-data', {
    allowPrivateOrLoopback: true,
  });
  assert.equal(metaRes.allowed, false);

  // Domain resolving to cloud metadata via DNS rebinding
  const dnsMeta = await validateTargetUrlSsrf('https://rebind.example.com/test', {
    allowPrivateOrLoopback: true,
    resolver: async () => [{ address: '169.254.169.254', family: 4 }],
  });
  assert.equal(dnsMeta.allowed, false);

  // Domain resolving to private IP when allowPrivateOrLoopback=false
  const privBlocked = await validateTargetUrlSsrf('https://internal.example.com/', {
    allowPrivateOrLoopback: false,
    resolver: async () => [{ address: '10.0.0.5', family: 4 }],
  });
  assert.equal(privBlocked.allowed, false);

  // Cross-host redirect blocked
  const crossHost = await validateTargetUrlSsrf('https://evil.example.org/p', {
    expectedHost: 'authorized.example.com',
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(crossHost.allowed, false);
});

test('Security constraints: probe rejects missing/expired authorization, exceeding hard limits, and aborts on 429/503 or 3x p95', async () => {
  resetProbeLocksForTest();

  // Hard constants verification
  assert.equal(SAFETY_LIMITS.MAX_PROBE_RPS, 5);
  assert.equal(SAFETY_LIMITS.MAX_PROBE_DURATION_S, 60);
  assert.equal(SAFETY_LIMITS.MAX_PROBE_CONCURRENCY, 2);

  // Cannot exceed 5 req/s, 60s, concurrency 2, or use POST
  assert.ok(clampProbeLimits({ requestedRps: 6, requestedDurationS: 10, requestedConcurrency: 1, method: 'GET' }).rejectedReason);
  assert.ok(clampProbeLimits({ requestedRps: 2, requestedDurationS: 61, requestedConcurrency: 1, method: 'GET' }).rejectedReason);
  assert.ok(clampProbeLimits({ requestedRps: 2, requestedDurationS: 10, requestedConcurrency: 3, method: 'GET' }).rejectedReason);
  assert.ok(clampProbeLimits({ requestedRps: 2, requestedDurationS: 10, requestedConcurrency: 1, method: 'POST' }).rejectedReason);

  // Missing explicit checkbox
  const noCheckbox = await checkProbeAuthorization({
    targetUrl: 'http://127.0.0.1:3000/mock-target',
    explicitCheckboxChecked: false,
    authorization: {
      id: 'a1',
      targetId: 't1',
      method: 'PRIVATE_AUTH_ONLY',
      tokenHash: 'abc',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      declaredBy: 'admin',
      evidenceNote: 'local',
    },
  });
  assert.equal(noCheckbox.authorized, false);

  // Expired authorization
  const expired = await checkProbeAuthorization({
    targetUrl: 'http://127.0.0.1:3000/mock-target',
    explicitCheckboxChecked: true,
    authorization: {
      id: 'a1',
      targetId: 't1',
      method: 'PRIVATE_AUTH_ONLY',
      tokenHash: 'abc',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
      declaredBy: 'admin',
      evidenceNote: 'expired',
    },
  });
  assert.equal(expired.authorized, false);

  // Public site without ownership verification rejected
  const unverifiedPublic = await checkProbeAuthorization({
    targetUrl: 'https://example.com/health',
    explicitCheckboxChecked: true,
    authorization: {
      id: 'a2',
      targetId: 't2',
      method: 'WELL_KNOWN',
      tokenHash: hashVerificationToken('tok'),
      verifiedAt: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      declaredBy: 'admin',
      evidenceNote: 'pending',
    },
  });
  assert.equal(unverifiedPublic.authorized, false);

  // robots.txt enforcement
  assert.equal(isPathDisallowedByRobots('User-agent: *\nDisallow: /admin\n', '/admin/stats'), true);
  assert.equal(isPathDisallowedByRobots('User-agent: *\nDisallow: /admin\n', '/health'), false);

  // Auto-abort on HTTP 429
  const abort429 = await runAuthorizedLowRateProbe(
    {
      targetId: 't-429',
      targetUrl: 'http://127.0.0.1:3000/mock-target',
      method: 'GET',
      requestedRps: 2,
      requestedDurationS: 6,
      requestedConcurrency: 1,
      explicitCheckboxChecked: true,
      authorization: {
        id: 'a1',
        targetId: 't-429',
        method: 'PRIVATE_AUTH_ONLY',
        tokenHash: 'abc',
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        declaredBy: 'tester',
        evidenceNote: 'test',
      },
    },
    {
      bypassTimingDelayForTest: true,
      fetchImpl: async (url) => {
        if (url.endsWith('/robots.txt')) {
          return { status: 404, headers: { get: () => null }, text: async () => '' };
        }
        return { status: 429, headers: { get: () => null }, text: async () => 'Too Many Requests' };
      },
    },
  );
  assert.equal(abort429.aborted, true);
  assert.ok(abort429.abortReason?.includes('429'));
});

test('Real HTTP webpage probe calibrates mu from measured response time and converges Newton & Secant', async () => {
  resetProbeLocksForTest();

  // Levantar servidor HTTP real en puerto efímero de loopback con latencia controlada ~35 ms
  const srv = http.createServer(async (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    await new Promise((r) => setTimeout(r, 35));
    res.writeHead(200, {
      'Content-Type': 'text/html',
      Server: 'UmbralTestWeb/1.0',
      'X-Cache': 'HIT',
    });
    res.end('<html><body>OK</body></html>');
  });

  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address() as { port: number };
  const targetUrl = `http://127.0.0.1:${addr.port}/`;

  try {
    const db = new UmbralDatabase(':memory:');
    const targetId = 'web-real-test';
    const nowIso = new Date().toISOString();
    const expIso = new Date(Date.now() + 3600_000).toISOString();

    db.db
      .prepare('INSERT INTO targets (id, name, base_url, environment, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(targetId, 'Sitio HTTP Real Prueba', targetUrl, 'LABORATORIO', 'u1', nowIso);
    db.db
      .prepare(
        `INSERT INTO infrastructure_profiles (id, target_id, c, K, timeout_s, mu_declared, mu_source, service_cv, slo_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('p-real', targetId, 1, 100, 0.05, 100, 'DECLARED', 1.0, 50, nowIso);
    db.db
      .prepare(
        `INSERT INTO authorizations (id, target_id, method, token_hash, raw_token_preview, verified_at, expires_at, declared_by, evidence_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('a-real', targetId, 'PRIVATE_AUTH_ONLY', 'h', null, nowIso, expIso, 'tester', 'test', nowIso);

    const out = await executeExperimentPipeline(db, {
      targetId,
      sourceKind: 'PROBE',
      model: 'MM1',
      objective: { type: 'MEAN_LATENCY', targetLatencyS: 0.05 },
      autoTargetLatency: true,
      probeMethod: 'GET',
      probeRps: 4,
      probeDurationS: 4,
      probeConcurrency: 1,
      explicitAuthorizationChecked: true,
    });

    assert.ok(out.probeMeta);
    assert.ok(out.probeCalibration);
    assert.ok(out.probeCalibration.s0Ms >= 25, `Expected measured S0 >= 25ms, got ${out.probeCalibration.s0Ms}`);
    assert.ok(
      out.probeCalibration.muCalibrated < 50,
      `Expected calibrated mu < 50 req/s (from ~35ms), got ${out.probeCalibration.muCalibrated}`,
    );
    assert.equal(out.probeCalibration.httpSignals.serverHeader, 'UmbralTestWeb/1.0');
    assert.equal(out.probeCalibration.httpSignals.cacheDetected, true);
    assert.equal(out.probeCalibration.autoAdjustedT, true);

    const newton = out.detail.solverRuns.find((r) => r.method === 'NEWTON');
    const secant = out.detail.solverRuns.find((r) => r.method === 'SECANT');
    assert.equal(newton?.converged, true);
    assert.equal(secant?.converged, true);
    assert.ok(out.detail.prediction?.lambdaStar && out.detail.prediction.lambdaStar > 0);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('Audit log hash chain integrity detects tampering', () => {
  const e1Base = {
    id: 'e1',
    ts: '2026-11-12T10:00:00.000Z',
    actor: 'admin@local',
    action: 'TARGET_CREATED',
    targetId: 't1',
    detailJson: '{"name":"Mock"}',
    prevHash: GENESIS_AUDIT_HASH,
  };
  const e1: AuditEntryRecord = { ...e1Base, hash: computeAuditHash(e1Base) };

  const e2Base = {
    id: 'e2',
    ts: '2026-11-12T10:01:00.000Z',
    actor: 'admin@local',
    action: 'PROBE_STARTED',
    targetId: 't1',
    detailJson: '{"rps":2}',
    prevHash: e1.hash,
  };
  const e2: AuditEntryRecord = { ...e2Base, hash: computeAuditHash(e2Base) };

  assert.equal(verifyAuditChain([e1, e2]).valid, true);

  // Tamper with e1 detailJson
  const tampered: AuditEntryRecord = { ...e1, detailJson: '{"name":"Hacked"}' };
  const check = verifyAuditChain([tampered, e2]);
  assert.equal(check.valid, false);
  assert.equal(check.brokenAtIndex, 0);
});
