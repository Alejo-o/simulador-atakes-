import { solveThresholdComparison } from './solvers';
import type { EmpiricalPoint, ObjectiveConfig, QueueModelType, QueueParams } from './types';

export interface WindowedMeasurement {
  ts: string;
  lambdaObs: number;
  wMean: number;
  wP50: number;
  wP95: number;
  wP99: number;
  errorRate: number;
}

export interface FittingResult {
  muEstimated: number;
  muCiLow: number;
  muCiHigh: number;
  rSquared: number;
  rmseLatency: number;
  residuals: Array<{ lambda: number; observedW: number; predictedW: number; residual: number }>;
  adequacyMM1: {
    adequate: boolean;
    reason: string;
    suggestedModel: QueueModelType;
  };
  cvEstimated: number;
  maxObservedLambda: number;
}

export interface PredictionWithConfidence {
  lambdaStar: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  confidenceLevel: 'ALTA' | 'MEDIA' | 'BAJA';
  extrapolated: boolean;
  extrapolationWarning: string | null;
}

export interface PreventiveAlert {
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  rule: string;
  message: string;
}

function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return quantileSorted(s, 0.5);
}

/**
 * Regresión robusta (Theil-Sen) sobre la transformación lineal M/M/1:
 *   1 / W = mu - slope * lambda  (teóricamente slope = 1, intercept = mu)
 * También estima mu directo por mediana de (lambda + 1/W) y compara ambas.
 */
export function fitRobustMM1(measurements: WindowedMeasurement[]): FittingResult {
  const valid = measurements.filter(
    (m) => Number.isFinite(m.lambdaObs) && Number.isFinite(m.wMean) && m.lambdaObs >= 0 && m.wMean > 1e-6,
  );

  if (valid.length === 0) {
    return {
      muEstimated: 100,
      muCiLow: 90,
      muCiHigh: 110,
      rSquared: 0,
      rmseLatency: 0,
      residuals: [],
      adequacyMM1: {
        adequate: false,
        reason: 'No hay suficientes ventanas válidas para ajustar el modelo.',
        suggestedModel: 'MM1',
      },
      cvEstimated: 1,
      maxObservedLambda: 0,
    };
  }

  const maxObservedLambda = Math.max(...valid.map((v) => v.lambdaObs));

  // Estimador directo por punto: mu_i = lambda_i + 1 / W_i
  const pointMus = valid.map((v) => v.lambdaObs + 1 / v.wMean);

  // Si hay suficiente variación en lambda, usamos Theil-Sen sobre y = 1/W vs x = lambda
  const lambdas = valid.map((v) => v.lambdaObs);
  const lambdaRange = Math.max(...lambdas) - Math.min(...lambdas);
  let muEstimated: number;

  if (valid.length >= 4 && lambdaRange > 1e-3) {
    const slopes: number[] = [];
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const dx = valid[j].lambdaObs - valid[i].lambdaObs;
        if (Math.abs(dx) > 1e-6) {
          const dy = 1 / valid[j].wMean - 1 / valid[i].wMean;
          slopes.push(dy / dx);
        }
      }
    }
    const rawSlope = slopes.length > 0 ? median(slopes) : -1;
    // En M/M/1 1/W = mu - lambda => pendiente negativa esperada; usamos pendiente robusta acotada
    const effectiveSlope = rawSlope < -0.1 && rawSlope > -3.0 ? rawSlope : -1;
    const intercepts = valid.map((v) => 1 / v.wMean - effectiveSlope * v.lambdaObs);
    const theilMu = median(intercepts);
    const directMu = median(pointMus);
    // Combinamos si la pendiente está cerca de -1, o preferimos el punto donde W crece con lambda
    muEstimated = Math.max(maxObservedLambda * 1.02, Math.abs(effectiveSlope + 1) < 0.45 ? theilMu : directMu);
  } else {
    muEstimated = Math.max(maxObservedLambda * 1.05, median(pointMus));
  }

  // Bootstrap determinístico (PRNG LCG) para intervalo de confianza de mu al 95%
  let seed = 421337;
  const rand = (): number => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const bootMus: number[] = [];
  const B = 200;
  for (let b = 0; b < B; b++) {
    const sampleMus: number[] = [];
    for (let k = 0; k < valid.length; k++) {
      const idx = Math.floor(rand() * valid.length);
      const v = valid[idx];
      sampleMus.push(v.lambdaObs + 1 / v.wMean);
    }
    bootMus.push(Math.max(maxObservedLambda * 1.01, median(sampleMus)));
  }
  bootMus.sort((a, b) => a - b);
  const muCiLow = quantileSorted(bootMus, 0.025);
  const muCiHigh = quantileSorted(bootMus, 0.975);

  // Bondad de ajuste R^2 en la escala W(lambda) o 1/W(lambda)
  const residuals = valid.map((v) => {
    const safeLambda = Math.min(v.lambdaObs, muEstimated * 0.995);
    const predictedW = 1 / Math.max(1e-6, muEstimated - safeLambda);
    return {
      lambda: v.lambdaObs,
      observedW: v.wMean,
      predictedW,
      residual: v.wMean - predictedW,
    };
  });

  const meanW = valid.reduce((acc, v) => acc + v.wMean, 0) / valid.length;
  const ssTot = valid.reduce((acc, v) => acc + Math.pow(v.wMean - meanW, 2), 0);
  const ssRes = residuals.reduce((acc, r) => acc + Math.pow(r.residual, 2), 0);
  const rSquared = ssTot > 1e-12 ? Math.max(-1, Math.min(1, 1 - ssRes / ssTot)) : 1;
  const rmseLatency = Math.sqrt(ssRes / valid.length);

  // Estimar CV aproximado desde ratio p95/mean (en exponencial p95/mean ≈ -ln(0.05) ≈ 2.9957)
  const ratios = valid
    .filter((v) => v.wP95 > 0 && v.wMean > 0)
    .map((v) => v.wP95 / v.wMean);
  const medRatio = ratios.length > 0 ? median(ratios) : 2.9957;
  const cvEstimated = Math.max(0.1, Math.min(4.0, medRatio / 2.9957));

  let adequate = true;
  let reason = 'Los residuos y la dispersión de latencia son consistentes con un régimen M/M/1.';
  let suggestedModel: QueueModelType = 'MM1';

  if (lambdaRange < 0.05 * muEstimated) {
    adequate = false;
    reason =
      'Rango de carga observada muy estrecho (típico de sondeo de baja intensidad ≤5 req/s): no permite identificar μ con certeza sin perfil declarado o logs con carga variada.';
    suggestedModel = 'MM1';
  } else if (rSquared < 0.7) {
    adequate = false;
    if (cvEstimated > 1.35 || cvEstimated < 0.7) {
      reason = `Ajuste M/M/1 insuficiente (R²=${rSquared.toFixed(3)}, CV≈${cvEstimated.toFixed(2)}). Se sugiere M/G/1 (Pollaczek-Khinchine) para capturar variabilidad no exponencial.`;
      suggestedModel = 'MG1';
    } else {
      reason = `Ajuste M/M/1 insuficiente (R²=${rSquared.toFixed(3)}). Si la infraestructura posee múltiples trabajadores, pruebe M/M/c (Erlang C) o el modelo Empírico.`;
      suggestedModel = 'MMC';
    }
  }

  return {
    muEstimated: Number(muEstimated.toFixed(4)),
    muCiLow: Number(muCiLow.toFixed(4)),
    muCiHigh: Number(muCiHigh.toFixed(4)),
    rSquared: Number(rSquared.toFixed(4)),
    rmseLatency: Number(rmseLatency.toFixed(6)),
    residuals,
    adequacyMM1: { adequate, reason, suggestedModel },
    cvEstimated: Number(cvEstimated.toFixed(3)),
    maxObservedLambda: Number(maxObservedLambda.toFixed(4)),
  };
}

/**
 * Propaga los intervalos de confianza de μ a la predicción de λ* y verifica extrapolación.
 */
export function predictWithConfidence(input: {
  modelType: QueueModelType;
  params: QueueParams;
  objective: ObjectiveConfig;
  muCiLow?: number;
  muCiHigh?: number;
  maxObservedLambda?: number;
  rSquared?: number;
  sampleCount?: number;
  empiricalPoints?: EmpiricalPoint[];
}): PredictionWithConfidence {
  const solved = solveThresholdComparison({
    modelType: input.modelType,
    params: { ...input.params, empiricalPoints: input.empiricalPoints ?? input.params.empiricalPoints },
    objective: input.objective,
  });

  const bestRoot = solved.secant.converged
    ? solved.secant.root
    : solved.newton.converged
      ? solved.newton.root
      : solved.bisection.converged
        ? solved.bisection.root
        : null;

  if (bestRoot === null) {
    return {
      lambdaStar: null,
      ciLow: null,
      ciHigh: null,
      confidenceLevel: 'BAJA',
      extrapolated: false,
      extrapolationWarning: solved.noPositiveRootReason ?? 'No se encontró raíz convergente válida.',
    };
  }

  const lowMu = input.muCiLow ?? input.params.mu * 0.93;
  const highMu = input.muCiHigh ?? input.params.mu * 1.07;

  const solvedLow = solveThresholdComparison({
    modelType: input.modelType,
    params: { ...input.params, mu: lowMu },
    objective: input.objective,
  });
  const solvedHigh = solveThresholdComparison({
    modelType: input.modelType,
    params: { ...input.params, mu: highMu },
    objective: input.objective,
  });

  const rootLow = solvedLow.secant.root ?? solvedLow.newton.root ?? bestRoot * 0.93;
  const rootHigh = solvedHigh.secant.root ?? solvedHigh.newton.root ?? bestRoot * 1.07;

  const ciLow = Math.min(rootLow, rootHigh, bestRoot);
  const ciHigh = Math.max(rootLow, rootHigh, bestRoot);

  const maxObs = input.maxObservedLambda ?? 0;
  const extrapolated = maxObs > 0 ? bestRoot > maxObs : true;

  let confidenceLevel: 'ALTA' | 'MEDIA' | 'BAJA' = 'MEDIA';
  const r2 = input.rSquared ?? 0.9;
  const n = input.sampleCount ?? 20;

  if (!extrapolated && r2 >= 0.85 && n >= 15) {
    confidenceLevel = 'ALTA';
  } else if (extrapolated && (maxObs === 0 || bestRoot > maxObs * 2.5 || r2 < 0.7 || n < 6)) {
    confidenceLevel = 'BAJA';
  }

  const extrapolationWarning = extrapolated
    ? maxObs > 0
      ? `EXTRAPOLACIÓN: λ* predicho (${bestRoot.toFixed(2)} req/s) supera la carga máxima observada (${maxObs.toFixed(2)} req/s). Confianza: ${confidenceLevel}.`
      : `EXTRAPOLACIÓN: predicción basada en parámetros teóricos/declarados sin observaciones hasta λ*=${bestRoot.toFixed(2)} req/s. Confianza: ${confidenceLevel}.`
    : null;

  return {
    lambdaStar: Number(bestRoot.toFixed(4)),
    ciLow: Number(ciLow.toFixed(4)),
    ciHigh: Number(ciHigh.toFixed(4)),
    confidenceLevel,
    extrapolated,
    extrapolationWarning,
  };
}

/**
 * Genera alertas preventivas según utilización ρ, riesgo λ_actual / λ* y tendencia dλ/dt.
 */
export function evaluatePreventiveAlerts(input: {
  currentLambda: number;
  muTotal: number;
  lambdaStar: number | null;
  lambdaTrendPerMin?: number;
  rhoThresholds?: [number, number, number];
}): PreventiveAlert[] {
  const alerts: PreventiveAlert[] = [];
  const [tWarn, tHigh, tCrit] = input.rhoThresholds ?? [0.7, 0.85, 0.95];
  const rho = input.muTotal > 0 ? input.currentLambda / input.muTotal : 0;

  if (rho >= tCrit) {
    alerts.push({
      severity: 'CRITICAL',
      rule: `UTILIZACION_GE_${Math.round(tCrit * 100)}`,
      message: `Utilización crítica ρ = ${(rho * 100).toFixed(1)}% (≥ ${Math.round(tCrit * 100)}%). Riesgo inminente de saturación de cola.`,
    });
  } else if (rho >= tHigh) {
    alerts.push({
      severity: 'WARNING',
      rule: `UTILIZACION_GE_${Math.round(tHigh * 100)}`,
      message: `Utilización elevada ρ = ${(rho * 100).toFixed(1)}% (≥ ${Math.round(tHigh * 100)}%). Ventana de latencia en crecimiento no lineal.`,
    });
  } else if (rho >= tWarn) {
    alerts.push({
      severity: 'INFO',
      rule: `UTILIZACION_GE_${Math.round(tWarn * 100)}`,
      message: `Utilización preventiva ρ = ${(rho * 100).toFixed(1)}% (≥ ${Math.round(tWarn * 100)}%).`,
    });
  }

  if (input.lambdaStar !== null && input.lambdaStar > 0) {
    const risk = input.currentLambda / input.lambdaStar;
    if (risk >= 1.0) {
      alerts.push({
        severity: 'CRITICAL',
        rule: 'RIESGO_UMBRAL_SUPERADO',
        message: `Tasa actual (${input.currentLambda.toFixed(2)} req/s) ya supera λ* = ${input.lambdaStar.toFixed(2)} req/s (Riesgo ${(risk * 100).toFixed(1)}%).`,
      });
    } else if (risk >= 0.85) {
      alerts.push({
        severity: 'WARNING',
        rule: 'RIESGO_PROXIMO_A_UMBRAL',
        message: `Riesgo de saturación en ${(risk * 100).toFixed(1)}% de λ* (${input.lambdaStar.toFixed(2)} req/s).`,
      });
    }

    const trend = input.lambdaTrendPerMin ?? 0;
    if (trend > 0.05 && input.currentLambda < input.lambdaStar) {
      const minutesToThreshold = (input.lambdaStar - input.currentLambda) / trend;
      if (minutesToThreshold <= 15) {
        alerts.push({
          severity: minutesToThreshold <= 3 ? 'CRITICAL' : 'WARNING',
          rule: 'TIEMPO_ESTIMADO_UMBRAL',
          message: `Tendencia +${trend.toFixed(2)} req/s·min: se alcanzará λ* en ≈ ${minutesToThreshold.toFixed(1)} min.`,
        });
      }
    }
  }

  return alerts;
}
