import type { EmpiricalPoint, QueueModel, QueueModelType, QueueParams } from './types';

/**
 * Calcula Erlang B de forma numéricamente estable por recurrencia:
 * B(0, a) = 1
 * B(k, a) = (a * B(k-1, a)) / (k + a * B(k-1, a))
 */
export function erlangB(c: number, a: number): number {
  if (c <= 0) return 1;
  if (a <= 0) return 0;
  let b = 1;
  for (let k = 1; k <= c; k++) {
    b = (a * b) / (k + a * b);
  }
  return b;
}

/**
 * Calcula Erlang C (probabilidad de esperar en cola para M/M/c):
 * C(c, a) = B(c, a) / (1 - rho * (1 - B(c, a))), donde rho = a / c < 1.
 */
export function erlangC(c: number, a: number): number {
  const rho = a / c;
  if (rho >= 1) return 1;
  if (a <= 0) return 0;
  const b = erlangB(c, a);
  const denom = 1 - rho * (1 - b);
  if (denom <= 0) return 1;
  return b / denom;
}

/**
 * Interpolación monótona PCHIP (Fritsch-Carlson) implementada desde cero.
 * Garantiza interpolación C^1 que preserva monotonicidad en puntos medidos.
 */
export function buildPchipEvaluator(rawPoints: EmpiricalPoint[]): {
  evaluate: (x: number) => number;
  domain: [number, number];
} {
  const sorted = [...rawPoints]
    .filter((p) => Number.isFinite(p.lambda) && Number.isFinite(p.latency) && p.lambda >= 0 && p.latency > 0)
    .sort((a, b) => a.lambda - b.lambda);

  // Deduplicar lambdas muy cercanas promediando
  const pts: EmpiricalPoint[] = [];
  for (const p of sorted) {
    const last = pts[pts.length - 1];
    if (last && Math.abs(p.lambda - last.lambda) < 1e-9) {
      last.latency = (last.latency + p.latency) / 2;
    } else {
      pts.push({ ...p });
    }
  }

  if (pts.length < 2) {
    const baseVal = pts[0]?.latency ?? 0.01;
    const minX = pts[0]?.lambda ?? 0;
    return {
      evaluate: (x: number) => {
        if (x < 0) return Number.NaN;
        return baseVal;
      },
      domain: [minX, Math.max(minX + 100, 100)],
    };
  }

  const n = pts.length;
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const hi = pts[i + 1].lambda - pts[i].lambda;
    h.push(hi);
    delta.push((pts[i + 1].latency - pts[i].latency) / hi);
  }

  const d = new Array<number>(n).fill(0);
  if (n === 2) {
    d[0] = delta[0];
    d[1] = delta[0];
  } else {
    for (let i = 1; i < n - 1; i++) {
      if (delta[i - 1] * delta[i] > 0) {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
      } else {
        d[i] = 0;
      }
    }
    // Derivadas en extremos con fórmula no centrada de 3 puntos con recorte monótono
    d[0] = ((2 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1]);
    if (d[0] * delta[0] <= 0) {
      d[0] = 0;
    } else if (Math.abs(delta[0]) > 0 && Math.abs(d[0]) > 3 * Math.abs(delta[0])) {
      d[0] = 3 * delta[0];
    }

    const m = n - 1;
    d[m] = ((2 * h[m - 1] + h[m - 2]) * delta[m - 1] - h[m - 1] * delta[m - 2]) / (h[m - 1] + h[m - 2]);
    if (d[m] * delta[m - 1] <= 0) {
      d[m] = 0;
    } else if (Math.abs(delta[m - 1]) > 0 && Math.abs(d[m]) > 3 * Math.abs(delta[m - 1])) {
      d[m] = 3 * delta[m - 1];
    }
  }

  const minX = pts[0].lambda;
  const maxX = pts[n - 1].lambda;

  return {
    domain: [0, maxX * 1.5],
    evaluate: (x: number): number => {
      if (!Number.isFinite(x) || x < 0) return Number.NaN;
      if (x <= minX) {
        // Extrapolación lineal suave hacia 0 manteniendo pendiente en extremo izquierdo
        return Math.max(1e-6, pts[0].latency + d[0] * (x - minX));
      }
      if (x >= maxX) {
        // Extrapolación lineal conservadora más allá del último punto observado
        return Math.max(1e-6, pts[n - 1].latency + Math.max(d[n - 1], 1e-4) * (x - maxX));
      }
      // Búsqueda binaria del intervalo
      let lo = 0;
      let hi = n - 2;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (x >= pts[mid].lambda && x <= pts[mid + 1].lambda) {
          const t = (x - pts[mid].lambda) / h[mid];
          const t2 = t * t;
          const t3 = t2 * t;
          const h00 = 2 * t3 - 3 * t2 + 1;
          const h10 = t3 - 2 * t2 + t;
          const h01 = -2 * t3 + 3 * t2;
          const h11 = t3 - t2;
          return (
            h00 * pts[mid].latency +
            h10 * h[mid] * d[mid] +
            h01 * pts[mid + 1].latency +
            h11 * h[mid] * d[mid + 1]
          );
        }
        if (x < pts[mid].lambda) hi = mid - 1;
        else lo = mid + 1;
      }
      return pts[n - 1].latency;
    },
  };
}

export const MM1Model: QueueModel = {
  type: 'MM1',
  label: 'M/M/1 (Modelo base)',
  hasAnalyticalDerivative: true,
  domain(params: QueueParams): [number, number] {
    return [0, params.mu];
  },
  utilization(lambda: number, params: QueueParams): number {
    return lambda / params.mu;
  },
  latency(lambda: number, params: QueueParams): number {
    if (!Number.isFinite(lambda) || lambda < 0 || lambda >= params.mu) {
      return Number.NaN;
    }
    return 1 / (params.mu - lambda);
  },
  latencyDerivative(lambda: number, params: QueueParams): number | null {
    if (!Number.isFinite(lambda) || lambda < 0 || lambda >= params.mu) {
      return Number.NaN;
    }
    const diff = params.mu - lambda;
    return 1 / (diff * diff);
  },
  percentileLatency(lambda: number, p: number, params: QueueParams): number | null {
    if (lambda < 0 || lambda >= params.mu || p <= 0 || p >= 1) return Number.NaN;
    return -Math.log(1 - p) / (params.mu - lambda);
  },
  timeoutProbability(lambda: number, t: number, params: QueueParams): number | null {
    if (lambda < 0 || lambda >= params.mu || t < 0) return Number.NaN;
    return Math.exp(-(params.mu - lambda) * t);
  },
  blockingProbability(): number {
    return 0;
  },
};

export const MM1KModel: QueueModel = {
  type: 'MM1K',
  label: 'M/M/1/K (Cola finita)',
  hasAnalyticalDerivative: false,
  domain(params: QueueParams): [number, number] {
    // En M/M/1/K el sistema es estable para cualquier lambda >= 0; acotamos dominio práctico a 5*mu
    return [0, params.mu * 5];
  },
  utilization(lambda: number, params: QueueParams): number {
    return lambda / params.mu;
  },
  blockingProbability(lambda: number, params: QueueParams): number {
    const K = Math.max(1, Math.round(params.K ?? 20));
    if (lambda <= 0) return 0;
    const rho = lambda / params.mu;
    if (Math.abs(rho - 1) < 1e-8) {
      return 1 / (K + 1);
    }
    const rhoK = Math.pow(rho, K);
    const rhoK1 = rhoK * rho;
    if (!Number.isFinite(rhoK1)) return 1 - 1 / rho;
    return ((1 - rho) * rhoK) / (1 - rhoK1);
  },
  latency(lambda: number, params: QueueParams): number {
    const K = Math.max(1, Math.round(params.K ?? 20));
    if (!Number.isFinite(lambda) || lambda < 0) return Number.NaN;
    if (lambda === 0) return 1 / params.mu;
    const rho = lambda / params.mu;
    if (Math.abs(rho - 1) < 1e-8) {
      return (K + 1) / (2 * params.mu);
    }
    const rhoK = Math.pow(rho, K);
    const rhoK1 = rhoK * rho;
    if (!Number.isFinite(rhoK1)) {
      return K / params.mu;
    }
    const L = (rho * (1 - (K + 1) * rhoK + K * rhoK1)) / ((1 - rho) * (1 - rhoK1));
    const pb = ((1 - rho) * rhoK) / (1 - rhoK1);
    const lambdaEff = lambda * (1 - pb);
    if (lambdaEff <= 0) return K / params.mu;
    return L / lambdaEff;
  },
  latencyDerivative(): number | null {
    return null;
  },
  percentileLatency(lambda: number, p: number, params: QueueParams): number | null {
    const w = this.latency(lambda, params);
    if (!Number.isFinite(w)) return Number.NaN;
    return w * (-Math.log(1 - p));
  },
  timeoutProbability(lambda: number, t: number, params: QueueParams): number | null {
    const w = this.latency(lambda, params);
    if (!Number.isFinite(w) || w <= 0) return Number.NaN;
    return Math.exp(-t / w);
  },
};

export const MMCModel: QueueModel = {
  type: 'MMC',
  label: 'M/M/c (Erlang C)',
  hasAnalyticalDerivative: false,
  domain(params: QueueParams): [number, number] {
    const c = Math.max(1, Math.round(params.c ?? 2));
    return [0, c * params.mu];
  },
  utilization(lambda: number, params: QueueParams): number {
    const c = Math.max(1, Math.round(params.c ?? 2));
    return lambda / (c * params.mu);
  },
  latency(lambda: number, params: QueueParams): number {
    const c = Math.max(1, Math.round(params.c ?? 2));
    const cap = c * params.mu;
    if (!Number.isFinite(lambda) || lambda < 0 || lambda >= cap) {
      return Number.NaN;
    }
    if (lambda === 0) return 1 / params.mu;
    const a = lambda / params.mu;
    const ec = erlangC(c, a);
    const wq = ec / (cap - lambda);
    return wq + 1 / params.mu;
  },
  latencyDerivative(): number | null {
    // La derivada analítica de Erlang C no es cómoda; caso natural para la Secante
    return null;
  },
  percentileLatency(lambda: number, p: number, params: QueueParams): number | null {
    const c = Math.max(1, Math.round(params.c ?? 2));
    const cap = c * params.mu;
    if (lambda < 0 || lambda >= cap || p <= 0 || p >= 1) return Number.NaN;
    const w = this.latency(lambda, params);
    return w * (-Math.log(1 - p));
  },
  timeoutProbability(lambda: number, t: number, params: QueueParams): number | null {
    const c = Math.max(1, Math.round(params.c ?? 2));
    const cap = c * params.mu;
    if (lambda < 0 || lambda >= cap || t < 0) return Number.NaN;
    const a = lambda / params.mu;
    const ec = erlangC(c, a);
    // P(Wq > t) = C(c,a) * exp(-(c*mu - lambda)*t); aproximación de sistema total
    const pWait = ec * Math.exp(-(cap - lambda) * t);
    const pServ = Math.exp(-params.mu * t);
    return Math.min(1, Math.max(pWait, pServ));
  },
  blockingProbability(): number {
    return 0;
  },
};

export const MG1Model: QueueModel = {
  type: 'MG1',
  label: 'M/G/1 (Pollaczek-Khinchine)',
  hasAnalyticalDerivative: true,
  domain(params: QueueParams): [number, number] {
    return [0, params.mu];
  },
  utilization(lambda: number, params: QueueParams): number {
    return lambda / params.mu;
  },
  latency(lambda: number, params: QueueParams): number {
    if (!Number.isFinite(lambda) || lambda < 0 || lambda >= params.mu) {
      return Number.NaN;
    }
    const cv = Math.max(0, params.cv ?? 1);
    const rho = lambda / params.mu;
    const wq = (rho * (1 + cv * cv)) / (2 * params.mu * (1 - rho));
    return wq + 1 / params.mu;
  },
  latencyDerivative(lambda: number, params: QueueParams): number | null {
    if (!Number.isFinite(lambda) || lambda < 0 || lambda >= params.mu) {
      return Number.NaN;
    }
    const cv = Math.max(0, params.cv ?? 1);
    const diff = params.mu - lambda;
    return (1 + cv * cv) / (2 * diff * diff);
  },
  percentileLatency(lambda: number, p: number, params: QueueParams): number | null {
    const w = this.latency(lambda, params);
    if (!Number.isFinite(w) || p <= 0 || p >= 1) return Number.NaN;
    return w * (-Math.log(1 - p));
  },
  timeoutProbability(lambda: number, t: number, params: QueueParams): number | null {
    const w = this.latency(lambda, params);
    if (!Number.isFinite(w) || w <= 0 || t < 0) return Number.NaN;
    return Math.exp(-t / w);
  },
  blockingProbability(): number {
    return 0;
  },
};

export const EmpiricalModel: QueueModel = {
  type: 'EMPIRICAL',
  label: 'Modelo Empírico (PCHIP)',
  hasAnalyticalDerivative: false,
  domain(params: QueueParams): [number, number] {
    const pts = params.empiricalPoints ?? [];
    if (pts.length < 2) return [0, Math.max(params.mu, 100)];
    const maxObs = Math.max(...pts.map((p) => p.lambda));
    return [0, Math.max(maxObs * 1.5, params.mu)];
  },
  utilization(lambda: number, params: QueueParams): number {
    return params.mu > 0 ? lambda / params.mu : 0;
  },
  latency(lambda: number, params: QueueParams): number {
    const pts = params.empiricalPoints ?? [];
    if (pts.length < 2) {
      return MM1Model.latency(lambda, params);
    }
    const ev = buildPchipEvaluator(pts);
    return ev.evaluate(lambda);
  },
  latencyDerivative(): number | null {
    return null;
  },
  percentileLatency(lambda: number, p: number, params: QueueParams): number | null {
    const w = this.latency(lambda, params);
    if (!Number.isFinite(w) || p <= 0 || p >= 1) return Number.NaN;
    return w * (-Math.log(1 - p));
  },
  timeoutProbability(lambda: number, t: number, params: QueueParams): number | null {
    const w = this.latency(lambda, params);
    if (!Number.isFinite(w) || w <= 0 || t < 0) return Number.NaN;
    return Math.exp(-t / w);
  },
  blockingProbability(): number {
    return 0;
  },
};

export function getQueueModel(type: QueueModelType): QueueModel {
  switch (type) {
    case 'MM1':
      return MM1Model;
    case 'MM1K':
      return MM1KModel;
    case 'MMC':
      return MMCModel;
    case 'MG1':
      return MG1Model;
    case 'EMPIRICAL':
      return EmpiricalModel;
  }
}
