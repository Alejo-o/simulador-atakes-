import React, { useState } from 'react';
import { CheckCircle2, KeyRound, Plus, ShieldCheck } from 'lucide-react';
import { umbralApi, type TargetItem } from '../api/client';
import { HelpTip } from '../components/HelpTip';
import { ES } from '../i18n/es';

interface TargetsPageProps {
  targets: TargetItem[];
  onRefresh: () => Promise<void>;
  onEvaluateSite: (targetId: string) => void;
}

export function TargetsPage({ targets, onRefresh, onEvaluateSite }: TargetsPageProps) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [environment, setEnvironment] = useState('STAGING');
  const [cVal, setCVal] = useState(2);
  const [kVal, setKVal] = useState(150);
  const [timeoutS, setTimeoutS] = useState(0.05);
  const [muDeclared, setMuDeclared] = useState(120);
  const [baseLatencyMs, setBaseLatencyMs] = useState(10);
  const [cv, setCv] = useState(1.0);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [authMethodByTarget, setAuthMethodByTarget] = useState<Record<string, string>>({});
  const [generatedTokenByTarget, setGeneratedTokenByTarget] = useState<Record<string, string>>({});

  const applyMuFromLatency = (mode: 'perWorker' | 'total') => {
    if (!Number.isFinite(baseLatencyMs) || baseLatencyMs <= 0) return;
    const perWorker = 1000 / baseLatencyMs;
    const nextMu = mode === 'total' ? perWorker * Math.max(1, cVal) : perWorker;
    setMuDeclared(Math.round(nextMu * 10) / 10);
  };

  const handleCreateTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      await umbralApi.createTarget({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        environment,
        c: cVal,
        K: kVal,
        timeoutS,
        muDeclared,
        muSource: 'DECLARED',
        serviceCv: cv,
        sloMs: timeoutS * 1000,
      });
      setName('');
      setBaseUrl('');
      setFeedback({ type: 'ok', text: 'Infraestructura registrada con perfil inicial.' });
      await onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleGenerateToken = async (target: TargetItem) => {
    setFeedback(null);
    const isLocal =
      target.baseUrl.includes('127.0.0.1') ||
      target.baseUrl.includes('localhost') ||
      target.baseUrl.includes('10.') ||
      target.baseUrl.includes('192.168.');
    const method = authMethodByTarget[target.id] ?? (isLocal ? 'PRIVATE_AUTH_ONLY' : 'WELL_KNOWN');
    try {
      const res = await umbralApi.createAuthorization(target.id, {
        method,
        expiresHours: 72,
        declaredBy: 'operador@umbralsim.local',
        evidenceNote: `Autorización emitida para ${target.name} (${method})`,
      });
      setGeneratedTokenByTarget((prev) => ({ ...prev, [target.id]: res.rawToken }));
      setFeedback({
        type: 'ok',
        text:
          method === 'PRIVATE_AUTH_ONLY'
            ? 'Autorización local/privada registrada y vigente (72 h).'
            : `Token generado (${method}). Publíquelo en el objetivo y pulse Verificar propiedad.`,
      });
      await onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: (err as Error).message });
    }
  };

  const handleVerify = async (targetId: string, authId: string) => {
    setFeedback(null);
    try {
      const res = await umbralApi.verifyAuthorization(targetId, authId);
      setFeedback({ type: 'ok', text: `Propiedad verificada: ${res.detail}` });
      await onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: (err as Error).message });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Infraestructuras, Autorizaciones y Verificación de Propiedad
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {ES.probeLimitation}
        </p>
      </div>

      {/* Guía rápida de flujo en 3 pasos */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-3.5">
          <div className="font-semibold text-slate-900 dark:text-slate-100">1. Registrar servicio</div>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Defina URL, trabajadores (c) y capacidad μ (o calcúlela desde la latencia base S en ms).
          </p>
        </div>
        <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-3.5">
          <div className="font-semibold text-slate-900 dark:text-slate-100">2. Autorizar (solo sondeo activo)</div>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Para sondeos HTTP reales, genere token y verifique propiedad. Laboratorio y logs no lo requieren.
          </p>
        </div>
        <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-3.5">
          <div className="font-semibold text-slate-900 dark:text-slate-100">3. Evaluar saturación</div>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Pulse «Evaluar sitio» para abrir el Asistente y calcular λ* con respaldo estadístico.
          </p>
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          className={`px-4 py-3 rounded-lg border text-sm ${
            feedback.type === 'ok'
              ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
              : 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form Alta de Infraestructura */}
        <form
          onSubmit={handleCreateTarget}
          className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-4 h-fit"
        >
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Registrar infraestructura
          </h2>

          <div>
            <label htmlFor="target-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Nombre descriptivo
            </label>
            <input
              id="target-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej. API Checkout Staging"
              className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="target-url" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              URL base o endpoint de salud
            </label>
            <input
              id="target-url"
              required
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://staging.midominio.com/health"
              className="w-full px-3 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="target-env" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Entorno
              </label>
              <select
                id="target-env"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                className="w-full px-2.5 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="LABORATORIO">LABORATORIO</option>
                <option value="STAGING">STAGING</option>
                <option value="PRODUCCION">PRODUCCIÓN</option>
              </select>
            </div>
            <div>
              <label htmlFor="target-mu" className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                <span>μ declarado (req/s)</span>
                <HelpTip
                  label="capacidad μ"
                  text="Tasa máxima de atención en peticiones por segundo. Si atiende en 10 ms sin carga, μ = 100 req/s."
                />
              </label>
              <input
                id="target-mu"
                type="number"
                min={1}
                step="0.5"
                value={muDeclared}
                onChange={(e) => setMuDeclared(Number(e.target.value))}
                className="w-full px-2.5 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          {/* Asistente rápido μ = c / S */}
          <div className="rounded-md bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
              ¿No conoce μ? Calcúlelo desde su latencia en reposo S (ms)
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="target-s-ms" className="text-xs text-slate-600 dark:text-slate-400">
                S (ms):
              </label>
              <input
                id="target-s-ms"
                type="number"
                min={0.5}
                step={0.5}
                value={baseLatencyMs}
                onChange={(e) => setBaseLatencyMs(Number(e.target.value))}
                className="w-20 px-2 py-1 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <button
                type="button"
                onClick={() => applyMuFromLatency('perWorker')}
                className="px-2.5 py-1 text-[11px] font-medium rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-500 whitespace-nowrap"
              >
                Aplicar 1/S ({baseLatencyMs > 0 ? (1000 / baseLatencyMs).toFixed(1) : '—'})
              </button>
              <button
                type="button"
                onClick={() => applyMuFromLatency('total')}
                className="px-2.5 py-1 text-[11px] font-medium rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-500 whitespace-nowrap"
              >
                Aplicar c/S ({baseLatencyMs > 0 ? ((cVal * 1000) / baseLatencyMs).toFixed(1) : '—'})
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label htmlFor="target-c" className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                <span>Workers (c)</span>
                <HelpTip label="workers c" text="Cantidad de hilos, procesos o instancias paralelas del servicio." />
              </label>
              <input
                id="target-c"
                type="number"
                min={1}
                value={cVal}
                onChange={(e) => setCVal(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label htmlFor="target-k" className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                <span>Cola (K)</span>
                <HelpTip label="cola K" text="Límite máximo de conexiones simultáneas en cola antes de devolver rechazo 503." />
              </label>
              <input
                id="target-k"
                type="number"
                min={1}
                value={kVal}
                onChange={(e) => setKVal(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label htmlFor="target-t" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Timeout T (s)
              </label>
              <input
                id="target-t"
                type="number"
                min={0.005}
                step="0.005"
                value={timeoutS}
                onChange={(e) => setTimeoutS(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
          </div>

          <div>
            <label htmlFor="target-cv" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Coeficiente de variación del servicio (CV)
            </label>
            <input
              id="target-cv"
              type="number"
              min={0.1}
              max={5}
              step="0.05"
              value={cv}
              onChange={(e) => setCv(Number(e.target.value))}
              className="w-full px-2.5 py-1.5 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>{submitting ? 'Guardando...' : 'Registrar objetivo'}</span>
          </button>
        </form>

        {/* Lista de Objetivos */}
        <div className="lg:col-span-2 space-y-4">
          {targets.map((t) => {
            const auth = t.authorization;
            const isVerified = Boolean(auth?.verifiedAt);
            const isExpired = auth ? Date.parse(auth.expiresAt) <= Date.now() : true;

            return (
              <article
                key={t.id}
                className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        {t.name}
                      </h3>
                      <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                        · {t.environment}
                      </span>
                    </div>
                    <p className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-0.5 break-all">
                      {t.baseUrl}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => onEvaluateSite(t.id)}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 transition-opacity whitespace-nowrap"
                  >
                    Evaluar sitio
                  </button>
                </div>

                {t.profile && (
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs font-mono text-slate-600 dark:text-slate-300 py-2 border-y border-slate-100 dark:border-slate-800 tabular-nums">
                    <span>c = {t.profile.c}</span>
                    <span>K = {t.profile.K}</span>
                    <span>T = {(t.profile.timeoutS * 1000).toFixed(0)} ms</span>
                    <span>μ = {t.profile.muDeclared} req/s ({t.profile.muSource})</span>
                    <span>CV = {t.profile.serviceCv}</span>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2">
                    {isVerified && !isExpired ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-medium">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>
                          Propiedad verificada ({auth?.method}) · Expira{' '}
                          {new Date(auth!.expiresAt).toLocaleDateString('es-ES')}
                        </span>
                      </span>
                    ) : auth ? (
                      <span className="text-amber-700 dark:text-amber-400 font-medium">
                        ▲ Pendiente de verificación ({auth.method})
                      </span>
                    ) : (
                      <span className="text-slate-500 dark:text-slate-400">
                        Sin registro de autorización (solo laboratorio o análisis pasivo de logs)
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={`Método de verificación para ${t.name}`}
                      value={authMethodByTarget[t.id] ?? 'WELL_KNOWN'}
                      onChange={(e) =>
                        setAuthMethodByTarget((prev) => ({ ...prev, [t.id]: e.target.value }))
                      }
                      className="px-2 py-1 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="WELL_KNOWN">/.well-known/umbral-verify.txt</option>
                      <option value="DNS_TXT">Registro DNS TXT</option>
                      <option value="HEADER">Cabecera X-UmbralSim-Verify</option>
                      <option value="PRIVATE_AUTH_ONLY">Exención Loopback / Red Privada</option>
                    </select>

                    <button
                      type="button"
                      onClick={() => handleGenerateToken(t)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>Generar autorización</span>
                    </button>

                    {auth && !auth.verifiedAt && (
                      <button
                        type="button"
                        onClick={() => handleVerify(t.id, auth.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700 whitespace-nowrap"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Verificar propiedad</span>
                      </button>
                    )}
                  </div>
                </div>

                {(generatedTokenByTarget[t.id] || auth?.rawTokenPreview) && (
                  <div className="text-[11px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-3 py-2 text-slate-700 dark:text-slate-300">
                    Token: {generatedTokenByTarget[t.id] ?? auth?.rawTokenPreview}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
