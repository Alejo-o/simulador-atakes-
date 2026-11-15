import { useEffect, useRef, useState } from 'react';

export interface TargetItem {
  id: string;
  name: string;
  baseUrl: string;
  environment: string;
  createdAt: string;
  cooldownRemainingS: number;
  authorization: {
    id: string;
    method: string;
    rawTokenPreview: string | null;
    verifiedAt: string | null;
    expiresAt: string;
    declaredBy: string;
    evidenceNote: string;
  } | null;
  profile: {
    c: number;
    K: number;
    timeoutS: number;
    muDeclared: number;
    muSource: string;
    serviceCv: number;
    sloMs: number;
  } | null;
}

export interface ExperimentSummary {
  id: string;
  targetId: string;
  targetName: string;
  objective: string;
  model: string;
  sourceKind: string;
  status: string;
  createdBy: string;
  createdAt: string;
  lambdaStar: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  confidenceLevel: string | null;
  extrapolated: boolean;
}

export interface SolverIterationDto {
  n: number;
  x: number;
  fx: number;
  dfx: number | null;
  step: number | null;
  errAbs: number | null;
  errTrue: number | null;
}

export interface SolverRunDto {
  id: string;
  method: string;
  seeds: number[];
  tol: number;
  converged: boolean;
  root: number | null;
  failureReason: string;
  failureMessage: string | null;
  stoppingCriterion: string;
  fEvals: number;
  dfEvals: number;
  elapsedNs: number;
  estimatedOrder: number | null;
  efficiencyIndex: number | null;
  usedFiniteDifference: boolean;
  absError: number | null;
  relError: number | null;
  iterations: SolverIterationDto[];
}

export interface ExperimentDetailDto {
  experiment: {
    id: string;
    targetId: string;
    targetName: string;
    targetUrl: string;
    environment: string;
    sourceId: string | null;
    sourceKind: string;
    objective: string;
    model: string;
    params: {
      params?: { mu: number; c?: number; K?: number; cv?: number };
      objective?: { type: string; targetLatencyS: number; percentile?: number; timeoutEpsilon?: number };
      fitting?: {
        muEstimated: number;
        muCiLow: number;
        muCiHigh: number;
        rSquared: number;
        rmseLatency: number;
        adequacyMM1: { adequate: boolean; reason: string; suggestedModel: string };
        cvEstimated: number;
        maxObservedLambda: number;
      };
      simSummary?: {
        totalArrivals: number;
        totalProcessed: number;
        totalRejected: number;
        totalTimeouts: number;
      };
      probeMeta?: {
        aborted: boolean;
        abortReason: string | null;
        baselineLatencyS: number;
        baselineCiLowS?: number;
        baselineCiHighS?: number;
        estimatedServiceCv: number;
        availability: number;
        totalRequests?: number;
        httpSignals?: {
          serverHeader: string | null;
          cacheDetected: boolean;
          cacheStatus: string | null;
          rateLimitDetected: boolean;
          rateLimitHeader: string | null;
          contentType: string | null;
        };
        limitationNote: string;
      };
      probeCalibration?: {
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
        httpSignals?: {
          serverHeader: string | null;
          cacheDetected: boolean;
          cacheStatus: string | null;
          rateLimitDetected: boolean;
          rateLimitHeader: string | null;
          contentType: string | null;
        };
      };
      logSummary?: {
        formatDetected: string;
        totalLines: number;
        validLines: number;
        invalidLines: number;
        windowS: number;
      };
    };
    status: string;
    createdBy: string;
    createdAt: string;
  };
  measurements: Array<{
    ts: string;
    windowS: number;
    lambdaObs: number;
    wMean: number;
    wP50: number;
    wP95: number;
    wP99: number;
    errorRate: number;
    provenance: 'MEASURED' | 'SIMULATED' | 'PREDICTED';
  }>;
  solverRuns: SolverRunDto[];
  prediction: {
    lambdaStar: number | null;
    ciLow: number | null;
    ciHigh: number | null;
    confidenceLevel: string;
    extrapolated: boolean;
    extrapolationWarning: string | null;
    provenance: string;
  } | null;
  alerts: Array<{
    id: string;
    severity: string;
    rule: string;
    message: string;
    ts: string;
  }>;
}

export interface MathAnalysisResponse {
  solved: {
    newton: SolverRunDto & { iterations: Array<SolverIterationDto & { stepError?: number | null; trueError?: number | null }> };
    secant: SolverRunDto & { iterations: Array<SolverIterationDto & { stepError?: number | null; trueError?: number | null }> };
    bisection: SolverRunDto;
    analyticalRoot: number | null;
    domain: [number, number];
    noPositiveRootReason: string | null;
  };
  basin: {
    theoreticalNewtonLowerBound: number | null;
    theoreticalNewtonUpperBound: number;
    cells: Array<{
      seedRatio: number;
      seedValue: number;
      newtonConverged: boolean;
      newtonIterations: number;
      newtonReason: string;
      secantConverged: boolean;
      secantIterations: number;
      secantReason: string;
      insideTheoreticalNewtonInterval: boolean;
    }>;
  };
  tolSensitivity: Array<{
    tolerance: number;
    newtonIters: number;
    newtonEvals: number;
    secantIters: number;
    secantEvals: number;
  }>;
  curvePoints: Array<{ lambda: number; latency: number }>;
}

export interface AuditResponse {
  verification: {
    valid: boolean;
    checkedCount: number;
    brokenAtIndex: number | null;
    brokenEntryId: string | null;
    reason: string | null;
  };
  entries: Array<{
    id: string;
    ts: string;
    actor: string;
    action: string;
    targetId: string | null;
    detailJson: string;
    prevHash: string;
    hash: string;
  }>;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string; detail?: string }).error || (body as { detail?: string }).detail || `Error HTTP ${res.status}`);
  }
  return body as T;
}

export const umbralApi = {
  getSafetyLimits: () => apiFetch<Record<string, unknown>>('/api/safety-limits'),
  getSampleLog: (name: 'nginx_rampa.log' | 'latencias_api.csv') =>
    apiFetch<{ name: string; content: string }>(`/api/samples/${name}`),
  getTargets: () => apiFetch<TargetItem[]>('/api/targets'),
  createTarget: (payload: Record<string, unknown>) =>
    apiFetch<{ id: string; isPrivateOrLoopback?: boolean; resolvedIps?: string[] }>('/api/targets', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateTargetProfile: (targetId: string, payload: Record<string, unknown>) =>
    apiFetch<{ updated: boolean }>(`/api/targets/${targetId}/profile`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  createAuthorization: (targetId: string, payload: Record<string, unknown>) =>
    apiFetch<{ id: string; rawToken: string; method: string; expiresAt: string }>(
      `/api/targets/${targetId}/authorizations`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  verifyAuthorization: (targetId: string, authId: string) =>
    apiFetch<{ verified: boolean; verifiedAt: string; detail: string }>(
      `/api/targets/${targetId}/authorizations/${authId}/verify`,
      { method: 'POST' },
    ),
  getExperiments: (filters?: { model?: string; source?: string }) => {
    const qs = new URLSearchParams();
    if (filters?.model) qs.set('model', filters.model);
    if (filters?.source) qs.set('source', filters.source);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<ExperimentSummary[]>(`/api/experiments${suffix}`);
  },
  getExperimentDetail: (id: string) => apiFetch<ExperimentDetailDto>(`/api/experiments/${id}`),
  runExperiment: (payload: Record<string, unknown>) =>
    apiFetch<{ detail: ExperimentDetailDto; fitting?: unknown; logSummary?: unknown; probeMeta?: unknown }>(
      '/api/experiments/run',
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  rerunExperiment: (id: string) =>
    apiFetch<{ detail: ExperimentDetailDto }>(`/api/experiments/${id}/rerun`, { method: 'POST' }),
  analyzeMath: (payload: Record<string, unknown>) =>
    apiFetch<MathAnalysisResponse>('/api/math/analyze', { method: 'POST', body: JSON.stringify(payload) }),
  importPrometheus: (payload: Record<string, unknown>) =>
    apiFetch<{ windows: unknown[] }>('/api/integrations/prometheus/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAudit: () => apiFetch<AuditResponse>('/api/audit'),
};

export interface WsStreamMessage {
  event: string;
  payload: unknown;
  ts: string;
}

export function useUmbralSocket(onMessage: (msg: WsStreamMessage) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as WsStreamMessage;
        cbRef.current(parsed);
      } catch {
        // Ignorar frames malformados
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  return { connected };
}
