import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  FileText,
  Globe,
  KeyRound,
  PlayCircle,
  Radio,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { umbralApi, type TargetItem } from '../api/client';
import { HelpTip } from '../components/HelpTip';
import { ES } from '../i18n/es';

interface WebPredictorPageProps {
  targets: TargetItem[];
  initialTargetId: string | null;
  liveProbeSteps: Array<{ lambdaObs: number; wMean: number; wP95: number }>;
  onTargetsUpdated: () => Promise<void>;
  onExperimentCreated: (experimentId: string) => Promise<void>;
}

type WebDataMode = 'PROBE' | 'LOG' | 'PROMETHEUS';

function isLikelyPrivateUrl(urlStr: string): boolean {
  const lower = urlStr.toLowerCase();
  return (
    lower.includes('127.0.0.1') ||
    lower.includes('localhost') ||
    lower.includes('::1') ||
    /https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(lower)
  );
}

export function WebPredictorPage({
  targets,
  initialTargetId,
  liveProbeSteps,
  onTargetsUpdated,
  onExperimentCreated,
}: WebPredictorPageProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<string>(initialTargetId ?? targets[0]?.id ?? '');
  const [showNewUrlForm, setShowNewUrlForm] = useState<boolean>(targets.length === 0);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newEnv, setNewEnv] = useState<'PRODUCCION' | 'STAGING' | 'LABORATORIO'>('PRODUCCION');
  const [newWorkers, setNewWorkers] = useState(2);
  const [registering, setRegistering] = useState(false);

  const [mode, setMode] = useState<WebDataMode>('PROBE');
  const [model, setModel] = useState<'MM1' | 'MMC' | 'MG1' | 'MM1K' | 'EMPIRICAL'>('MM1');
  const [workersC, setWorkersC] = useState(2);
  const [autoTargetT, setAutoTargetT] = useState(true);
  const [fixedLatencyS, setFixedLatencyS] = useState(0.2);

  // Opciones de sondeo HTTP real
  const [probeMethod, setProbeMethod] = useState<'GET' | 'HEAD'>('GET');
  const [probeRps, setProbeRps] = useState(3);
  const [probeDurationS, setProbeDurationS] = useState(8);
  const [probeConcurrency, setProbeConcurrency] = useState(1);
  const [explicitConsent, setExplicitConsent] = useState(false);
  const [showProbeAdvanced, setShowProbeAdvanced] = useState(false);

  // Verificación de propiedad inline
  const [verifyMethod, setVerifyMethod] = useState<'WELL_KNOWN' | 'DNS_TXT' | 'HEADER' | 'PRIVATE_AUTH_ONLY'>(
    'WELL_KNOWN',
  );
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Logs reales
  const [rawLogText, setRawLogText] = useState('');
  const [logWindowS, setLogWindowS] = useState(5);

  // Prometheus real
  const [promUrl, setPromUrl] = useState('');
  const [promRateQuery, setPromRateQuery] = useState('sum(rate(http_requests_total[1m]))');
  const [promLatQuery, setPromLatQuery] = useState(
    'sum(rate(http_request_duration_seconds_sum[1m])) / sum(rate(http_request_duration_seconds_count[1m]))',
  );
  const [promLookbackMin, setPromLookbackMin] = useState(30);
  const [promToken, setPromToken] = useState('');
  const [promAllowPrivate, setPromAllowPrivate] = useState(false);

  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (initialTargetId) setSelectedTargetId(initialTargetId);
    else if (!selectedTargetId && targets[0]?.id) setSelectedTargetId(targets[0].id);
  }, [initialTargetId, targets, selectedTargetId]);

  const activeTarget = targets.find((t) => t.id === selectedTargetId) ?? targets[0] ?? null;

  useEffect(() => {
    if (!activeTarget) return;
    setWorkersC(activeTarget.profile?.c ?? 2);
    if (isLikelyPrivateUrl(activeTarget.baseUrl)) {
      setVerifyMethod('PRIVATE_AUTH_ONLY');
    } else if (verifyMethod === 'PRIVATE_AUTH_ONLY') {
      setVerifyMethod('WELL_KNOWN');
    }
    setGeneratedToken(activeTarget.authorization?.rawTokenPreview ?? null);
  }, [activeTarget?.id]);

  const auth = activeTarget?.authorization ?? null;
  const authExpired = auth ? Date.parse(auth.expiresAt) <= Date.now() : true;
  const targetIsPrivate = activeTarget ? isLikelyPrivateUrl(activeTarget.baseUrl) : false;
  const probeAuthorizedReady =
    Boolean(auth && !authExpired) && (targetIsPrivate || Boolean(auth?.verifiedAt));

  const handleRegisterUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    const trimmedUrl = newUrl.trim();
    if (!trimmedUrl) {
      setStatusMsg({ type: 'err', text: 'Ingrese una URL válida (ej. https://tudominio.com/health).' });
      return;
    }
    let derivedName = newName.trim();
    if (!derivedName) {
      try {
        derivedName = new URL(trimmedUrl).hostname;
      } catch {
        derivedName = trimmedUrl;
      }
    }

    setRegistering(true);
    try {
      const created = await umbralApi.createTarget({
        name: derivedName,
        baseUrl: trimmedUrl,
        environment: newEnv,
        c: workersC,
        K: 150,
        timeoutS: fixedLatencyS,
        muDeclared: 100,
        muSource: 'DECLARED',
        serviceCv: 1.0,
        sloMs: Math.round(fixedLatencyS * 1000),
      });
      await onTargetsUpdated();
      setSelectedTargetId(created.id);
      setShowNewUrlForm(false);
      setNewName('');
      setNewUrl('');
      if (created.isPrivateOrLoopback) {
        setVerifyMethod('PRIVATE_AUTH_ONLY');
        setStatusMsg({
          type: 'ok',
          text: `Sitio local/privado registrado (${created.resolvedIps?.join(', ') ?? 'red privada'}). Genere su registro de autorización local y marque el consentimiento para sondear.`,
        });
      } else {
        setVerifyMethod('WELL_KNOWN');
        setStatusMsg({
          type: 'ok',
          text: `Sitio público registrado (IP: ${created.resolvedIps?.join(', ') ?? 'resuelta'}). Genere un token y verifique propiedad para sondeo activo, o analice sus logs/Prometheus directamente.`,
        });
      }
    } catch (err) {
      setStatusMsg({ type: 'err', text: (err as Error).message });
    } finally {
      setRegistering(false);
    }
  };

  const handleGenerateAuth = async () => {
    if (!activeTarget) return;
    setAuthLoading(true);
    setStatusMsg(null);
    try {
      const res = await umbralApi.createAuthorization(activeTarget.id, {
        method: verifyMethod,
        expiresHours: 72,
        declaredBy: 'operador@umbralsim.local',
        evidenceNote: `Autorización web emitida (${verifyMethod})`,
      });
      setGeneratedToken(res.rawToken);
      await onTargetsUpdated();
      setStatusMsg({
        type: 'ok',
        text:
          verifyMethod === 'PRIVATE_AUTH_ONLY'
            ? 'Autorización local/privada registrada por 72 h. Ya puede marcar el consentimiento explícito y medir la página.'
            : 'Token generado. Publíquelo en su sitio web según las instrucciones y pulse «Verificar propiedad ahora».',
      });
    } catch (err) {
      setStatusMsg({ type: 'err', text: (err as Error).message });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleVerifyNow = async () => {
    if (!activeTarget || !activeTarget.authorization) return;
    setAuthLoading(true);
    setStatusMsg(null);
    try {
      const res = await umbralApi.verifyAuthorization(activeTarget.id, activeTarget.authorization.id);
      await onTargetsUpdated();
      setStatusMsg({ type: 'ok', text: `Propiedad verificada: ${res.detail}` });
    } catch (err) {
      setStatusMsg({ type: 'err', text: (err as Error).message });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setRawLogText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const loadSampleLog = async (name: 'nginx_rampa.log' | 'latencias_api.csv') => {
    try {
      const res = await umbralApi.getSampleLog(name);
      setRawLogText(res.content);
      setStatusMsg(null);
    } catch (err) {
      setStatusMsg({ type: 'err', text: (err as Error).message });
    }
  };

  const handleCopyToken = () => {
    const tok = generatedToken ?? auth?.rawTokenPreview;
    if (!tok) return;
    navigator.clipboard?.writeText(tok).catch(() => {});
    setStatusMsg({ type: 'ok', text: 'Token copiado al portapapeles.' });
  };

  const handleRunWebPrediction = async () => {
    if (!activeTarget) {
      setStatusMsg({ type: 'err', text: 'Primero registre o seleccione una página web objetivo.' });
      return;
    }
    if (mode === 'PROBE') {
      if (!probeAuthorizedReady) {
        setStatusMsg({
          type: 'err',
          text: 'Complete primero el registro de autorización (y verificación de propiedad si es un dominio público).',
        });
        return;
      }
      if (!explicitConsent) {
        setStatusMsg({
          type: 'err',
          text: 'Debe marcar la casilla de autorización explícita antes de enviar peticiones reales a la página web.',
        });
        return;
      }
    }
    if (mode === 'LOG' && !rawLogText.trim()) {
      setStatusMsg({ type: 'err', text: 'Suba o pegue un log real (Nginx, JSONL o CSV) de la página web.' });
      return;
    }
    if (mode === 'PROMETHEUS' && (!promUrl.trim() || !promRateQuery.trim() || !promLatQuery.trim())) {
      setStatusMsg({ type: 'err', text: 'Complete la URL de Prometheus y ambas consultas PromQL.' });
      return;
    }

    setRunning(true);
    setStatusMsg(null);
    try {
      const payload: Record<string, unknown> = {
        targetId: activeTarget.id,
        sourceKind: mode,
        model,
        c: workersC,
        objective: {
          type: 'MEAN_LATENCY',
          targetLatencyS: autoTargetT && mode === 'PROBE' ? 0.05 : fixedLatencyS,
        },
        autoTargetLatency: mode === 'PROBE' && autoTargetT,
      };

      if (mode === 'PROBE') {
        payload.probeMethod = probeMethod;
        payload.probeRps = probeRps;
        payload.probeDurationS = probeDurationS;
        payload.probeConcurrency = probeConcurrency;
        payload.explicitAuthorizationChecked = explicitConsent;
      } else if (mode === 'LOG') {
        payload.rawLogText = rawLogText;
        payload.logWindowS = logWindowS;
      } else {
        payload.prometheusUrl = promUrl.trim();
        payload.prometheusRateQuery = promRateQuery.trim();
        payload.prometheusLatencyQuery = promLatQuery.trim();
        payload.prometheusLookbackMin = promLookbackMin;
        payload.prometheusBearerToken = promToken.trim() || undefined;
        payload.prometheusAllowPrivate = promAllowPrivate;
      }

      const res = await umbralApi.runExperiment(payload);
      await onExperimentCreated(res.detail.experiment.id);
    } catch (err) {
      setStatusMsg({ type: 'err', text: (err as Error).message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Predictor Real de Umbrales en Páginas Web
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Mida tiempos de respuesta reales mediante sondeo HTTP autorizado (≤5 req/s), logs de acceso o métricas Prometheus, calibre la capacidad μ y calcule λ* con Newton-Raphson y el método de la Secante.
        </p>
      </div>

      {statusMsg && (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm ${
            statusMsg.type === 'ok'
              ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200'
              : 'border-red-300 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-900 dark:text-red-200'
          }`}
        >
          {statusMsg.text}
        </div>
      )}

      {/* Paso 1: Página Web objetivo */}
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              1. Página web objetivo
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setShowNewUrlForm((v) => !v)}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            {showNewUrlForm ? 'Elegir sitio ya registrado' : '+ Ingresar nueva URL'}
          </button>
        </div>

        {showNewUrlForm ? (
          <form onSubmit={handleRegisterUrl} className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-1">
            <div className="md:col-span-5">
              <label htmlFor="web-new-url" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                URL completa de la página o endpoint
              </label>
              <input
                id="web-new-url"
                type="url"
                required
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://tudominio.com/ o http://127.0.0.1:3000/mock-target"
                className="w-full px-3 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="md:col-span-3">
              <label htmlFor="web-new-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Nombre identificador
              </label>
              <input
                id="web-new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Ej. Portal Principal"
                className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="md:col-span-2">
              <label htmlFor="web-new-env" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Entorno
              </label>
              <select
                id="web-new-env"
                value={newEnv}
                onChange={(e) => setNewEnv(e.target.value as typeof newEnv)}
                className="w-full px-2.5 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="PRODUCCION">PRODUCCIÓN</option>
                <option value="STAGING">STAGING</option>
                <option value="LABORATORIO">LABORATORIO</option>
              </select>
            </div>
            <div className="md:col-span-2 flex items-end">
              <button
                type="submit"
                disabled={registering}
                className="w-full px-3 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
              >
                {registering ? 'Validando...' : 'Guardar URL'}
              </button>
            </div>
          </form>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="md:col-span-2">
              <label htmlFor="web-target-select" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Sitio web seleccionado
              </label>
              <select
                id="web-target-select"
                value={selectedTargetId}
                onChange={(e) => setSelectedTargetId(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {t.baseUrl}
                  </option>
                ))}
              </select>
            </div>
            {activeTarget && (
              <div className="text-xs text-slate-600 dark:text-slate-300 space-y-0.5 tabular-nums">
                <div>
                  Entorno: <span className="font-mono font-medium">{activeTarget.environment}</span>
                </div>
                <div>
                  Última capacidad:{' '}
                  <span className="font-mono font-medium">
                    {activeTarget.profile ? `${activeTarget.profile.muDeclared.toFixed(1)} req/s (${activeTarget.profile.muSource})` : 'Sin calibrar'}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Paso 2: Fuente real de medición */}
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            2. Método de recolección de datos reales
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Todos producen métricas con procedencia MEDIDO + predicción λ*
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(
            [
              {
                id: 'PROBE' as const,
                icon: <Radio className="w-4 h-4" />,
                title: 'Sondeo HTTP en vivo (URL)',
                desc: 'Envía peticiones GET/HEAD seguras (≤5 req/s) para medir S₀, jitter CV, cabeceras y calibrar λ*.',
              },
              {
                id: 'LOG' as const,
                icon: <FileText className="w-4 h-4" />,
                title: 'Logs reales del sitio web',
                desc: 'Analiza registros Nginx/Apache/JSONL/CSV reales con ajuste Theil-Sen + Secante forense.',
              },
              {
                id: 'PROMETHEUS' as const,
                icon: <Globe className="w-4 h-4" />,
                title: 'Métricas Prometheus reales',
                desc: 'Consulta rango PromQL de tasa y latencia real del sitio sin generar tráfico adicional.',
              },
            ]
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setMode(opt.id)}
              className={`text-left p-4 rounded-lg border transition-colors ${
                mode === opt.id
                  ? 'border-blue-600 bg-blue-50/60 dark:bg-blue-950/30'
                  : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                {opt.icon}
                <span>{opt.title}</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                {opt.desc}
              </p>
            </button>
          ))}
        </div>

        {/* Configuración específica de PROBE */}
        {mode === 'PROBE' && activeTarget && (
          <div className="space-y-4 pt-3 border-t border-slate-200 dark:border-slate-800">
            {/* Bloque de autorización y verificación de propiedad */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  {probeAuthorizedReady ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span>
                        Objetivo autorizado para sondeo ({auth?.method}) · Válido hasta{' '}
                        {new Date(auth!.expiresAt).toLocaleDateString('es-ES')}
                      </span>
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                      <span>
                        {targetIsPrivate
                          ? 'Requiere registro de autorización local/privada antes de sondear'
                          : 'Dominio público: requiere token y verificación de propiedad antes de sondear'}
                      </span>
                    </>
                  )}
                </div>

                {activeTarget.cooldownRemainingS > 0 && (
                  <span className="text-xs font-mono text-amber-600 dark:text-amber-400">
                    Enfriamiento: {activeTarget.cooldownRemainingS} s
                  </span>
                )}
              </div>

              {!probeAuthorizedReady && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Método de verificación de propiedad"
                      value={verifyMethod}
                      onChange={(e) => setVerifyMethod(e.target.value as typeof verifyMethod)}
                      className="px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                    >
                      <option value="WELL_KNOWN">Archivo /.well-known/umbral-verify.txt</option>
                      <option value="DNS_TXT">Registro DNS TXT (_umbralsim)</option>
                      <option value="HEADER">Cabecera HTTP X-UmbralSim-Verify</option>
                      {targetIsPrivate && (
                        <option value="PRIVATE_AUTH_ONLY">Exención Loopback / Red Privada</option>
                      )}
                    </select>

                    <button
                      type="button"
                      disabled={authLoading}
                      onClick={handleGenerateAuth}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-500 whitespace-nowrap"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>Generar autorización / token</span>
                    </button>

                    {auth && !auth.verifiedAt && verifyMethod !== 'PRIVATE_AUTH_ONLY' && (
                      <button
                        type="button"
                        disabled={authLoading}
                        onClick={handleVerifyNow}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700 whitespace-nowrap"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Verificar propiedad ahora</span>
                      </button>
                    )}
                  </div>

                  {generatedToken && verifyMethod !== 'PRIVATE_AUTH_ONLY' && (
                    <div className="text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-700 dark:text-slate-300">
                          {verifyMethod === 'WELL_KNOWN'
                            ? `Publique este token en ${new URL(activeTarget.baseUrl).origin}/.well-known/umbral-verify.txt`
                            : verifyMethod === 'DNS_TXT'
                              ? `Agregue un registro TXT en _umbralsim.${new URL(activeTarget.baseUrl).hostname}`
                              : 'Configure la cabecera HTTP X-UmbralSim-Verify con este valor'}
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyToken}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                        >
                          <Copy className="w-3 h-3" />
                          <span>Copiar</span>
                        </button>
                      </div>
                      <div className="font-mono text-[11px] text-blue-600 dark:text-blue-400 break-all">
                        {generatedToken}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <label className="flex items-start gap-2.5 text-xs text-slate-800 dark:text-slate-200 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={explicitConsent}
                  onChange={(e) => setExplicitConsent(e.target.checked)}
                  className="mt-0.5 rounded border-slate-400"
                />
                <span>
                  Declaro explícitamente que soy propietario o cuento con autorización vigente para ejecutar este sondeo controlado de baja intensidad (≤ 5 req/s, respetando robots.txt) sobre{' '}
                  <strong className="font-mono">{activeTarget.baseUrl}</strong>.
                </span>
              </label>
            </div>

            {/* SLA / Modelo / Workers */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="web-model" className="inline-flex items-center gap-1 text-xs font-medium mb-1.5">
                  <span>Modelo de capacidad</span>
                  <HelpTip
                    label="modelo para sitio web"
                    text="M/M/1 estima con 1 servidor; elija M/M/c si el sitio web tiene múltiples workers/réplicas (c) atendiendo en paralelo."
                  />
                </label>
                <select
                  id="web-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value as typeof model)}
                  className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {Object.entries(ES.models).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="web-c" className="inline-flex items-center gap-1 text-xs font-medium mb-1.5">
                  <span>Workers / hilos del servidor (c)</span>
                  <HelpTip
                    label="workers paralelos c"
                    text="Cantidad de instancias, contenedores o workers paralelos que atienden peticiones. La capacidad calibrada escala como c / S₀."
                  />
                </label>
                <input
                  id="web-c"
                  type="number"
                  min={1}
                  max={256}
                  value={workersC}
                  onChange={(e) => setWorkersC(Math.max(1, Number(e.target.value)))}
                  className="w-full px-3 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="inline-flex items-center gap-1 text-xs font-medium">
                    <span>Umbral máximo aceptable (T)</span>
                    <HelpTip
                      label="umbral de latencia T"
                      text="En modo Automático, UmbralSim fija T = 2.5× la latencia real medida del sitio para encontrar el punto de saturación real."
                    />
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAutoTargetT(true)}
                    className={`flex-1 px-2.5 py-2 text-xs font-medium rounded-md border transition-colors ${
                      autoTargetT
                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                        : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Auto (2.5× S₀)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAutoTargetT(false)}
                    className={`flex-1 px-2.5 py-2 text-xs font-medium rounded-md border transition-colors ${
                      !autoTargetT
                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                        : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Fijo manual
                  </button>
                </div>
                {!autoTargetT && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      aria-label="Umbral fijo en segundos"
                      type="number"
                      min={0.01}
                      step={0.05}
                      value={fixedLatencyS}
                      onChange={(e) => setFixedLatencyS(Number(e.target.value))}
                      className="w-24 px-2.5 py-1 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <span className="text-xs font-mono text-slate-500">
                      s ({(fixedLatencyS * 1000).toFixed(0)} ms)
                    </span>
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowProbeAdvanced((v) => !v)}
              className="text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 underline"
            >
              {showProbeAdvanced
                ? 'Ocultar parámetros del sondeo HTTP'
                : 'Ajustar tasa/duración del sondeo (por defecto 3 req/s · 8 s · GET)'}
            </button>

            {showProbeAdvanced && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label htmlFor="wp-meth" className="block text-xs font-medium mb-1">
                    Método
                  </label>
                  <select
                    id="wp-meth"
                    value={probeMethod}
                    onChange={(e) => setProbeMethod(e.target.value as 'GET' | 'HEAD')}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="GET">GET</option>
                    <option value="HEAD">HEAD</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="wp-rps" className="block text-xs font-medium mb-1">
                    Tasa máx. (≤5 req/s)
                  </label>
                  <input
                    id="wp-rps"
                    type="number"
                    min={1}
                    max={5}
                    step={0.5}
                    value={probeRps}
                    onChange={(e) => setProbeRps(Math.min(5, Math.max(1, Number(e.target.value))))}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="wp-dur" className="block text-xs font-medium mb-1">
                    Duración (≤60 s)
                  </label>
                  <input
                    id="wp-dur"
                    type="number"
                    min={4}
                    max={60}
                    value={probeDurationS}
                    onChange={(e) => setProbeDurationS(Math.min(60, Math.max(4, Number(e.target.value))))}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="wp-conc" className="block text-xs font-medium mb-1">
                    Concurrencia (≤2)
                  </label>
                  <input
                    id="wp-conc"
                    type="number"
                    min={1}
                    max={2}
                    value={probeConcurrency}
                    onChange={(e) => setProbeConcurrency(Math.min(2, Math.max(1, Number(e.target.value))))}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Configuración específica de LOG */}
        {mode === 'LOG' && (
          <div className="space-y-4 pt-3 border-t border-slate-200 dark:border-slate-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Subir .log / .csv / .jsonl</span>
                  <input type="file" accept=".log,.txt,.csv,.jsonl" onChange={handleFileUpload} className="sr-only" />
                </label>
                <button
                  type="button"
                  onClick={() => loadSampleLog('nginx_rampa.log')}
                  className="px-2.5 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cargar muestra Nginx
                </button>
                <button
                  type="button"
                  onClick={() => loadSampleLog('latencias_api.csv')}
                  className="px-2.5 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cargar muestra CSV
                </button>
              </div>
              <div className="flex items-center gap-3">
                <label htmlFor="wp-log-win" className="text-xs font-medium">
                  Ventana:
                </label>
                <select
                  id="wp-log-win"
                  value={logWindowS}
                  onChange={(e) => setLogWindowS(Number(e.target.value))}
                  className="px-2 py-1 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value={1}>1 s</option>
                  <option value={5}>5 s</option>
                  <option value={60}>60 s</option>
                </select>
                <label htmlFor="wp-log-t" className="text-xs font-medium">
                  T (s):
                </label>
                <input
                  id="wp-log-t"
                  type="number"
                  min={0.005}
                  step={0.01}
                  value={fixedLatencyS}
                  onChange={(e) => setFixedLatencyS(Number(e.target.value))}
                  className="w-20 px-2 py-1 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
            <textarea
              aria-label="Registros reales del servidor web"
              rows={6}
              value={rawLogText}
              onChange={(e) => setRawLogText(e.target.value)}
              placeholder="Pegue aquí líneas Nginx combinado ($request_time / rt=...), JSON Lines o CSV (timestamp,latency_s,status)..."
              className="w-full p-3 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
            />
          </div>
        )}

        {/* Configuración específica de PROMETHEUS */}
        {mode === 'PROMETHEUS' && (
          <div className="space-y-4 pt-3 border-t border-slate-200 dark:border-slate-800">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="wp-prom-url" className="block text-xs font-medium mb-1">
                  URL base de Prometheus
                </label>
                <input
                  id="wp-prom-url"
                  type="url"
                  value={promUrl}
                  onChange={(e) => setPromUrl(e.target.value)}
                  placeholder="https://prometheus.tudominio.com"
                  className="w-full px-3 py-2 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="wp-prom-win" className="block text-xs font-medium mb-1">
                    Ventana histórica (min)
                  </label>
                  <input
                    id="wp-prom-win"
                    type="number"
                    min={5}
                    max={1440}
                    value={promLookbackMin}
                    onChange={(e) => setPromLookbackMin(Number(e.target.value))}
                    className="w-full px-3 py-2 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="wp-prom-t" className="block text-xs font-medium mb-1">
                    Umbral T (s)
                  </label>
                  <input
                    id="wp-prom-t"
                    type="number"
                    min={0.005}
                    step={0.01}
                    value={fixedLatencyS}
                    onChange={(e) => setFixedLatencyS(Number(e.target.value))}
                    className="w-full px-3 py-2 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="wp-prom-q1" className="block text-xs font-medium mb-1">
                  Query PromQL de tasa λ(t) (req/s)
                </label>
                <input
                  id="wp-prom-q1"
                  value={promRateQuery}
                  onChange={(e) => setPromRateQuery(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="wp-prom-q2" className="block text-xs font-medium mb-1">
                  Query PromQL de latencia media W(t) (s)
                </label>
                <input
                  id="wp-prom-q2"
                  value={promLatQuery}
                  onChange={(e) => setPromLatQuery(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <input
                aria-label="Bearer token opcional de Prometheus"
                type="password"
                value={promToken}
                onChange={(e) => setPromToken(e.target.value)}
                placeholder="Bearer token opcional (solo en memoria)"
                className="w-full sm:w-80 px-3 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={promAllowPrivate}
                  onChange={(e) => setPromAllowPrivate(e.target.checked)}
                />
                <span>Permitir Prometheus en red privada / localhost</span>
              </label>
            </div>
          </div>
        )}

        {/* Progreso en tiempo real cuando está sondeando */}
        {running && mode === 'PROBE' && (
          <div className="rounded-md border border-blue-300 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/30 p-3 text-xs space-y-1.5">
            <div className="font-semibold text-blue-900 dark:text-blue-200">
              Midiendo página web en vivo ({liveProbeSteps.length} escalones completados)...
            </div>
            {liveProbeSteps.length > 0 && (
              <div className="font-mono text-slate-700 dark:text-slate-300 tabular-nums">
                Último escalón: {liveProbeSteps[liveProbeSteps.length - 1].lambdaObs.toFixed(1)} req/s · Media{' '}
                {(liveProbeSteps[liveProbeSteps.length - 1].wMean * 1000).toFixed(1)} ms · p95{' '}
                {(liveProbeSteps[liveProbeSteps.length - 1].wP95 * 1000).toFixed(1)} ms
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Se ejecutarán Newton-Raphson, Secante y Bisección sobre los datos reales medidos del sitio.
          </p>
          <button
            type="button"
            disabled={running}
            onClick={handleRunWebPrediction}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <PlayCircle className="w-4 h-4" />
            <span>
              {running
                ? 'Midiendo y calculando λ*...'
                : mode === 'PROBE'
                  ? 'Medir página web y predecir λ*'
                  : mode === 'LOG'
                    ? 'Analizar logs reales y predecir λ*'
                    : 'Importar Prometheus y predecir λ*'}
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}
