import { randomUUID } from 'node:crypto';
import { parseLogsAndAggregate } from '../adapters/logParser';
import {
  runAuthorizedLowRateProbe,
  type ProbeHttpSignals,
  type ProbeStepMeasurement,
} from '../adapters/probe';
import { fetchPrometheusRange } from '../adapters/prometheus';
import { runDiscreteEventSimulation, type SimulationWindowPoint, type TrafficScenario } from '../adapters/simulator';
import type { AuthorizationRecord, VerificationMethod } from '../adapters/ownership';
import type { UmbralDatabase } from '../db/database';
import {
  evaluatePreventiveAlerts,
  fitRobustMM1,
  predictWithConfidence,
  type WindowedMeasurement,
} from '../math/fitting';
import { solveThresholdComparison } from '../math/solvers';
import type { EmpiricalPoint, ObjectiveConfig, Provenance, QueueModelType, QueueParams } from '../math/types';
import { getExperimentDetail, type ExperimentDetailPayload } from './reports';

export interface ProbeCalibrationSummary {
  method: 'THEIL_SEN_PROBE' | 'BASELINE_1_OVER_S0' | 'MANUAL_OVERRIDE';
  s0Ms: number;
  s0CiLowMs: number;
  s0CiHighMs: number;
  muCalibrated: number;
  muCiLow: number;
  muCiHigh: number;
  workersUsed: number;
  autoAdjustedT: boolean;
  requestedTargetLatencyS: number;
  effectiveTargetLatencyS: number;
  httpSignals: ProbeHttpSignals;
}

export interface RunExperimentRequest {
  targetId: string;
  sourceKind: 'LAB' | 'LOG' | 'PROBE' | 'PROMETHEUS' | 'DECLARED';
  model: QueueModelType;
  objective: ObjectiveConfig;
  autoTargetLatency?: boolean;
  muOverride?: number;
  c?: number;
  K?: number;
  cv?: number;
  newtonSeed?: number;
  secantSeeds?: [number, number];
  tol?: number;
  // Opciones de laboratorio
  labScenario?: TrafficScenario;
  labLambdaStart?: number;
  labLambdaPeak?: number;
  labDurationS?: number;
  labWindowS?: number;
  // Opciones de logs
  rawLogText?: string;
  logWindowS?: number;
  // Opciones de sondeo
  probeMethod?: 'GET' | 'HEAD';
  probeRps?: number;
  probeDurationS?: number;
  probeConcurrency?: number;
  explicitAuthorizationChecked?: boolean;
  // Opciones de Prometheus
  prometheusUrl?: string;
  prometheusRateQuery?: string;
  prometheusLatencyQuery?: string;
  prometheusLookbackMin?: number;
  prometheusStepS?: number;
  prometheusBearerToken?: string;
  prometheusAllowPrivate?: boolean;
  // Callback WS
  emitWs?: (event: string, payload: unknown) => void;
}

function buildSortedEmpiricalPoints(
  measurements: Array<{ lambdaObs: number; wMean: number }>,
): EmpiricalPoint[] {
  const byLambda = new Map<number, { sumW: number; count: number }>();
  for (const m of measurements) {
    if (!Number.isFinite(m.lambdaObs) || !Number.isFinite(m.wMean) || m.wMean <= 0) continue;
    const key = Number(m.lambdaObs.toFixed(4));
    const prev = byLambda.get(key);
    if (prev) {
      prev.sumW += m.wMean;
      prev.count += 1;
    } else {
      byLambda.set(key, { sumW: m.wMean, count: 1 });
    }
  }
  return Array.from(byLambda.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([lambda, agg]) => ({
      lambda,
      latency: Number((agg.sumW / agg.count).toFixed(6)),
    }));
}

export async function executeExperimentPipeline(
  db: UmbralDatabase,
  req: RunExperimentRequest,
  actor: string = 'operador@umbralsim.local',
): Promise<{
  detail: ExperimentDetailPayload;
  fitting?: ReturnType<typeof fitRobustMM1>;
  logSummary?: Omit<ReturnType<typeof parseLogsAndAggregate>, 'windows'>;
  probeMeta?: {
    aborted: boolean;
    abortReason: string | null;
    baselineLatencyS: number;
    baselineCiLowS: number;
    baselineCiHighS: number;
    estimatedServiceCv: number;
    availability: number;
    totalRequests: number;
    httpSignals: ProbeHttpSignals;
    limitationNote: string;
  };
  probeCalibration?: ProbeCalibrationSummary;
}> {
  const target = db.db.prepare('SELECT * FROM targets WHERE id = ?').get(req.targetId) as
    | { id: string; name: string; base_url: string; environment: string }
    | undefined;
  if (!target) {
    throw new Error('Infraestructura objetivo no encontrada.');
  }

  const profile = db.db.prepare('SELECT * FROM infrastructure_profiles WHERE target_id = ?').get(req.targetId) as
    | {
        c: number;
        K: number;
        timeout_s: number;
        mu_declared: number;
        mu_source: string;
        service_cv: number;
        slo_ms: number;
      }
    | undefined;

  const muBase = req.muOverride ?? profile?.mu_declared ?? 100;
  const cVal = Math.max(1, Math.round(req.c ?? profile?.c ?? 1));
  const kVal = Math.max(1, Math.round(req.K ?? profile?.K ?? 120));
  const cvVal = req.cv ?? profile?.service_cv ?? 1.0;

  const nowIso = new Date().toISOString();
  const sourceId = randomUUID();
  let measurements: Array<WindowedMeasurement & { provenance: Provenance }> = [];
  let sourceMetadata: Record<string, unknown> = {};
  let fittingResult: ReturnType<typeof fitRobustMM1> | undefined;
  let logSummary: Omit<ReturnType<typeof parseLogsAndAggregate>, 'windows'> | undefined;
  let probeMeta:
    | {
        aborted: boolean;
        abortReason: string | null;
        baselineLatencyS: number;
        baselineCiLowS: number;
        baselineCiHighS: number;
        estimatedServiceCv: number;
        availability: number;
        totalRequests: number;
        httpSignals: ProbeHttpSignals;
        limitationNote: string;
      }
    | undefined;
  let probeCalibration: ProbeCalibrationSummary | undefined;

  let simTotals:
    | { totalArrivals: number; totalProcessed: number; totalRejected: number; totalTimeouts: number }
    | undefined;

  if (req.sourceKind === 'LAB') {
    const scenario = req.labScenario ?? 'RAMP';
    const durationS = Math.min(120, Math.max(5, req.labDurationS ?? 24));
    const windowS = Math.max(1, Math.min(10, req.labWindowS ?? 2));
    const capTotal = req.model === 'MMC' ? muBase * cVal : muBase;
    const lambdaStart = req.labLambdaStart ?? Math.max(1, capTotal * 0.2);
    const lambdaPeak = req.labLambdaPeak ?? capTotal * 0.92;

    sourceMetadata = { scenario, mu: muBase, c: cVal, K: kVal, durationS, windowS };
    const sim = runDiscreteEventSimulation(
      {
        scenario,
        mu: muBase,
        c: req.model === 'MMC' ? cVal : 1,
        K: req.model === 'MM1K' ? kVal : null,
        timeoutS: req.objective.targetLatencyS,
        cv: cvVal,
        lambdaStart,
        lambdaPeak,
        durationS,
        windowS,
        seed: Date.now() % 1_000_000,
      },
      (win: SimulationWindowPoint) => {
        req.emitWs?.('simulation_window', { targetId: target.id, window: win });
      },
    );

    measurements = sim.windows.map((w) => ({
      ts: w.ts,
      lambdaObs: w.lambdaObs,
      wMean: w.wMean,
      wP50: w.wP50,
      wP95: w.wP95,
      wP99: w.wP99,
      errorRate: w.errorRate,
      provenance: 'SIMULATED' as Provenance,
    }));
    simTotals = {
      totalArrivals: sim.totalArrivals,
      totalProcessed: sim.totalProcessed,
      totalRejected: sim.totalRejected,
      totalTimeouts: sim.totalTimeouts,
    };
  } else if (req.sourceKind === 'LOG') {
    if (!req.rawLogText || req.rawLogText.trim().length === 0) {
      throw new Error('Debe proporcionar contenido de log (Nginx, JSONL o CSV) para el análisis forense.');
    }
    const parsed = parseLogsAndAggregate(req.rawLogText, req.logWindowS ?? 5);
    if (parsed.windows.length < 2) {
      throw new Error(
        `El log solo produjo ${parsed.windows.length} ventana(s) válida(s) (${parsed.invalidLines} líneas inválidas). Se requieren al menos 2 ventanas.`,
      );
    }
    logSummary = {
      formatDetected: parsed.formatDetected,
      totalLines: parsed.totalLines,
      validLines: parsed.validLines,
      invalidLines: parsed.invalidLines,
      invalidSamples: parsed.invalidSamples,
      windowS: parsed.windowS,
    };
    sourceMetadata = { ...logSummary };
    measurements = parsed.windows;
    fittingResult = fitRobustMM1(measurements);
  } else if (req.sourceKind === 'PROMETHEUS') {
    if (!req.prometheusUrl?.trim() || !req.prometheusRateQuery?.trim() || !req.prometheusLatencyQuery?.trim()) {
      throw new Error('Debe especificar URL de Prometheus y consultas PromQL de tasa y latencia.');
    }
    const lookbackMin = Math.min(1440, Math.max(5, Number(req.prometheusLookbackMin ?? 30)));
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lookbackMin * 60_000);
    const prom = await fetchPrometheusRange({
      baseUrl: req.prometheusUrl.trim(),
      rateQuery: req.prometheusRateQuery.trim(),
      latencyQuery: req.prometheusLatencyQuery.trim(),
      startIso: startDate.toISOString(),
      endIso: endDate.toISOString(),
      stepS: Math.max(5, Math.min(300, Number(req.prometheusStepS ?? 15))),
      bearerToken: req.prometheusBearerToken?.trim() || undefined,
      allowPrivate: Boolean(req.prometheusAllowPrivate),
    });
    if (prom.windows.length < 2) {
      throw new Error(
        `Prometheus devolvió ${prom.windows.length} punto(s) válidos. Se requieren al menos 2 ventanas con tasa y latencia positivas.`,
      );
    }
    measurements = prom.windows;
    fittingResult = fitRobustMM1(measurements);
    sourceMetadata = {
      prometheusUrl: req.prometheusUrl.trim(),
      lookbackMin,
      windowCount: prom.windows.length,
    };
  } else if (req.sourceKind === 'PROBE') {
    const authRow = db.db
      .prepare('SELECT * FROM authorizations WHERE target_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(req.targetId) as
      | {
          id: string;
          target_id: string;
          method: string;
          token_hash: string;
          verified_at: string | null;
          expires_at: string;
          declared_by: string;
          evidence_note: string;
        }
      | undefined;

    const authRecord: AuthorizationRecord | null = authRow
      ? {
          id: authRow.id,
          targetId: authRow.target_id,
          method: authRow.method as VerificationMethod,
          tokenHash: authRow.token_hash,
          verifiedAt: authRow.verified_at,
          expiresAt: authRow.expires_at,
          declaredBy: authRow.declared_by,
          evidenceNote: authRow.evidence_note,
        }
      : null;

    const probeResult = await runAuthorizedLowRateProbe(
      {
        targetId: req.targetId,
        targetUrl: target.base_url,
        method: req.probeMethod ?? 'GET',
        requestedRps: req.probeRps ?? 3,
        requestedDurationS: req.probeDurationS ?? 6,
        requestedConcurrency: req.probeConcurrency ?? 1,
        explicitCheckboxChecked: Boolean(req.explicitAuthorizationChecked),
        authorization: authRecord,
      },
      {
        onStep: (step: ProbeStepMeasurement) => {
          req.emitWs?.('probe_step', { targetId: target.id, step });
        },
      },
    );

    probeMeta = {
      aborted: probeResult.aborted,
      abortReason: probeResult.abortReason,
      baselineLatencyS: probeResult.baselineLatencyS,
      baselineCiLowS: probeResult.baselineCiLowS,
      baselineCiHighS: probeResult.baselineCiHighS,
      estimatedServiceCv: probeResult.estimatedServiceCv,
      availability: probeResult.availability,
      totalRequests: probeResult.totalRequests,
      httpSignals: probeResult.httpSignals,
      limitationNote: probeResult.limitationNote,
    };
    sourceMetadata = { ...probeMeta };
    measurements = probeResult.steps.map((st) => ({
      ts: st.ts,
      lambdaObs: st.rps,
      wMean: st.wMean,
      wP50: st.wP50,
      wP95: st.wP95,
      wP99: st.wP99,
      errorRate: st.errorRate,
      provenance: 'MEASURED' as Provenance,
    }));

    db.appendAudit(actor, probeResult.aborted ? 'PROBE_ABORTED' : 'PROBE_COMPLETED', target.id, {
      totalRequests: probeResult.totalRequests,
      aborted: probeResult.aborted,
      abortReason: probeResult.abortReason,
      baselineLatencyS: probeResult.baselineLatencyS,
    });

    if (measurements.length === 0) {
      throw new Error(
        probeResult.abortReason ??
          'El sondeo HTTP finalizó sin respuestas medibles válidas; revise conectividad o código de respuesta del sitio.',
      );
    }

    // Ajustar también el fitting sobre pasos reales si hay variación suficiente
    fittingResult = fitRobustMM1(measurements);
  } else {
    sourceMetadata = { declaredMu: muBase, c: cVal, K: kVal, cv: cvVal };
  }

  db.db
    .prepare('INSERT INTO data_sources (id, target_id, kind, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sourceId, target.id, req.sourceKind, JSON.stringify(sourceMetadata), nowIso);

  const insertMeas = db.db.prepare(
    `INSERT INTO measurements (id, source_id, ts, window_s, lambda_obs, w_mean, w_p50, w_p95, w_p99, error_rate, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of measurements) {
    insertMeas.run(
      randomUUID(),
      sourceId,
      m.ts,
      req.logWindowS ?? req.labWindowS ?? req.prometheusStepS ?? 2,
      m.lambdaObs,
      m.wMean,
      m.wP50,
      m.wP95,
      m.wP99,
      m.errorRate,
      m.provenance,
    );
  }

  // Calibrar mu efectivo y su intervalo de confianza según la fuente real
  let effectiveMu = muBase;
  let muCiLow = fittingResult?.muCiLow;
  let muCiHigh = fittingResult?.muCiHigh;
  let effectiveObjective: ObjectiveConfig = { ...req.objective };

  if ((req.sourceKind === 'LOG' || req.sourceKind === 'PROMETHEUS') && fittingResult && !req.muOverride) {
    effectiveMu = fittingResult.muEstimated;
  } else if (req.sourceKind === 'PROBE' && probeMeta) {
    const s0 = Math.max(0.0005, probeMeta.baselineLatencyS);
    const sLow = Math.max(0.0005, probeMeta.baselineCiLowS);
    const sHigh = Math.max(sLow, probeMeta.baselineCiHighS);

    if (req.muOverride) {
      effectiveMu = req.muOverride;
      muCiLow = effectiveMu * 0.93;
      muCiHigh = effectiveMu * 1.07;
      probeCalibration = {
        method: 'MANUAL_OVERRIDE',
        s0Ms: Number((s0 * 1000).toFixed(2)),
        s0CiLowMs: Number((sLow * 1000).toFixed(2)),
        s0CiHighMs: Number((sHigh * 1000).toFixed(2)),
        muCalibrated: Number(effectiveMu.toFixed(4)),
        muCiLow: Number(muCiLow.toFixed(4)),
        muCiHigh: Number(muCiHigh.toFixed(4)),
        workersUsed: cVal,
        autoAdjustedT: false,
        requestedTargetLatencyS: req.objective.targetLatencyS,
        effectiveTargetLatencyS: req.objective.targetLatencyS,
        httpSignals: probeMeta.httpSignals,
      };
    } else if (fittingResult && fittingResult.adequacyMM1.adequate && fittingResult.rSquared >= 0.7) {
      effectiveMu = fittingResult.muEstimated;
      muCiLow = fittingResult.muCiLow;
      muCiHigh = fittingResult.muCiHigh;
      probeCalibration = {
        method: 'THEIL_SEN_PROBE',
        s0Ms: Number((s0 * 1000).toFixed(2)),
        s0CiLowMs: Number((sLow * 1000).toFixed(2)),
        s0CiHighMs: Number((sHigh * 1000).toFixed(2)),
        muCalibrated: Number(effectiveMu.toFixed(4)),
        muCiLow: Number(muCiLow.toFixed(4)),
        muCiHigh: Number(muCiHigh.toFixed(4)),
        workersUsed: cVal,
        autoAdjustedT: false,
        requestedTargetLatencyS: req.objective.targetLatencyS,
        effectiveTargetLatencyS: req.objective.targetLatencyS,
        httpSignals: probeMeta.httpSignals,
      };
    } else {
      // Calibración directa desde latencia real medida S₀:
      // En M/M/c, μ es la capacidad por worker (1/S₀) y la capacidad total es c/S₀.
      // En M/M/1, M/M/1/K y M/G/1, usamos 1/S₀ por worker (o c/S₀ si se modelan c hilos equivalentes).
      const perWorkerMu = Math.max(0.2, 1 / s0);
      const perWorkerCiLow = Math.max(0.15, 1 / sHigh);
      const perWorkerCiHigh = Math.max(perWorkerMu, 1 / sLow);

      effectiveMu = req.model === 'MMC' ? perWorkerMu : perWorkerMu * cVal;
      muCiLow = req.model === 'MMC' ? perWorkerCiLow : perWorkerCiLow * cVal;
      muCiHigh = req.model === 'MMC' ? perWorkerCiHigh : perWorkerCiHigh * cVal;

      probeCalibration = {
        method: 'BASELINE_1_OVER_S0',
        s0Ms: Number((s0 * 1000).toFixed(2)),
        s0CiLowMs: Number((sLow * 1000).toFixed(2)),
        s0CiHighMs: Number((sHigh * 1000).toFixed(2)),
        muCalibrated: Number(effectiveMu.toFixed(4)),
        muCiLow: Number(muCiLow.toFixed(4)),
        muCiHigh: Number(muCiHigh.toFixed(4)),
        workersUsed: cVal,
        autoAdjustedT: false,
        requestedTargetLatencyS: req.objective.targetLatencyS,
        effectiveTargetLatencyS: req.objective.targetLatencyS,
        httpSignals: probeMeta.httpSignals,
      };
    }

    if (req.autoTargetLatency) {
      const autoT = Number(Math.max(req.objective.targetLatencyS, Math.max(0.05, s0 * 2.5)).toFixed(3));
      if (autoT > req.objective.targetLatencyS) {
        effectiveObjective = { ...req.objective, targetLatencyS: autoT };
        if (probeCalibration) {
          probeCalibration.autoAdjustedT = true;
          probeCalibration.effectiveTargetLatencyS = autoT;
        }
      }
    }

    // Persistir la calibración real en el perfil de infraestructura del sitio web
    db.db
      .prepare(
        `UPDATE infrastructure_profiles
         SET c = ?, K = ?, timeout_s = ?, mu_declared = ?, mu_source = ?, service_cv = ?, slo_ms = ?, updated_at = ?
         WHERE target_id = ?`,
      )
      .run(
        cVal,
        kVal,
        effectiveObjective.targetLatencyS,
        Number(effectiveMu.toFixed(4)),
        'PROBE_CALIBRATED',
        probeMeta.estimatedServiceCv,
        Number((effectiveObjective.targetLatencyS * 1000).toFixed(1)),
        nowIso,
        req.targetId,
      );
  }

  const empiricalPoints = buildSortedEmpiricalPoints(measurements);

  const queueParams: QueueParams = {
    mu: effectiveMu,
    c: cVal,
    K: kVal,
    cv: probeMeta ? probeMeta.estimatedServiceCv : fittingResult ? fittingResult.cvEstimated : cvVal,
    empiricalPoints,
  };

  const tol = req.tol ?? 1e-12;
  const solved = solveThresholdComparison({
    modelType: req.model,
    params: queueParams,
    objective: effectiveObjective,
    newtonSeed: req.newtonSeed,
    secantSeeds: req.secantSeeds,
    tolF: tol,
    tolX: tol,
  });

  const expId = randomUUID();
  db.db
    .prepare(
      `INSERT INTO experiments (id, target_id, source_id, objective, model, params_json, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      expId,
      target.id,
      sourceId,
      effectiveObjective.type,
      req.model,
      JSON.stringify({
        params: queueParams,
        objective: effectiveObjective,
        fitting: fittingResult ?? null,
        simSummary: simTotals ?? null,
        probeMeta: probeMeta ?? null,
        probeCalibration: probeCalibration ?? null,
        logSummary: logSummary ?? null,
      }),
      'COMPLETED',
      actor,
      nowIso,
    );

  db.saveSolverRun(
    expId,
    solved.newton,
    req.newtonSeed !== undefined ? [req.newtonSeed] : [solved.newton.iterations[0]?.x ?? effectiveMu * 0.5],
    tol,
  );
  db.saveSolverRun(
    expId,
    solved.secant,
    req.secantSeeds ?? [
      solved.secant.iterations[0]?.x ?? effectiveMu * 0.4,
      solved.secant.iterations[1]?.x ?? effectiveMu * 0.6,
    ],
    tol,
  );
  db.saveSolverRun(expId, solved.bisection, [solved.domain[0], solved.domain[1]], tol);

  const maxObservedLambda = measurements.length > 0 ? Math.max(...measurements.map((m) => m.lambdaObs)) : 0;
  const prediction = predictWithConfidence({
    modelType: req.model,
    params: queueParams,
    objective: effectiveObjective,
    muCiLow,
    muCiHigh,
    maxObservedLambda,
    rSquared: fittingResult?.rSquared,
    sampleCount: probeMeta ? probeMeta.totalRequests : measurements.length,
    empiricalPoints,
  });

  db.db
    .prepare(
      `INSERT INTO predictions (id, experiment_id, lambda_star, ci_low, ci_high, confidence_level, extrapolated, extrapolation_warning, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      expId,
      prediction.lambdaStar,
      prediction.ciLow,
      prediction.ciHigh,
      prediction.confidenceLevel,
      prediction.extrapolated ? 1 : 0,
      prediction.extrapolationWarning,
      'PREDICTED',
      nowIso,
    );

  const lastLambda = measurements.length > 0 ? measurements[measurements.length - 1].lambdaObs : 0;
  const firstLambda = measurements.length > 0 ? measurements[0].lambdaObs : 0;
  const trendPerMin = measurements.length > 1 ? ((lastLambda - firstLambda) / Math.max(1, measurements.length)) * 12 : 0;

  const alerts = evaluatePreventiveAlerts({
    currentLambda: lastLambda,
    muTotal: req.model === 'MMC' ? effectiveMu * cVal : effectiveMu,
    lambdaStar: prediction.lambdaStar,
    lambdaTrendPerMin: trendPerMin,
  });
  const insertAlert = db.db.prepare(
    'INSERT INTO alerts (id, experiment_id, severity, rule, message, ts) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const a of alerts) {
    insertAlert.run(randomUUID(), expId, a.severity, a.rule, a.message, nowIso);
  }

  db.appendAudit(actor, 'EXPERIMENT_EXECUTED', target.id, {
    experimentId: expId,
    sourceKind: req.sourceKind,
    model: req.model,
    objective: effectiveObjective.type,
    effectiveMu: Number(effectiveMu.toFixed(4)),
    lambdaStar: prediction.lambdaStar,
    extrapolated: prediction.extrapolated,
  });

  const detail = getExperimentDetail(db, expId);
  if (!detail) throw new Error('Error recuperando experimento recién guardado.');

  req.emitWs?.('experiment_completed', { experimentId: expId, targetId: target.id, prediction });

  return {
    detail,
    fitting: fittingResult,
    logSummary,
    probeMeta,
    probeCalibration,
  };
}
