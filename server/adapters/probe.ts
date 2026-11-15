import { SAFETY_LIMITS } from '../core/safetyLimits';
import type { Provenance } from '../math/types';
import { checkProbeAuthorization, type AuthorizationRecord } from './ownership';
import { validateTargetUrlSsrf, type DnsResolver } from './ssrfGuard';

export interface ProbeRequestConfig {
  targetId: string;
  targetUrl: string;
  method: 'GET' | 'HEAD';
  requestedRps: number;
  requestedDurationS: number;
  requestedConcurrency: number;
  explicitCheckboxChecked: boolean;
  authorization: AuthorizationRecord | null;
}

export interface ProbeStepMeasurement {
  ts: string;
  stepIndex: number;
  rps: number;
  wMean: number;
  wP50: number;
  wP95: number;
  wP99: number;
  errorRate: number;
  statusCodes: Record<number, number>;
  provenance: Provenance;
}

export interface ProbeHttpSignals {
  serverHeader: string | null;
  cacheDetected: boolean;
  cacheStatus: string | null;
  rateLimitDetected: boolean;
  rateLimitHeader: string | null;
  contentType: string | null;
}

export interface ProbeRunResult {
  aborted: boolean;
  abortReason: string | null;
  baselineLatencyS: number;
  baselineCiLowS: number;
  baselineCiHighS: number;
  estimatedSingleWorkerMu: number | null;
  estimatedServiceCv: number;
  availability: number;
  totalRequests: number;
  sampleLatenciesS: number[];
  httpSignals: ProbeHttpSignals;
  steps: ProbeStepMeasurement[];
  limitationNote: string;
}

// Estado en memoria para garantizar 1 sondeo activo por objetivo y enfriamiento de 5 min
const activeProbesByTarget = new Set<string>();
const lastProbeCompletedAtByTarget = new Map<string, number>();

export function resetProbeLocksForTest(): void {
  activeProbesByTarget.clear();
  lastProbeCompletedAtByTarget.clear();
}

export function getProbeCooldownRemainingS(targetId: string, nowMs: number = Date.now()): number {
  const last = lastProbeCompletedAtByTarget.get(targetId);
  if (!last) return 0;
  const elapsedS = (nowMs - last) / 1000;
  return Math.max(0, Math.ceil(SAFETY_LIMITS.PROBE_COOLDOWN_S - elapsedS));
}

export function clampProbeLimits(req: {
  requestedRps: number;
  requestedDurationS: number;
  requestedConcurrency: number;
  method: string;
}): {
  rps: number;
  durationS: number;
  concurrency: number;
  method: 'GET' | 'HEAD';
  rejectedReason: string | null;
} {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return {
      rps: 0,
      durationS: 0,
      concurrency: 0,
      method: 'GET',
      rejectedReason: `Método HTTP '${req.method}' prohibido en sondeo. Solo GET o HEAD sin cuerpo.`,
    };
  }
  if (req.requestedRps > SAFETY_LIMITS.MAX_PROBE_RPS) {
    return {
      rps: 0,
      durationS: 0,
      concurrency: 0,
      method: req.method,
      rejectedReason: `Tasa solicitada (${req.requestedRps} req/s) excede el límite duro de ${SAFETY_LIMITS.MAX_PROBE_RPS} req/s.`,
    };
  }
  if (req.requestedDurationS > SAFETY_LIMITS.MAX_PROBE_DURATION_S) {
    return {
      rps: 0,
      durationS: 0,
      concurrency: 0,
      method: req.method,
      rejectedReason: `Duración solicitada (${req.requestedDurationS} s) excede el límite duro de ${SAFETY_LIMITS.MAX_PROBE_DURATION_S} s.`,
    };
  }
  if (req.requestedConcurrency > SAFETY_LIMITS.MAX_PROBE_CONCURRENCY) {
    return {
      rps: 0,
      durationS: 0,
      concurrency: 0,
      method: req.method,
      rejectedReason: `Concurrencia solicitada (${req.requestedConcurrency}) excede el límite duro de ${SAFETY_LIMITS.MAX_PROBE_CONCURRENCY}.`,
    };
  }

  return {
    rps: Math.max(0.5, Math.min(SAFETY_LIMITS.MAX_PROBE_RPS, req.requestedRps)),
    durationS: Math.max(2, Math.min(SAFETY_LIMITS.MAX_PROBE_DURATION_S, req.requestedDurationS)),
    concurrency: Math.max(1, Math.min(SAFETY_LIMITS.MAX_PROBE_CONCURRENCY, Math.round(req.requestedConcurrency))),
    method: req.method,
    rejectedReason: null,
  };
}

export function isPathDisallowedByRobots(robotsTxt: string, path: string): boolean {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.split('#')[0].trim());
  let inStar = false;
  for (const line of lines) {
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('user-agent:')) {
      const ua = line.slice(11).trim();
      inStar = ua === '*' || ua.toLowerCase().includes('umbralsim');
    } else if (inStar && lower.startsWith('disallow:')) {
      const rule = line.slice(9).trim();
      if (rule === '/' || (rule.length > 0 && path.startsWith(rule))) {
        return true;
      }
    }
  }
  return false;
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function bootstrapMeanCi(samples: number[]): { mean: number; ciLow: number; ciHigh: number } {
  if (samples.length === 0) return { mean: 0, ciLow: 0, ciHigh: 0 };
  if (samples.length === 1) return { mean: samples[0], ciLow: samples[0] * 0.85, ciHigh: samples[0] * 1.15 };

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  let seed = 133742;
  const rand = (): number => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const means: number[] = [];
  const B = 200;
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[Math.floor(rand() * samples.length)];
    }
    means.push(sum / samples.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean,
    ciLow: quantile(means, 0.025),
    ciHigh: quantile(means, 0.975),
  };
}

/**
 * Ejecuta una petición validando SSRF en cada salto de redirección (máx 3, mismo host).
 */
export async function safeFetchNoCrossHostRedirect(
  urlStr: string,
  method: 'GET' | 'HEAD',
  options: {
    allowPrivateOrLoopback: boolean;
    fetchImpl?: FetchLike;
    resolver?: DnsResolver;
  },
): Promise<{ status: number; headers: { get(name: string): string | null }; text: () => Promise<string> }> {
  const fetchFn = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const initialHost = new URL(urlStr).hostname;
  let currentUrl = urlStr;

  for (let hop = 0; hop <= SAFETY_LIMITS.MAX_REDIRECTS; hop++) {
    const ssrf = await validateTargetUrlSsrf(currentUrl, {
      allowPrivateOrLoopback: options.allowPrivateOrLoopback,
      resolver: options.resolver,
      expectedHost: hop > 0 ? initialHost : undefined,
    });
    if (!ssrf.allowed) {
      throw new Error(ssrf.reason ?? 'Bloqueo SSRF');
    }

    const res = await fetchFn(currentUrl, {
      method,
      redirect: 'manual',
      headers: { 'User-Agent': SAFETY_LIMITS.PROBE_USER_AGENT },
      ...(options.fetchImpl ? {} : { signal: AbortSignal.timeout(10_000) }),
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Redirección HTTP ${res.status} sin cabecera Location.`);
      const nextUrl = new URL(loc, currentUrl);
      if (!SAFETY_LIMITS.ALLOW_CROSS_HOST_REDIRECT && nextUrl.hostname.toLowerCase() !== initialHost.toLowerCase()) {
        throw new Error(`Redirección a otro host bloqueada (${initialHost} -> ${nextUrl.hostname}).`);
      }
      currentUrl = nextUrl.toString();
      continue;
    }

    return { status: res.status, headers: res.headers, text: () => res.text() };
  }

  throw new Error(`Se superó el máximo de ${SAFETY_LIMITS.MAX_REDIRECTS} redirecciones.`);
}

/**
 * Ejecuta sondeo controlado de baja intensidad con:
 * - Validación de autorización, expiración, propiedad y SSRF
 * - Bloqueo de concurrencia por objetivo y enfriamiento de 5 min
 * - Respeto de robots.txt
 * - Aborto inmediato ante 429/503 o p95 > 3× línea base
 * - Calibración de latencia base S0, intervalo de confianza y detección de caché/WAF
 */
export async function runAuthorizedLowRateProbe(
  cfg: ProbeRequestConfig,
  hooks: {
    onStep?: (step: ProbeStepMeasurement) => void;
    fetchImpl?: FetchLike;
    resolver?: DnsResolver;
    bypassTimingDelayForTest?: boolean;
  } = {},
): Promise<ProbeRunResult> {
  const limits = clampProbeLimits(cfg);
  if (limits.rejectedReason) {
    throw new Error(limits.rejectedReason);
  }

  const authCheck = await checkProbeAuthorization({
    targetUrl: cfg.targetUrl,
    explicitCheckboxChecked: cfg.explicitCheckboxChecked,
    authorization: cfg.authorization,
  });
  if (!authCheck.authorized) {
    throw new Error(authCheck.reason ?? 'Sondeo no autorizado.');
  }

  if (activeProbesByTarget.has(cfg.targetId)) {
    throw new Error('Ya existe un sondeo activo en curso para este objetivo (límite: 1 a la vez).');
  }

  const cooldownRem = getProbeCooldownRemainingS(cfg.targetId);
  if (cooldownRem > 0) {
    throw new Error(`Enfriamiento obligatorio activo: espere ${cooldownRem} s antes de sondear de nuevo este objetivo.`);
  }

  activeProbesByTarget.add(cfg.targetId);

  try {
    const parsedUrl = new URL(cfg.targetUrl);
    // Comprobar robots.txt
    if (SAFETY_LIMITS.RESPECT_ROBOTS_TXT) {
      try {
        const robotsRes = await safeFetchNoCrossHostRedirect(`${parsedUrl.origin}/robots.txt`, 'GET', {
          allowPrivateOrLoopback: authCheck.isPrivateOrLoopback,
          fetchImpl: hooks.fetchImpl,
          resolver: hooks.resolver,
        });
        if (robotsRes.status === 200) {
          const txt = await robotsRes.text();
          if (isPathDisallowedByRobots(txt, parsedUrl.pathname || '/')) {
            throw new Error(`Acceso denegado por robots.txt para la ruta '${parsedUrl.pathname || '/'}'.`);
          }
        }
      } catch (err) {
        if ((err as Error).message.includes('robots.txt')) throw err;
        // Si robots.txt no existe o da 404/conexión puntual en el check, seguimos solo si el error no fue SSRF ni robots
        if ((err as Error).message.includes('SSRF') || (err as Error).message.includes('Redirección')) {
          throw err;
        }
      }
    }

    // Dividir en escalones bajos (1 req/s hasta limits.rps sin exceder duración ni tasa máxima)
    const numSteps = Math.max(2, Math.min(8, Math.round(limits.durationS / 2)));
    const stepDurationS = limits.durationS / numSteps;
    const steps: ProbeStepMeasurement[] = [];
    const allLatencies: number[] = [];
    let okCount = 0;
    let totalRequests = 0;
    let baselineLatencyS = 0;
    let aborted = false;
    let abortReason: string | null = null;

    const httpSignals: ProbeHttpSignals = {
      serverHeader: null,
      cacheDetected: false,
      cacheStatus: null,
      rateLimitDetected: false,
      rateLimitHeader: null,
      contentType: null,
    };

    for (let s = 0; s < numSteps; s++) {
      const stepRps = Number(
        Math.min(
          SAFETY_LIMITS.MAX_PROBE_RPS,
          1 + ((limits.rps - 1) * s) / Math.max(1, numSteps - 1),
        ).toFixed(2),
      );
      const reqCount = Math.max(2, Math.min(10, Math.round(stepRps * stepDurationS)));
      const workerIntervalMs = (1000 * limits.concurrency) / stepRps;
      const stepLatencies: number[] = [];
      const statusCodes: Record<number, number> = {};
      let stepErrors = 0;

      // Ejecutar respetando concurrency <= MAX_PROBE_CONCURRENCY y tasa total <= stepRps <= 5 req/s
      let nextIdx = 0;
      const worker = async (workerIdx: number): Promise<void> => {
        if (!hooks.bypassTimingDelayForTest && workerIdx > 0) {
          await new Promise((r) => setTimeout(r, Math.round(1000 / stepRps)));
        }
        while (nextIdx < reqCount && !aborted) {
          const myIdx = nextIdx++;
          const iterStart = performance.now();
          let status = 0;
          try {
            const res = await safeFetchNoCrossHostRedirect(cfg.targetUrl, limits.method, {
              allowPrivateOrLoopback: authCheck.isPrivateOrLoopback,
              fetchImpl: hooks.fetchImpl,
              resolver: hooks.resolver,
            });
            status = res.status;
            // Consumir cuerpo para medir tiempo total de respuesta HTML/API en GET
            if (limits.method === 'GET') {
              await res.text().catch(() => '');
            }
            if (!httpSignals.serverHeader) {
              httpSignals.serverHeader = res.headers.get('server');
            }
            if (!httpSignals.contentType) {
              httpSignals.contentType = res.headers.get('content-type');
            }
            const cfCache = res.headers.get('cf-cache-status');
            const xCache = res.headers.get('x-cache');
            const ageHdr = res.headers.get('age');
            if (cfCache || xCache || (ageHdr && Number(ageHdr) > 0)) {
              httpSignals.cacheStatus = cfCache ?? xCache ?? `Age: ${ageHdr}s`;
              if (
                /hit|stale|revalidated/i.test(httpSignals.cacheStatus) ||
                (ageHdr && Number(ageHdr) > 0)
              ) {
                httpSignals.cacheDetected = true;
              }
            }
            const rlHdr =
              res.headers.get('x-ratelimit-limit') ??
              res.headers.get('ratelimit-limit') ??
              res.headers.get('retry-after');
            if (rlHdr) {
              httpSignals.rateLimitDetected = true;
              httpSignals.rateLimitHeader = rlHdr;
            }
          } catch (err) {
            aborted = true;
            abortReason = (err as Error).message;
            break;
          }
          const reqElapsedMs = performance.now() - iterStart;
          const elapsedS = Math.max(0.0005, reqElapsedMs / 1000);
          totalRequests++;
          statusCodes[status] = (statusCodes[status] ?? 0) + 1;

          if ((SAFETY_LIMITS.ABORT_HTTP_STATUS_CODES as readonly number[]).includes(status)) {
            stepErrors++;
            aborted = true;
            abortReason = `Aborto automático por respuesta HTTP ${status} (protección contra sobrecarga).`;
            break;
          }

          if (status >= 400) {
            stepErrors++;
          } else {
            okCount++;
          }
          stepLatencies.push(elapsedS);
          allLatencies.push(elapsedS);

          if (!hooks.bypassTimingDelayForTest && myIdx + 1 < reqCount && !aborted) {
            const waitMs = Math.max(0, workerIntervalMs - reqElapsedMs);
            if (waitMs > 5) {
              await new Promise((r) => setTimeout(r, waitMs));
            }
          }
        }
      };

      const workers = Array.from({ length: limits.concurrency }, (_, idx) => worker(idx));
      await Promise.all(workers);

      if (stepLatencies.length > 0) {
        const sorted = [...stepLatencies].sort((a, b) => a - b);
        const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
        const p50 = quantile(sorted, 0.5);
        const p95 = quantile(sorted, 0.95);
        const p99 = quantile(sorted, 0.99);

        if (s === 0) {
          baselineLatencyS = p50;
        } else if (baselineLatencyS > 0 && p95 > baselineLatencyS * SAFETY_LIMITS.P95_ABORT_MULTIPLIER) {
          aborted = true;
          abortReason = `Aborto automático: p95 (${(p95 * 1000).toFixed(1)} ms) superó 3× la línea base (${(baselineLatencyS * 1000).toFixed(1)} ms).`;
        }

        const stepData: ProbeStepMeasurement = {
          ts: new Date().toISOString(),
          stepIndex: s + 1,
          rps: stepRps,
          wMean: Number(mean.toFixed(6)),
          wP50: Number(p50.toFixed(6)),
          wP95: Number(p95.toFixed(6)),
          wP99: Number(p99.toFixed(6)),
          errorRate: Number((stepErrors / Math.max(1, stepLatencies.length + stepErrors)).toFixed(4)),
          statusCodes,
          provenance: 'MEASURED',
        };
        steps.push(stepData);
        hooks.onStep?.(stepData);
      }

      if (aborted) break;
    }

    const ciStats = bootstrapMeanCi(allLatencies);
    const effectiveBaselineS = ciStats.mean > 0 ? ciStats.mean : baselineLatencyS;
    const variance =
      allLatencies.length > 1
        ? allLatencies.reduce((acc, v) => acc + Math.pow(v - effectiveBaselineS, 2), 0) / (allLatencies.length - 1)
        : 0;
    const cv = effectiveBaselineS > 0 ? Math.max(0.1, Math.min(4, Math.sqrt(variance) / effectiveBaselineS)) : 1;

    return {
      aborted,
      abortReason,
      baselineLatencyS: Number(effectiveBaselineS.toFixed(6)),
      baselineCiLowS: Number(ciStats.ciLow.toFixed(6)),
      baselineCiHighS: Number(ciStats.ciHigh.toFixed(6)),
      estimatedSingleWorkerMu:
        effectiveBaselineS > 0 ? Number((1 / effectiveBaselineS).toFixed(4)) : null,
      estimatedServiceCv: Number(cv.toFixed(3)),
      availability: totalRequests > 0 ? Number((okCount / totalRequests).toFixed(4)) : 0,
      totalRequests,
      sampleLatenciesS: allLatencies.map((v) => Number(v.toFixed(6))),
      httpSignals,
      steps,
      limitationNote:
        'Medición de baja intensidad (≤5 req/s): calibra el tiempo real de respuesta S₀, dispersión (CV), disponibilidad y cabeceras HTTP del sitio para parametrizar μ = c/S₀; la precisión mejora aún más si se combina con logs reales bajo carga o número de workers (c) conocido.',
    };
  } finally {
    activeProbesByTarget.delete(cfg.targetId);
    lastProbeCompletedAtByTarget.set(cfg.targetId, Date.now());
  }
}
