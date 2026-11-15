import type { Provenance } from '../math/types';

export type TrafficScenario = 'STEADY' | 'RAMP' | 'STEP' | 'PULSE' | 'SURGE';

export interface SimulationConfig {
  scenario: TrafficScenario;
  mu: number; // Tasa de servicio por trabajador (req/s)
  c: number; // Número de trabajadores/servidores
  K: number | null; // Capacidad máxima en sistema (null = cola infinita)
  timeoutS: number; // Tiempo máximo antes de marcar timeout / abandono
  cv: number; // Coeficiente de variación del servicio (1.0 = exponencial)
  lambdaStart: number;
  lambdaPeak: number;
  durationS: number;
  windowS: number;
  seed?: number;
}

export interface SimulationWindowPoint {
  tStart: number;
  tEnd: number;
  ts: string;
  lambdaObs: number;
  wMean: number;
  wP50: number;
  wP95: number;
  wP99: number;
  processed: number;
  rejected: number;
  timeouts: number;
  errorRate: number;
  provenance: Provenance;
}

export interface SimulationSummary {
  windows: SimulationWindowPoint[];
  totalArrivals: number;
  totalProcessed: number;
  totalRejected: number;
  totalTimeouts: number;
  overallMeanLatency: number;
  overallP95Latency: number;
  provenance: Provenance;
}

function createPrng(initialSeed: number): () => number {
  let s = initialSeed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return Math.max(1e-12, s / 4294967296);
  };
}

function sampleExponential(rate: number, rand: () => number): number {
  return -Math.log(rand()) / rate;
}

/**
 * Muestrea tiempo de servicio con media 1/mu y coeficiente de variación CV.
 * - CV = 1 -> Exponencial
 * - CV < 1 -> Erlang / Gamma aproximada (suma de exponenciales + componente determinista)
 * - CV > 1 -> Hiperexponencial de 2 ramas balanceadas
 */
function sampleServiceTime(mu: number, cv: number, rand: () => number): number {
  const mean = 1 / mu;
  if (Math.abs(cv - 1) < 1e-3) {
    return sampleExponential(mu, rand);
  }
  if (cv <= 0.02) {
    return mean;
  }
  if (cv < 1) {
    // Gamma por Marsaglia-Tsang para k = 1 / cv^2 >= 1
    const k = 1 / (cv * cv);
    const theta = mean / k;
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (let attempt = 0; attempt < 100; attempt++) {
      const u1 = rand();
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const v = Math.pow(1 + c * z, 3);
      if (v > 0) {
        const u = rand();
        if (u < 1 - 0.0331 * Math.pow(z, 4) || Math.log(u) < 0.5 * z * z + d * (1 - v + Math.log(v))) {
          return d * v * theta;
        }
      }
    }
    return mean;
  }

  // CV > 1: Hiperexponencial H2 con medias balanceadas
  const cv2 = cv * cv;
  const p = 0.5 * (1 - Math.sqrt((cv2 - 1) / (cv2 + 1)));
  const r1 = 2 * p * mu;
  const r2 = 2 * (1 - p) * mu;
  return rand() < p ? sampleExponential(r1, rand) : sampleExponential(r2, rand);
}

export function scenarioLambdaAt(t: number, cfg: SimulationConfig): number {
  const frac = Math.min(1, Math.max(0, t / Math.max(1e-6, cfg.durationS)));
  const low = Math.max(0.01, cfg.lambdaStart);
  const high = Math.max(low, cfg.lambdaPeak);

  switch (cfg.scenario) {
    case 'STEADY':
      return low;
    case 'RAMP':
      return low + (high - low) * frac;
    case 'STEP':
      return frac < 0.35 ? low : frac < 0.75 ? high : (low + high) * 0.5;
    case 'PULSE':
      return frac >= 0.4 && frac <= 0.6 ? high : low;
    case 'SURGE':
      // Oleada en campana suave
      return low + (high - low) * Math.exp(-Math.pow((frac - 0.55) / 0.18, 2));
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Simulador de Eventos Discretos (DES) en memoria, sin ningún tráfico de red.
 * Implementa proceso de llegadas Poisson inhomogéneo (thinning de Lewis-Shedler),
 * c servidores paralelos, cola finita K, y abandono por timeout T.
 */
export function runDiscreteEventSimulation(
  cfg: SimulationConfig,
  onWindow?: (win: SimulationWindowPoint) => void,
): SimulationSummary {
  const rand = createPrng(cfg.seed ?? 20261112);
  const c = Math.max(1, Math.round(cfg.c));
  const maxQueueOnly = cfg.K !== null && cfg.K > 0 ? Math.max(0, Math.round(cfg.K) - c) : Number.POSITIVE_INFINITY;
  const windowS = Math.max(0.25, cfg.windowS);
  const numWindows = Math.max(1, Math.ceil(cfg.durationS / windowS));
  const lambdaMax = Math.max(cfg.lambdaStart, cfg.lambdaPeak, 0.1);

  // Generar llegadas mediante adelgazamiento (thinning) de proceso Poisson no homogéneo
  const arrivals: number[] = [];
  let tGen = 0;
  while (tGen < cfg.durationS) {
    tGen += sampleExponential(lambdaMax, rand);
    if (tGen >= cfg.durationS) break;
    const rateT = scenarioLambdaAt(tGen, cfg);
    if (rand() <= rateT / lambdaMax) {
      arrivals.push(tGen);
    }
  }

  // Estado del sistema de colas
  const serverFreeAt = new Array<number>(c).fill(0);
  const queueArrivals: number[] = [];

  interface WindowBucket {
    latencies: number[];
    arrivals: number;
    processed: number;
    rejected: number;
    timeouts: number;
  }

  const buckets: WindowBucket[] = Array.from({ length: numWindows }, () => ({
    latencies: [],
    arrivals: 0,
    processed: 0,
    rejected: 0,
    timeouts: 0,
  }));

  const allLatencies: number[] = [];
  let totalProcessed = 0;
  let totalRejected = 0;
  let totalTimeouts = 0;

  // Procesar eventos cronológicamente: cada llegada avanza servidores y cola hasta tArr
  const dispatchUpTo = (tLimit: number): void => {
    while (queueArrivals.length > 0) {
      // Buscar servidor que se libera más pronto
      let minIdx = 0;
      for (let i = 1; i < c; i++) {
        if (serverFreeAt[i] < serverFreeAt[minIdx]) minIdx = i;
      }
      const nextFree = serverFreeAt[minIdx];
      if (nextFree > tLimit) break;

      const arrTime = queueArrivals.shift()!;
      const waitSoFar = Math.max(0, nextFree - arrTime);
      const bIdx = Math.min(numWindows - 1, Math.floor(arrTime / windowS));

      if (waitSoFar > cfg.timeoutS) {
        // Abandono en cola por timeout antes de ser atendido
        buckets[bIdx].timeouts++;
        totalTimeouts++;
        continue;
      }

      const serviceTime = sampleServiceTime(cfg.mu, cfg.cv, rand);
      const departTime = Math.max(arrTime, nextFree) + serviceTime;
      const totalLatency = departTime - arrTime;

      serverFreeAt[minIdx] = departTime;
      buckets[bIdx].processed++;
      buckets[bIdx].latencies.push(totalLatency);
      allLatencies.push(totalLatency);
      totalProcessed++;

      if (totalLatency > cfg.timeoutS) {
        buckets[bIdx].timeouts++;
        totalTimeouts++;
      }
    }
  };

  for (const tArr of arrivals) {
    dispatchUpTo(tArr);

    // Limpiar de la cola solicitudes ya expiradas por timeout antes de aceptar nueva
    while (queueArrivals.length > 0 && tArr - queueArrivals[0] > cfg.timeoutS) {
      const expiredArr = queueArrivals.shift()!;
      const eb = Math.min(numWindows - 1, Math.floor(expiredArr / windowS));
      buckets[eb].timeouts++;
      totalTimeouts++;
    }

    const bIdx = Math.min(numWindows - 1, Math.floor(tArr / windowS));
    buckets[bIdx].arrivals++;

    // Verificar si algún servidor está libre inmediatamente
    let freeIdx = -1;
    for (let i = 0; i < c; i++) {
      if (serverFreeAt[i] <= tArr) {
        freeIdx = i;
        break;
      }
    }

    if (freeIdx !== -1 && queueArrivals.length === 0) {
      const serviceTime = sampleServiceTime(cfg.mu, cfg.cv, rand);
      const departTime = tArr + serviceTime;
      serverFreeAt[freeIdx] = departTime;
      buckets[bIdx].processed++;
      buckets[bIdx].latencies.push(serviceTime);
      allLatencies.push(serviceTime);
      totalProcessed++;
      if (serviceTime > cfg.timeoutS) {
        buckets[bIdx].timeouts++;
        totalTimeouts++;
      }
    } else if (queueArrivals.length < maxQueueOnly) {
      queueArrivals.push(tArr);
    } else {
      buckets[bIdx].rejected++;
      totalRejected++;
    }
  }

  // Vaciar eventos restantes después del fin de llegadas
  dispatchUpTo(cfg.durationS + cfg.timeoutS * 4 + 100);

  const baseEpoch = Date.now() - numWindows * windowS * 1000;
  const windows: SimulationWindowPoint[] = buckets.map((b, i) => {
    const tStart = i * windowS;
    const tEnd = Math.min(cfg.durationS, (i + 1) * windowS);
    const dt = Math.max(0.1, tEnd - tStart);
    const sorted = [...b.latencies].sort((x, y) => x - y);
    const mean = sorted.length > 0 ? sorted.reduce((acc, v) => acc + v, 0) / sorted.length : 0;
    const totalW = Math.max(1, b.arrivals);

    const win: SimulationWindowPoint = {
      tStart,
      tEnd,
      ts: new Date(baseEpoch + tEnd * 1000).toISOString(),
      lambdaObs: Number((b.arrivals / dt).toFixed(4)),
      wMean: Number(mean.toFixed(6)),
      wP50: Number(percentile(sorted, 0.5).toFixed(6)),
      wP95: Number(percentile(sorted, 0.95).toFixed(6)),
      wP99: Number(percentile(sorted, 0.99).toFixed(6)),
      processed: b.processed,
      rejected: b.rejected,
      timeouts: b.timeouts,
      errorRate: Number(((b.rejected + b.timeouts) / totalW).toFixed(4)),
      provenance: 'SIMULATED',
    };
    onWindow?.(win);
    return win;
  });

  const sortedAll = [...allLatencies].sort((a, b) => a - b);
  const overallMeanLatency =
    sortedAll.length > 0 ? sortedAll.reduce((acc, v) => acc + v, 0) / sortedAll.length : 0;
  const overallP95Latency = percentile(sortedAll, 0.95);

  return {
    windows,
    totalArrivals: arrivals.length,
    totalProcessed,
    totalRejected,
    totalTimeouts,
    overallMeanLatency: Number(overallMeanLatency.toFixed(6)),
    overallP95Latency: Number(overallP95Latency.toFixed(6)),
    provenance: 'SIMULATED',
  };
}
