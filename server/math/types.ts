export type Provenance = 'MEASURED' | 'SIMULATED' | 'PREDICTED';

export type QueueModelType = 'MM1' | 'MM1K' | 'MMC' | 'MG1' | 'EMPIRICAL';

export type ObjectiveType =
  | 'MEAN_LATENCY'
  | 'PERCENTILE_LATENCY'
  | 'TIMEOUT_PROBABILITY'
  | 'EMPIRICAL_LATENCY';

export type SolverMethod = 'NEWTON' | 'SECANT' | 'BISECTION';

export type SolverFailureReason =
  | 'NONE'
  | 'DOMAIN_ESCAPE'
  | 'ZERO_DERIVATIVE'
  | 'ZERO_DENOMINATOR'
  | 'INVALID_SEEDS'
  | 'NAN_INF'
  | 'STAGNATION'
  | 'NO_POSITIVE_ROOT'
  | 'MAX_ITER';

export type StoppingCriterion = 'TOL_F' | 'TOL_X' | 'MAX_ITER' | 'FAILED';

export interface EmpiricalPoint {
  lambda: number;
  latency: number;
}

export interface QueueParams {
  mu: number; // Tasa de servicio por servidor (req/s)
  c?: number; // Número de servidores/trabajadores (M/M/c)
  K?: number; // Capacidad máxima del sistema (M/M/1/K)
  cv?: number; // Coeficiente de variación del tiempo de servicio (M/G/1)
  empiricalPoints?: EmpiricalPoint[]; // Puntos (lambda, W) para modelo empírico PCHIP
}

export interface ObjectiveConfig {
  type: ObjectiveType;
  targetLatencyS: number; // T en segundos (para timeout o latencia límite)
  percentile?: number; // p en (0, 1), ej. 0.95
  timeoutEpsilon?: number; // epsilon en (0, 1), ej. 0.05 para P(W > T) = epsilon
}

export interface SolverIteration {
  n: number;
  x: number;
  fx: number;
  dfx: number | null;
  step: number | null;
  stepError: number | null;
  trueError: number | null;
}

export interface SolverResult {
  method: SolverMethod;
  converged: boolean;
  root: number | null;
  failureReason: SolverFailureReason;
  failureMessage: string | null;
  stoppingCriterion: StoppingCriterion;
  iterations: SolverIteration[];
  fEvals: number;
  dfEvals: number;
  elapsedNs: number;
  estimatedOrder: number | null;
  efficiencyIndex: number | null;
  usedFiniteDifference: boolean;
  analyticalRoot: number | null;
  absError: number | null;
  relError: number | null;
}

export interface QueueModel {
  readonly type: QueueModelType;
  readonly label: string;
  readonly hasAnalyticalDerivative: boolean;
  domain(params: QueueParams): [number, number];
  latency(lambda: number, params: QueueParams): number;
  latencyDerivative(lambda: number, params: QueueParams): number | null;
  utilization(lambda: number, params: QueueParams): number;
  percentileLatency(lambda: number, p: number, params: QueueParams): number | null;
  timeoutProbability(lambda: number, t: number, params: QueueParams): number | null;
  blockingProbability(lambda: number, params: QueueParams): number;
}
