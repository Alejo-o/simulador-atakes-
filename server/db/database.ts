import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computeAuditHash, GENESIS_AUDIT_HASH, type AuditEntryRecord } from '../core/audit';
import { runDiscreteEventSimulation } from '../adapters/simulator';
import { fitRobustMM1, predictWithConfidence, evaluatePreventiveAlerts } from '../math/fitting';
import { solveThresholdComparison } from '../math/solvers';
import type { ObjectiveConfig, QueueModelType, QueueParams, SolverResult } from '../math/types';

export interface TargetRow {
  id: string;
  name: string;
  base_url: string;
  environment: string;
  owner_id: string;
  created_at: string;
}

export interface AuthorizationRow {
  id: string;
  target_id: string;
  method: string;
  token_hash: string;
  raw_token_preview: string | null;
  verified_at: string | null;
  expires_at: string;
  declared_by: string;
  evidence_note: string;
  created_at: string;
}

export interface ProfileRow {
  id: string;
  target_id: string;
  c: number;
  K: number;
  timeout_s: number;
  mu_declared: number;
  mu_source: string;
  service_cv: number;
  slo_ms: number;
  updated_at: string;
}

export class UmbralDatabase {
  public readonly db: DatabaseSync;

  constructor(dbPath: string = path.resolve(process.cwd(), 'data', 'umbralsim.sqlite')) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
    this.seedInitialData();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        environment TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_targets_created_at ON targets(created_at);

      CREATE TABLE IF NOT EXISTS authorizations (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        raw_token_preview TEXT,
        verified_at TEXT,
        expires_at TEXT NOT NULL,
        declared_by TEXT NOT NULL,
        evidence_note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_target ON authorizations(target_id);

      CREATE TABLE IF NOT EXISTS infrastructure_profiles (
        id TEXT PRIMARY KEY,
        target_id TEXT UNIQUE NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        c INTEGER NOT NULL,
        K INTEGER NOT NULL,
        timeout_s REAL NOT NULL,
        mu_declared REAL NOT NULL,
        mu_source TEXT NOT NULL,
        service_cv REAL NOT NULL,
        slo_ms REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS data_sources (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ds_target ON data_sources(target_id);

      CREATE TABLE IF NOT EXISTS measurements (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        window_s INTEGER NOT NULL,
        lambda_obs REAL NOT NULL,
        w_mean REAL NOT NULL,
        w_p50 REAL NOT NULL,
        w_p95 REAL NOT NULL,
        w_p99 REAL NOT NULL,
        error_rate REAL NOT NULL,
        provenance TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meas_source ON measurements(source_id);

      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        source_id TEXT REFERENCES data_sources(id),
        objective TEXT NOT NULL,
        model TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_exp_target ON experiments(target_id);
      CREATE INDEX IF NOT EXISTS idx_exp_created ON experiments(created_at);

      CREATE TABLE IF NOT EXISTS solver_runs (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        seeds_json TEXT NOT NULL,
        tol REAL NOT NULL,
        converged INTEGER NOT NULL,
        root REAL,
        failure_reason TEXT NOT NULL,
        failure_message TEXT,
        stopping_criterion TEXT NOT NULL,
        f_evals INTEGER NOT NULL,
        df_evals INTEGER NOT NULL,
        elapsed_ns INTEGER NOT NULL,
        estimated_order REAL,
        efficiency_index REAL,
        used_finite_difference INTEGER NOT NULL,
        abs_error REAL,
        rel_error REAL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_exp ON solver_runs(experiment_id);

      CREATE TABLE IF NOT EXISTS solver_iterations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES solver_runs(id) ON DELETE CASCADE,
        n INTEGER NOT NULL,
        x REAL NOT NULL,
        fx REAL NOT NULL,
        dfx REAL,
        step REAL,
        err_abs REAL,
        err_true REAL
      );
      CREATE INDEX IF NOT EXISTS idx_iter_run ON solver_iterations(run_id);

      CREATE TABLE IF NOT EXISTS predictions (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        lambda_star REAL,
        ci_low REAL,
        ci_high REAL,
        confidence_level TEXT NOT NULL,
        extrapolated INTEGER NOT NULL,
        extrapolation_warning TEXT,
        provenance TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pred_exp ON predictions(experiment_id);

      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        severity TEXT NOT NULL,
        rule TEXT NOT NULL,
        message TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_exp ON alerts(experiment_id);

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        format TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT,
        detail_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    `);
  }

  public appendAudit(actor: string, action: string, targetId: string | null, detail: unknown): AuditEntryRecord {
    const last = this.db.prepare('SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    const prevHash = last?.hash ?? GENESIS_AUDIT_HASH;
    const id = randomUUID();
    const ts = new Date().toISOString();
    const detailJson = JSON.stringify(detail ?? {});
    const hash = computeAuditHash({ id, ts, actor, action, targetId, detailJson, prevHash });

    this.db
      .prepare(
        `INSERT INTO audit_log (id, ts, actor, action, target_id, detail_json, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ts, actor, action, targetId, detailJson, prevHash, hash);

    return { id, ts, actor, action, targetId, detailJson, prevHash, hash };
  }

  public getAuditLog(limit: number = 200): AuditEntryRecord[] {
    const rows = this.db
      .prepare('SELECT id, ts, actor, action, target_id, detail_json, prev_hash, hash FROM audit_log ORDER BY rowid ASC LIMIT ?')
      .all(limit) as Array<{
      id: string;
      ts: string;
      actor: string;
      action: string;
      target_id: string | null;
      detail_json: string;
      prev_hash: string;
      hash: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      targetId: r.target_id,
      detailJson: r.detail_json,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }

  public saveSolverRun(
    experimentId: string,
    run: SolverResult,
    seeds: number[],
    tol: number,
  ): string {
    const runId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO solver_runs (
          id, experiment_id, method, seeds_json, tol, converged, root,
          failure_reason, failure_message, stopping_criterion,
          f_evals, df_evals, elapsed_ns, estimated_order, efficiency_index,
          used_finite_difference, abs_error, rel_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        experimentId,
        run.method,
        JSON.stringify(seeds),
        tol,
        run.converged ? 1 : 0,
        run.root,
        run.failureReason,
        run.failureMessage,
        run.stoppingCriterion,
        run.fEvals,
        run.dfEvals,
        run.elapsedNs,
        run.estimatedOrder,
        run.efficiencyIndex,
        run.usedFiniteDifference ? 1 : 0,
        run.absError,
        run.relError,
      );

    const insertIter = this.db.prepare(
      `INSERT INTO solver_iterations (id, run_id, n, x, fx, dfx, step, err_abs, err_true)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const it of run.iterations) {
      insertIter.run(
        randomUUID(),
        runId,
        it.n,
        it.x,
        it.fx,
        it.dfx,
        it.step,
        it.stepError,
        it.trueError,
      );
    }
    return runId;
  }

  private seedInitialData(): void {
    const countRow = this.db.prepare('SELECT COUNT(*) as cnt FROM targets').get() as { cnt: number };
    if (countRow.cnt > 0) return;

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + 30 * 24 * 3600_000).toISOString();

    const userId = randomUUID();
    this.db
      .prepare('INSERT INTO users (id, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, 'operador@umbralsim.local', 'ADMIN', 'local-session', nowIso);

    // Objetivo 1: Mock Target en loopback para demostración segura de laboratorio y sondeo
    const mockTargetId = randomUUID();
    this.db
      .prepare('INSERT INTO targets (id, name, base_url, environment, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(mockTargetId, 'Servidor Mock Laboratorio (Loopback)', 'http://127.0.0.1:3000/mock-target', 'LABORATORIO', userId, nowIso);

    this.db
      .prepare(
        `INSERT INTO authorizations (id, target_id, method, token_hash, raw_token_preview, verified_at, expires_at, declared_by, evidence_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        mockTargetId,
        'PRIVATE_AUTH_ONLY',
        'mock-local-hash',
        'umbral-verify=mock-local',
        nowIso,
        expiresIso,
        'operador@umbralsim.local',
        'Objetivo local incluido para laboratorio y pruebas seguras.',
        nowIso,
      );

    this.db
      .prepare(
        `INSERT INTO infrastructure_profiles (id, target_id, c, K, timeout_s, mu_declared, mu_source, service_cv, slo_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), mockTargetId, 1, 120, 0.05, 100, 'DECLARED', 1.0, 50, nowIso);

    // Experimento semilla 1: Simulador de Eventos Discretos en escenario Rampa (M/M/1)
    const ds1Id = randomUUID();
    this.db
      .prepare('INSERT INTO data_sources (id, target_id, kind, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        ds1Id,
        mockTargetId,
        'LAB',
        JSON.stringify({ scenario: 'RAMP', mu: 100, c: 1, K: 120, durationS: 30, windowS: 2 }),
        nowIso,
      );

    const sim = runDiscreteEventSimulation({
      scenario: 'RAMP',
      mu: 100,
      c: 1,
      K: 120,
      timeoutS: 0.05,
      cv: 1.0,
      lambdaStart: 20,
      lambdaPeak: 92,
      durationS: 30,
      windowS: 2,
      seed: 202611,
    });

    const insertMeas = this.db.prepare(
      `INSERT INTO measurements (id, source_id, ts, window_s, lambda_obs, w_mean, w_p50, w_p95, w_p99, error_rate, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const w of sim.windows) {
      insertMeas.run(randomUUID(), ds1Id, w.ts, 2, w.lambdaObs, w.wMean, w.wP50, w.wP95, w.wP99, w.errorRate, 'SIMULATED');
    }

    const exp1Id = randomUUID();
    const model1: QueueModelType = 'MM1';
    const params1: QueueParams = { mu: 100, c: 1, K: 120, cv: 1.0 };
    const obj1: ObjectiveConfig = { type: 'MEAN_LATENCY', targetLatencyS: 0.05 };
    const solved1 = solveThresholdComparison({
      modelType: model1,
      params: params1,
      objective: obj1,
      newtonSeed: 68,
      secantSeeds: [55, 68],
    });

    this.db
      .prepare(
        `INSERT INTO experiments (id, target_id, source_id, objective, model, params_json, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        exp1Id,
        mockTargetId,
        ds1Id,
        'MEAN_LATENCY',
        'MM1',
        JSON.stringify({
          params: params1,
          objective: obj1,
          scenario: 'RAMP',
          simSummary: {
            totalArrivals: sim.totalArrivals,
            totalProcessed: sim.totalProcessed,
            totalRejected: sim.totalRejected,
            totalTimeouts: sim.totalTimeouts,
          },
        }),
        'COMPLETED',
        'operador@umbralsim.local',
        nowIso,
      );

    this.saveSolverRun(exp1Id, solved1.newton, [68], 1e-12);
    this.saveSolverRun(exp1Id, solved1.secant, [55, 68], 1e-12);
    this.saveSolverRun(exp1Id, solved1.bisection, [0.01, 99.9], 1e-12);

    const pred1 = predictWithConfidence({
      modelType: 'MM1',
      params: params1,
      objective: obj1,
      muCiLow: 94.5,
      muCiHigh: 105.5,
      maxObservedLambda: Math.max(...sim.windows.map((w) => w.lambdaObs)),
      rSquared: 0.94,
      sampleCount: sim.windows.length,
    });

    this.db
      .prepare(
        `INSERT INTO predictions (id, experiment_id, lambda_star, ci_low, ci_high, confidence_level, extrapolated, extrapolation_warning, provenance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        exp1Id,
        pred1.lambdaStar,
        pred1.ciLow,
        pred1.ciHigh,
        pred1.confidenceLevel,
        pred1.extrapolated ? 1 : 0,
        pred1.extrapolationWarning,
        'PREDICTED',
        nowIso,
      );

    const lastLambda = sim.windows[sim.windows.length - 1]?.lambdaObs ?? 75;
    const alerts1 = evaluatePreventiveAlerts({
      currentLambda: lastLambda,
      muTotal: 100,
      lambdaStar: pred1.lambdaStar,
      lambdaTrendPerMin: 12,
    });
    const insertAlert = this.db.prepare(
      'INSERT INTO alerts (id, experiment_id, severity, rule, message, ts) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const a of alerts1) {
      insertAlert.run(randomUUID(), exp1Id, a.severity, a.rule, a.message, nowIso);
    }

    // Objetivo 2: Infraestructura de logs forenses reales (con datos MEASURED + extrapolación)
    const prodTargetId = randomUUID();
    this.db
      .prepare('INSERT INTO targets (id, name, base_url, environment, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(prodTargetId, 'Gateway Pagos (Análisis Forense Logs)', 'https://gateway.ejemplo-autorizado.local', 'PRODUCCION', userId, nowIso);

    this.db
      .prepare(
        `INSERT INTO infrastructure_profiles (id, target_id, c, K, timeout_s, mu_declared, mu_source, service_cv, slo_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), prodTargetId, 2, 250, 0.04, 80, 'LOGS', 1.12, 40, nowIso);

    const ds2Id = randomUUID();
    this.db
      .prepare('INSERT INTO data_sources (id, target_id, kind, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ds2Id, prodTargetId, 'LOG', JSON.stringify({ format: 'NGINX_COMBINED', fileName: 'nginx_rampa.log', windowS: 5 }), nowIso);

    const measuredSampleWindows = [12, 20, 31, 42, 54, 66, 76, 84].map((lam, idx) => {
      const wMean = 1 / (160 - lam) + (idx % 2 === 0 ? 0.0004 : -0.0003);
      return {
        ts: new Date(now.getTime() - (8 - idx) * 5000).toISOString(),
        lambdaObs: lam,
        wMean,
        wP50: wMean * 0.72,
        wP95: wMean * 2.95,
        wP99: wMean * 4.45,
        errorRate: lam > 75 ? 0.012 : 0.001,
      };
    });
    for (const w of measuredSampleWindows) {
      insertMeas.run(randomUUID(), ds2Id, w.ts, 5, w.lambdaObs, w.wMean, w.wP50, w.wP95, w.wP99, w.errorRate, 'MEASURED');
    }

    const fit2 = fitRobustMM1(measuredSampleWindows);
    const exp2Id = randomUUID();
    const obj2: ObjectiveConfig = { type: 'MEAN_LATENCY', targetLatencyS: 0.04 };
    const params2: QueueParams = { mu: fit2.muEstimated, c: 2, K: 250, cv: fit2.cvEstimated };
    const solved2 = solveThresholdComparison({
      modelType: 'MM1',
      params: params2,
      objective: obj2,
    });
    const pred2 = predictWithConfidence({
      modelType: 'MM1',
      params: params2,
      objective: obj2,
      muCiLow: fit2.muCiLow,
      muCiHigh: fit2.muCiHigh,
      maxObservedLambda: fit2.maxObservedLambda,
      rSquared: fit2.rSquared,
      sampleCount: measuredSampleWindows.length,
    });

    this.db
      .prepare(
        `INSERT INTO experiments (id, target_id, source_id, objective, model, params_json, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        exp2Id,
        prodTargetId,
        ds2Id,
        'MEAN_LATENCY',
        'MM1',
        JSON.stringify({ params: params2, objective: obj2, fitting: fit2 }),
        'COMPLETED',
        'operador@umbralsim.local',
        nowIso,
      );

    this.saveSolverRun(exp2Id, solved2.newton, [solved2.newton.iterations[0]?.x ?? fit2.muEstimated * 0.7], 1e-12);
    this.saveSolverRun(exp2Id, solved2.secant, [
      solved2.secant.iterations[0]?.x ?? fit2.muEstimated * 0.65,
      solved2.secant.iterations[1]?.x ?? fit2.muEstimated * 0.78,
    ], 1e-12);

    this.db
      .prepare(
        `INSERT INTO predictions (id, experiment_id, lambda_star, ci_low, ci_high, confidence_level, extrapolated, extrapolation_warning, provenance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        exp2Id,
        pred2.lambdaStar,
        pred2.ciLow,
        pred2.ciHigh,
        pred2.confidenceLevel,
        pred2.extrapolated ? 1 : 0,
        pred2.extrapolationWarning,
        'PREDICTED',
        nowIso,
      );

    const alerts2 = evaluatePreventiveAlerts({
      currentLambda: 84,
      muTotal: fit2.muEstimated,
      lambdaStar: pred2.lambdaStar,
      lambdaTrendPerMin: 18,
    });
    for (const a of alerts2) {
      insertAlert.run(randomUUID(), exp2Id, a.severity, a.rule, a.message, nowIso);
    }

    this.appendAudit('sistema@umbralsim.local', 'SYSTEM_SEED_INITIALIZED', mockTargetId, {
      message: 'Inicialización de objetivos de laboratorio, experimento base y log forense.',
    });
  }
}
