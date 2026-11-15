import { getQueueModel } from './queues';
import type { ObjectiveConfig, QueueModelType, QueueParams } from './types';

export interface ObjectiveEvaluation {
  f: (lambda: number) => number;
  df: ((lambda: number) => number) | null;
  domain: [number, number];
  analyticalRoot: number | null;
  noPositiveRootReason: string | null;
}

/**
 * Construye la función objetivo f(lambda) = 0 que define la tasa crítica lambda*.
 */
export function buildObjective(
  modelType: QueueModelType,
  params: QueueParams,
  objective: ObjectiveConfig,
): ObjectiveEvaluation {
  const model = getQueueModel(modelType);
  const domain = model.domain(params);
  const T = objective.targetLatencyS;

  if (objective.type === 'MEAN_LATENCY') {
    const minW = model.latency(0, params);
    let analyticalRoot: number | null = null;
    if (modelType === 'MM1' && T > 1 / params.mu) {
      analyticalRoot = params.mu - 1 / T;
    } else if (modelType === 'MG1' && T > 1 / params.mu) {
      // W(lambda) = (lambda*(1+cv^2))/(2*mu*(mu-lambda)) + 1/mu = T
      // => (T - 1/mu) = lambda*(1+cv^2) / (2*mu*(mu-lambda))
      const cv = Math.max(0, params.cv ?? 1);
      const a = 2 * params.mu * (T - 1 / params.mu);
      analyticalRoot = (a * params.mu) / (a + 1 + cv * cv);
    }

    let noPositiveRootReason: string | null = null;
    if (Number.isFinite(minW) && T <= minW) {
      noPositiveRootReason = `El límite T=${T.toFixed(4)} s es menor o igual que el tiempo base de servicio 1/μ=${minW.toFixed(4)} s; no existe raíz con λ ≥ 0.`;
    } else if (modelType === 'MM1K') {
      const K = Math.max(1, Math.round(params.K ?? 20));
      const maxW = K / params.mu;
      if (T >= maxW) {
        noPositiveRootReason = `En M/M/1/K la latencia máxima acotada es K/μ=${maxW.toFixed(4)} s < T=${T.toFixed(4)} s; el sistema bloquea peticiones antes de superar T.`;
      }
    }

    return {
      f: (lambda: number) => {
        const w = model.latency(lambda, params);
        return Number.isFinite(w) ? w - T : Number.NaN;
      },
      df: model.hasAnalyticalDerivative
        ? (lambda: number) => {
            const dw = model.latencyDerivative(lambda, params);
            return dw !== null && Number.isFinite(dw) ? dw : Number.NaN;
          }
        : null,
      domain,
      analyticalRoot,
      noPositiveRootReason,
    };
  }

  if (objective.type === 'PERCENTILE_LATENCY') {
    const p = Math.min(0.9999, Math.max(0.01, objective.percentile ?? 0.95));
    const minWp = model.percentileLatency(0, p, params);
    let analyticalRoot: number | null = null;
    if (modelType === 'MM1') {
      const candidate = params.mu + Math.log(1 - p) / T;
      analyticalRoot = candidate > 0 ? candidate : null;
    }

    let noPositiveRootReason: string | null = null;
    if (minWp !== null && Number.isFinite(minWp) && T <= minWp) {
      noPositiveRootReason = `El límite T=${T.toFixed(4)} s es menor o igual que el percentil ${(p * 100).toFixed(0)} en reposo (${minWp.toFixed(4)} s); no existe raíz con λ ≥ 0.`;
    }

    return {
      f: (lambda: number) => {
        const wp = model.percentileLatency(lambda, p, params);
        return wp !== null && Number.isFinite(wp) ? wp - T : Number.NaN;
      },
      df:
        modelType === 'MM1'
          ? (lambda: number) => {
              if (lambda < 0 || lambda >= params.mu) return Number.NaN;
              const diff = params.mu - lambda;
              return -Math.log(1 - p) / (diff * diff);
            }
          : null,
      domain,
      analyticalRoot,
      noPositiveRootReason,
    };
  }

  if (objective.type === 'TIMEOUT_PROBABILITY') {
    const eps = Math.min(0.99, Math.max(1e-6, objective.timeoutEpsilon ?? 0.05));
    let analyticalRoot: number | null = null;
    if (modelType === 'MM1') {
      const candidate = params.mu + Math.log(eps) / T;
      analyticalRoot = candidate > 0 ? candidate : null;
    }

    const p0 = model.timeoutProbability(0, T, params);
    let noPositiveRootReason: string | null = null;
    if (p0 !== null && Number.isFinite(p0) && p0 >= eps) {
      noPositiveRootReason = `Incluso sin carga (λ=0), P(W>${T.toFixed(4)}s)=${p0.toFixed(4)} ya supera ε=${eps}; no existe raíz con λ ≥ 0.`;
    }

    return {
      f: (lambda: number) => {
        const prob = model.timeoutProbability(lambda, T, params);
        return prob !== null && Number.isFinite(prob) ? prob - eps : Number.NaN;
      },
      df:
        modelType === 'MM1'
          ? (lambda: number) => {
              if (lambda < 0 || lambda >= params.mu) return Number.NaN;
              return T * Math.exp(-(params.mu - lambda) * T);
            }
          : null,
      domain,
      analyticalRoot,
      noPositiveRootReason,
    };
  }

  // EMPIRICAL_LATENCY: sin derivada analítica
  const empModel = getQueueModel('EMPIRICAL');
  const empDomain = empModel.domain(params);
  const minEmp = empModel.latency(0, params);
  let noPositiveRootReason: string | null = null;
  if (Number.isFinite(minEmp) && T <= minEmp) {
    noPositiveRootReason = `El límite T=${T.toFixed(4)} s no supera la latencia empírica inicial (${minEmp.toFixed(4)} s).`;
  }

  return {
    f: (lambda: number) => {
      const w = empModel.latency(lambda, params);
      return Number.isFinite(w) ? w - T : Number.NaN;
    },
    df: null,
    domain: empDomain,
    analyticalRoot: null,
    noPositiveRootReason,
  };
}
