import 'dotenv/config';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { SAFETY_LIMITS } from './server/core/safetyLimits';
import { verifyAuditChain } from './server/core/audit';
import { UmbralDatabase } from './server/db/database';
import {
  generateVerificationToken,
  verifyOwnershipRemote,
  type VerificationMethod,
} from './server/adapters/ownership';
import { getProbeCooldownRemainingS } from './server/adapters/probe';
import { fetchPrometheusRange } from './server/adapters/prometheus';
import { validateTargetUrlSsrf } from './server/adapters/ssrfGuard';
import {
  computeBasinOfConvergence,
  computeToleranceSensitivity,
  solveThresholdComparison,
} from './server/math/solvers';
import { getQueueModel } from './server/math/queues';
import type { ObjectiveConfig, QueueModelType, QueueParams } from './server/math/types';
import { executeExperimentPipeline } from './server/services/experiments';
import {
  generateCsvReport,
  generatePdfReportBuffer,
  getExperimentDetail,
} from './server/services/reports';

const PORT = 3000;
const app = express();
app.use(express.json({ limit: '10mb' }));

const db = new UmbralDatabase();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastWs(event: string, payload: unknown): void {
  const msg = JSON.stringify({ event, payload, ts: new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// Estado seguro del servidor Mock integrado (loopback)
let mockServiceLatencyMs = 12;
let mockVerifyToken = 'umbral-verify=mock-local';

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /mock-target\nDisallow: /admin\n');
});

app.get('/.well-known/umbral-verify.txt', (_req, res) => {
  res.type('text/plain').send(mockVerifyToken);
});

app.get('/mock-target', async (req, res) => {
  const requestedDelay = Number(req.query.delay_ms ?? mockServiceLatencyMs);
  const safeDelay = Math.max(1, Math.min(200, Number.isFinite(requestedDelay) ? requestedDelay : mockServiceLatencyMs));
  // Pequeña fluctuación exponencial realista alrededor del tiempo medio configurado
  const jitter = -safeDelay * Math.log(Math.max(0.05, Math.random())) * 0.4 + safeDelay * 0.6;
  await new Promise((resolve) => setTimeout(resolve, Math.min(250, jitter)));
  res.json({
    service: 'mock-target',
    status: 'ok',
    meanServiceMs: safeDelay,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/mock-target/config', (req, res) => {
  const ms = Number(req.body?.meanServiceMs ?? 12);
  mockServiceLatencyMs = Math.max(2, Math.min(150, Number.isFinite(ms) ? ms : 12));
  res.json({ meanServiceMs: mockServiceLatencyMs });
});

// Límites duros de seguridad (solo lectura)
app.get('/api/safety-limits', (_req, res) => {
  res.json(SAFETY_LIMITS);
});

// Muestras incluidas
app.get('/api/samples/:name', (req, res) => {
  const allowed = ['nginx_rampa.log', 'latencias_api.csv'];
  if (!allowed.includes(req.params.name)) {
    res.status(404).json({ error: 'Muestra no encontrada' });
    return;
  }
  const content = fs.readFileSync(path.resolve(process.cwd(), 'samples', req.params.name), 'utf8');
  res.json({ name: req.params.name, content });
});

// Infraestructuras (targets + perfil + autorización)
app.get('/api/targets', (_req, res) => {
  const targets = db.db.prepare('SELECT * FROM targets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  const result = targets.map((t) => {
    const auth = db.db
      .prepare('SELECT * FROM authorizations WHERE target_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(String(t.id)) as Record<string, unknown> | undefined;
    const profile = db.db
      .prepare('SELECT * FROM infrastructure_profiles WHERE target_id = ?')
      .get(String(t.id)) as Record<string, unknown> | undefined;
    return {
      id: t.id,
      name: t.name,
      baseUrl: t.base_url,
      environment: t.environment,
      createdAt: t.created_at,
      cooldownRemainingS: getProbeCooldownRemainingS(String(t.id)),
      authorization: auth
        ? {
            id: auth.id,
            method: auth.method,
            rawTokenPreview: auth.raw_token_preview,
            verifiedAt: auth.verified_at,
            expiresAt: auth.expires_at,
            declaredBy: auth.declared_by,
            evidenceNote: auth.evidence_note,
          }
        : null,
      profile: profile
        ? {
            c: Number(profile.c),
            K: Number(profile.K),
            timeoutS: Number(profile.timeout_s),
            muDeclared: Number(profile.mu_declared),
            muSource: String(profile.mu_source),
            serviceCv: Number(profile.service_cv),
            sloMs: Number(profile.slo_ms),
          }
        : null,
    };
  });
  res.json(result);
});

app.post('/api/targets', async (req, res) => {
  try {
    const { name, baseUrl, environment, c, K, timeoutS, muDeclared, muSource, serviceCv, sloMs } = req.body ?? {};
    if (!name || !baseUrl) {
      res.status(400).json({ error: 'Nombre y URL base son obligatorios.' });
      return;
    }

    const ssrf = await validateTargetUrlSsrf(String(baseUrl), { allowPrivateOrLoopback: true });
    if (!ssrf.allowed) {
      res.status(400).json({ error: ssrf.reason ?? 'URL bloqueada por política SSRF.' });
      return;
    }

    const id = randomUUID();
    const nowIso = new Date().toISOString();
    const ownerRow = db.db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined;
    const ownerId = ownerRow?.id ?? randomUUID();

    db.db
      .prepare('INSERT INTO targets (id, name, base_url, environment, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, String(name), String(baseUrl), String(environment ?? 'LABORATORIO'), ownerId, nowIso);

    db.db
      .prepare(
        `INSERT INTO infrastructure_profiles (id, target_id, c, K, timeout_s, mu_declared, mu_source, service_cv, slo_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        id,
        Math.max(1, Number(c ?? 1)),
        Math.max(1, Number(K ?? 100)),
        Math.max(0.005, Number(timeoutS ?? 0.05)),
        Math.max(1, Number(muDeclared ?? 100)),
        String(muSource ?? 'DECLARED'),
        Math.max(0.1, Number(serviceCv ?? 1.0)),
        Math.max(5, Number(sloMs ?? 50)),
        nowIso,
      );

    db.appendAudit('operador@umbralsim.local', 'TARGET_CREATED', id, {
      name,
      baseUrl,
      environment,
      isPrivateOrLoopback: ssrf.isPrivateOrLoopback,
    });
    res.status(201).json({ id, isPrivateOrLoopback: ssrf.isPrivateOrLoopback, resolvedIps: ssrf.resolvedIps });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.put('/api/targets/:id/profile', (req, res) => {
  const { c, K, timeoutS, muDeclared, muSource, serviceCv, sloMs } = req.body ?? {};
  const existing = db.db.prepare('SELECT id FROM infrastructure_profiles WHERE target_id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Objetivo no encontrado.' });
    return;
  }
  const nowIso = new Date().toISOString();
  db.db
    .prepare(
      `UPDATE infrastructure_profiles
       SET c = ?, K = ?, timeout_s = ?, mu_declared = ?, mu_source = ?, service_cv = ?, slo_ms = ?, updated_at = ?
       WHERE target_id = ?`,
    )
    .run(
      Math.max(1, Number(c ?? 1)),
      Math.max(1, Number(K ?? 100)),
      Math.max(0.005, Number(timeoutS ?? 0.05)),
      Math.max(1, Number(muDeclared ?? 100)),
      String(muSource ?? 'DECLARED'),
      Math.max(0.1, Number(serviceCv ?? 1.0)),
      Math.max(5, Number(sloMs ?? 50)),
      nowIso,
      req.params.id,
    );
  db.appendAudit('operador@umbralsim.local', 'PROFILE_UPDATED', req.params.id, { c, K, timeoutS, muDeclared });
  res.json({ updated: true });
});

// Registro de autorización y generación de token
app.post('/api/targets/:id/authorizations', (req, res) => {
  const target = db.db.prepare('SELECT * FROM targets WHERE id = ?').get(req.params.id) as
    | { id: string; base_url: string }
    | undefined;
  if (!target) {
    res.status(404).json({ error: 'Objetivo no encontrado.' });
    return;
  }
  const method = (req.body?.method ?? 'WELL_KNOWN') as VerificationMethod;
  const expiresHours = Math.min(720, Math.max(1, Number(req.body?.expiresHours ?? 72)));
  const declaredBy = String(req.body?.declaredBy ?? 'operador@umbralsim.local');
  const evidenceNote = String(req.body?.evidenceNote ?? 'Autorización declarada en consola');

  const { rawToken, tokenHash } = generateVerificationToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresHours * 3600_000).toISOString();
  const authId = randomUUID();

  // Si es el mock-target local, actualizamos su token de demostración /.well-known/umbral-verify.txt
  if (target.base_url.includes('127.0.0.1:3000') || target.base_url.includes('localhost:3000')) {
    mockVerifyToken = rawToken;
  }

  db.db
    .prepare(
      `INSERT INTO authorizations (id, target_id, method, token_hash, raw_token_preview, verified_at, expires_at, declared_by, evidence_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      authId,
      target.id,
      method,
      tokenHash,
      rawToken,
      method === 'PRIVATE_AUTH_ONLY' ? now.toISOString() : null,
      expiresAt,
      declaredBy,
      evidenceNote,
      now.toISOString(),
    );

  db.appendAudit(declaredBy, 'AUTHORIZATION_REGISTERED', target.id, { authId, method, expiresAt });
  res.status(201).json({ id: authId, rawToken, method, expiresAt });
});

app.post('/api/targets/:id/authorizations/:authId/verify', async (req, res) => {
  const target = db.db.prepare('SELECT * FROM targets WHERE id = ?').get(req.params.id) as
    | { id: string; base_url: string }
    | undefined;
  const auth = db.db.prepare('SELECT * FROM authorizations WHERE id = ? AND target_id = ?').get(
    req.params.authId,
    req.params.id,
  ) as { id: string; method: string; token_hash: string } | undefined;

  if (!target || !auth) {
    res.status(404).json({ error: 'Objetivo o autorización no encontrados.' });
    return;
  }

  const check = await verifyOwnershipRemote({
    targetUrl: target.base_url,
    method: auth.method as VerificationMethod,
    expectedTokenHash: auth.token_hash,
  });

  if (!check.verified) {
    db.appendAudit('operador@umbralsim.local', 'OWNERSHIP_VERIFY_FAILED', target.id, { detail: check.detail });
    res.status(400).json({ verified: false, detail: check.detail });
    return;
  }

  const verifiedAt = new Date().toISOString();
  db.db.prepare('UPDATE authorizations SET verified_at = ? WHERE id = ?').run(verifiedAt, auth.id);
  db.appendAudit('operador@umbralsim.local', 'OWNERSHIP_VERIFIED', target.id, { authId: auth.id, detail: check.detail });
  res.json({ verified: true, verifiedAt, detail: check.detail });
});

// Experimentos: listar, detalle, ejecutar, reejecutar, comparación matemática
app.get('/api/experiments', (req, res) => {
  const modelFilter = req.query.model ? String(req.query.model) : null;
  const sourceFilter = req.query.source ? String(req.query.source) : null;

  let sql = `
    SELECT e.id, e.target_id, t.name as target_name, e.objective, e.model, e.status, e.created_by, e.created_at,
           ds.kind as source_kind,
           p.lambda_star, p.ci_low, p.ci_high, p.confidence_level, p.extrapolated
    FROM experiments e
    JOIN targets t ON t.id = e.target_id
    LEFT JOIN data_sources ds ON ds.id = e.source_id
    LEFT JOIN predictions p ON p.experiment_id = e.id
    WHERE 1=1
  `;
  const params: string[] = [];
  if (modelFilter) {
    sql += ' AND e.model = ?';
    params.push(modelFilter);
  }
  if (sourceFilter) {
    sql += ' AND ds.kind = ?';
    params.push(sourceFilter);
  }
  sql += ' ORDER BY e.created_at DESC LIMIT 100';

  const rows = db.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  res.json(
    rows.map((r) => ({
      id: r.id,
      targetId: r.target_id,
      targetName: r.target_name,
      objective: r.objective,
      model: r.model,
      sourceKind: r.source_kind ?? 'DECLARED',
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
      lambdaStar: r.lambda_star !== null ? Number(r.lambda_star) : null,
      ciLow: r.ci_low !== null ? Number(r.ci_low) : null,
      ciHigh: r.ci_high !== null ? Number(r.ci_high) : null,
      confidenceLevel: r.confidence_level,
      extrapolated: Boolean(r.extrapolated),
    })),
  );
});

app.get('/api/experiments/:id', (req, res) => {
  const detail = getExperimentDetail(db, req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'Experimento no encontrado.' });
    return;
  }
  res.json(detail);
});

app.post('/api/experiments/run', async (req, res) => {
  try {
    const out = await executeExperimentPipeline(db, {
      ...req.body,
      emitWs: broadcastWs,
    });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/experiments/:id/rerun', async (req, res) => {
  try {
    const detail = getExperimentDetail(db, req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'Experimento no encontrado.' });
      return;
    }
    const p = (detail.experiment.params.params ?? {}) as QueueParams;
    const obj = (detail.experiment.params.objective ?? {
      type: 'MEAN_LATENCY',
      targetLatencyS: 0.05,
    }) as ObjectiveConfig;

    const out = await executeExperimentPipeline(db, {
      targetId: detail.experiment.targetId,
      sourceKind: detail.experiment.sourceKind === 'LAB' ? 'LAB' : 'DECLARED',
      model: detail.experiment.model as QueueModelType,
      objective: obj,
      muOverride: p.mu,
      c: p.c,
      K: p.K,
      cv: p.cv,
      emitWs: broadcastWs,
    });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Curva teórica W(lambda) + análisis de cuencas Newton vs Secante
app.post('/api/math/analyze', (req, res) => {
  try {
    const modelType = (req.body?.model ?? 'MM1') as QueueModelType;
    const params = req.body?.params as QueueParams;
    const objective = req.body?.objective as ObjectiveConfig;
    const newtonSeed = req.body?.newtonSeed !== undefined ? Number(req.body.newtonSeed) : undefined;
    const secantSeeds = Array.isArray(req.body?.secantSeeds)
      ? ([Number(req.body.secantSeeds[0]), Number(req.body.secantSeeds[1])] as [number, number])
      : undefined;
    const tol = Number(req.body?.tol ?? 1e-12);

    const solved = solveThresholdComparison({
      modelType,
      params,
      objective,
      newtonSeed,
      secantSeeds,
      tolF: tol,
      tolX: tol,
    });

    const basin = computeBasinOfConvergence({
      modelType,
      params,
      objective,
      samples: 24,
    });

    const tolSensitivity = computeToleranceSensitivity({
      modelType,
      params,
      objective,
      newtonSeed,
      secantSeeds,
    });

    // Generar puntos de la curva W(lambda) para graficar
    const qModel = getQueueModel(modelType);
    const [dMin, dMax] = qModel.domain(params);
    const maxCurveX = Math.min(dMax * 0.96, dMin + (dMax - dMin) * 0.96);
    const curvePoints: Array<{ lambda: number; latency: number }> = [];
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const lam = dMin + (i / steps) * (maxCurveX - dMin);
      const w = qModel.latency(lam, params);
      if (Number.isFinite(w) && w < objective.targetLatencyS * 6) {
        curvePoints.push({ lambda: Number(lam.toFixed(4)), latency: Number(w.toFixed(6)) });
      }
    }

    res.json({ solved, basin, tolSensitivity, curvePoints });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Consulta de métricas Prometheus (rango)
app.post('/api/integrations/prometheus/import', async (req, res) => {
  try {
    const out = await fetchPrometheusRange(req.body);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Reportes descargables PDF / CSV / JSON
app.get('/api/reports/:experimentId/download', async (req, res) => {
  const format = String(req.query.format ?? 'json').toLowerCase();
  const detail = getExperimentDetail(db, req.params.experimentId);
  if (!detail) {
    res.status(404).json({ error: 'Experimento no encontrado.' });
    return;
  }

  db.db
    .prepare('INSERT INTO reports (id, experiment_id, format, file_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), detail.experiment.id, format.toUpperCase(), `memory://${detail.experiment.id}.${format}`, new Date().toISOString());

  db.appendAudit('operador@umbralsim.local', 'REPORT_EXPORTED', detail.experiment.targetId, {
    experimentId: detail.experiment.id,
    format,
  });

  if (format === 'csv') {
    const csv = generateCsvReport(detail);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="umbralsim-${detail.experiment.id.slice(0, 8)}.csv"`);
    res.send(csv);
    return;
  }

  if (format === 'pdf') {
    const pdfBuffer = await generatePdfReportBuffer(detail);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="umbralsim-${detail.experiment.id.slice(0, 8)}.pdf"`);
    res.send(pdfBuffer);
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="umbralsim-${detail.experiment.id.slice(0, 8)}.json"`);
  res.json(detail);
});

// Auditoría de solo lectura + verificación de cadena SHA-256
app.get('/api/audit', (_req, res) => {
  const entries = db.getAuditLog(300);
  const verification = verifyAuditChain(entries);
  res.json({ verification, entries: [...entries].reverse() });
});

async function start(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`UmbralSim servidor escuchando en http://0.0.0.0:${PORT}`);
  });
}

start();
