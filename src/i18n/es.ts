export const ES = {
  appName: 'UmbralSim',
  legalNotice:
    'Uso autorizado exclusivamente: esta herramienta predice umbrales de saturación mediante modelos matemáticos, logs y sondeo de baja intensidad (≤ 5 req/s). Está prohibido su uso contra sistemas sin autorización explícita y verificada.',
  probeLimitation:
    'Nota metodológica: un sondeo autorizado de ≤ 5 req/s mide el tiempo real de respuesta S₀, variabilidad (CV), disponibilidad y cabeceras HTTP para calibrar μ = c/S₀; también puede combinar logs reales o Prometheus para ajustar μ bajo carga variada.',
  nav: {
    dashboard: 'Dashboard',
    web: 'Predictor Web',
    targets: 'Infraestructuras',
    wizard: 'Nuevo Experimento',
    comparison: 'Newton vs. Secante',
    history: 'Historial',
    reports: 'Reportes',
    audit: 'Auditoría',
  },
  provenance: {
    MEASURED: 'MEDIDO',
    SIMULATED: 'SIMULADO',
    PREDICTED: 'PREDICHO',
  },
  models: {
    MM1: 'M/M/1 (Cola exponencial base)',
    MM1K: 'M/M/1/K (Capacidad finita)',
    MMC: 'M/M/c (Erlang C multi-servidor)',
    MG1: 'M/G/1 (Pollaczek-Khinchine)',
    EMPIRICAL: 'Empírico (PCHIP monótono)',
  },
  objectives: {
    MEAN_LATENCY: 'Latencia media W(λ) = T',
    PERCENTILE_LATENCY: 'Percentil p de latencia Wp(λ) = T',
    TIMEOUT_PROBABILITY: 'Probabilidad de timeout P(W > T) = ε',
    EMPIRICAL_LATENCY: 'Curva empírica W_emp(λ) = T',
  },
  failureReasons: {
    NONE: 'Convergido',
    DOMAIN_ESCAPE: 'Escape de dominio (λ fuera de [0, μ))',
    ZERO_DERIVATIVE: 'Derivada cercana a cero',
    ZERO_DENOMINATOR: 'Denominador casi nulo en secante',
    INVALID_SEEDS: 'Semillas inválidas o iguales',
    NAN_INF: 'Valor no finito (NaN/Inf)',
    STAGNATION: 'Estancamiento numérico',
    NO_POSITIVE_ROOT: 'Sin raíz positiva (T ≤ 1/μ)',
    MAX_ITER: 'Máximo de iteraciones alcanzado',
  } as Record<string, string>,
} as const;
