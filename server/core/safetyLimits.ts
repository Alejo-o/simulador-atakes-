/**
 * Límites de seguridad obligatorios e inmutables (Hard Constraints).
 * No son configurables por interfaz, variables de entorno ni parámetros de API.
 */
export const SAFETY_LIMITS = Object.freeze({
  // Regla 2: Sondeo activo de sitios reales de baja intensidad
  MAX_PROBE_RPS: 5,
  MAX_PROBE_DURATION_S: 60,
  MAX_PROBE_CONCURRENCY: 2,
  ALLOWED_PROBE_METHODS: Object.freeze(['GET', 'HEAD'] as const),
  MAX_ACTIVE_PROBES_PER_TARGET: 1,
  PROBE_COOLDOWN_S: 300, // 5 minutos entre pruebas al mismo objetivo

  // Regla 5: Identificación, abortos y respeto de políticas
  PROBE_USER_AGENT: 'UmbralSim/1.0 (+mailto:seguridad@umbralsim.local)',
  ABORT_HTTP_STATUS_CODES: Object.freeze([429, 503] as const),
  P95_ABORT_MULTIPLIER: 3.0,
  RESPECT_ROBOTS_TXT: true,

  // Regla 4: Protección SSRF
  MAX_REDIRECTS: 3,
  ALLOW_CROSS_HOST_REDIRECT: false,
  BLOCKED_METADATA_IPS: Object.freeze([
    '169.254.169.254',
    '169.254.170.2',
    '100.100.100.200',
    'fd00:ec2::254',
  ] as const),

  // Regla 6: Modo laboratorio (simulador en memoria + mock-target loopback únicamente)
  LAB_MOCK_MAX_RPS: 20,
  LAB_MOCK_MAX_DURATION_S: 30,
  LAB_MOCK_ALLOWED_HOSTS: Object.freeze(['127.0.0.1', '::1', 'localhost'] as const),
} as const);

export type SafetyLimits = typeof SAFETY_LIMITS;
