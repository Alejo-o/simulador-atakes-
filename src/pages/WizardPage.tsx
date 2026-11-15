import React, { useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, PlayCircle, Upload } from 'lucide-react';
import { umbralApi, type TargetItem } from '../api/client';
import { HelpTip } from '../components/HelpTip';
import { ES } from '../i18n/es';

interface WizardPageProps {
  targets: TargetItem[];
  initialTargetId: string | null;
  onExperimentCreated: (experimentId: string) => void;
}

export function WizardPage({ targets, initialTargetId, onExperimentCreated }: WizardPageProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [targetId, setTargetId] = useState<string>(initialTargetId ?? targets[0]?.id ?? '');
  const [sourceKind, setSourceKind] = useState<'LAB' | 'LOG' | 'PROBE' | 'DECLARED'>('LAB');

  // Parámetros de laboratorio
  const [labScenario, setLabScenario] = useState<'RAMP' | 'STEP' | 'PULSE' | 'SURGE' | 'STEADY'>('RAMP');
  const [labDurationS, setLabDurationS] = useState(24);
  const [labLambdaStart, setLabLambdaStart] = useState(15);
  const [labLambdaPeak, setLabLambdaPeak] = useState(92);

  // Parámetros de logs
  const [rawLogText, setRawLogText] = useState('');
  const [logWindowS, setLogWindowS] = useState(5);

  // Parámetros de sondeo autorizado (topados en UI y en backend)
  const [probeMethod, setProbeMethod] = useState<'GET' | 'HEAD'>('GET');
  const [probeRps, setProbeRps] = useState(3);
  const [probeDurationS, setProbeDurationS] = useState(6);
  const [probeConcurrency, setProbeConcurrency] = useState(1);
  const [explicitConsent, setExplicitConsent] = useState(false);

  // Modelo y función objetivo
  const [model, setModel] = useState<'MM1' | 'MM1K' | 'MMC' | 'MG1' | 'EMPIRICAL'>('MM1');
  const [objectiveType, setObjectiveType] = useState<
    'MEAN_LATENCY' | 'PERCENTILE_LATENCY' | 'TIMEOUT_PROBABILITY' | 'EMPIRICAL_LATENCY'
  >('MEAN_LATENCY');
  const [targetLatencyS, setTargetLatencyS] = useState(0.05);
  const [percentile, setPercentile] = useState(0.95);
  const [timeoutEpsilon, setTimeoutEpsilon] = useState(0.05);

  // Parámetros numéricos
  const [muOverride, setMuOverride] = useState<string>('');
  const [cVal, setCVal] = useState(2);
  const [kVal, setKVal] = useState(120);
  const [cvVal, setCvVal] = useState(1.0);
  const [newtonSeed, setNewtonSeed] = useState<string>('');
  const [secantS0, setSecantS0] = useState<string>('');
  const [secantS1, setSecantS1] = useState<string>('');
  const [tol, setTol] = useState(1e-12);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const [showAdvancedModel, setShowAdvancedModel] = useState(false);
  const [showAdvancedSolvers, setShowAdvancedSolvers] = useState(false);

  const loadSample = async (name: 'nginx_rampa.log' | 'latencias_api.csv') => {
    try {
      const res = await umbralApi.getSampleLog(name);
      setRawLogText(res.content);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const applyPreset = async (preset: 'LAB_RAMP' | 'LOG_NGINX' | 'PROBE_MOCK') => {
    setError(null);
    const localMock =
      targets.find((t) => t.baseUrl.includes('mock-target') || t.baseUrl.includes('127.0.0.1')) ?? targets[0];
    if (localMock) setTargetId(localMock.id);

    if (preset === 'LAB_RAMP') {
      setSourceKind('LAB');
      setLabScenario('RAMP');
      setLabDurationS(24);
      setLabLambdaStart(15);
      setLabLambdaPeak(92);
      setModel('MM1');
      setObjectiveType('MEAN_LATENCY');
      setTargetLatencyS(0.05);
      setMuOverride('');
      setNewtonSeed('');
      setSecantS0('');
      setSecantS1('');
      setPresetNote('Plantilla aplicada: simulación de rampa en laboratorio (15 → 92 req/s, T = 50 ms).');
    } else if (preset === 'LOG_NGINX') {
      setSourceKind('LOG');
      setLogWindowS(5);
      setModel('MM1');
      setObjectiveType('MEAN_LATENCY');
      setTargetLatencyS(0.05);
      setMuOverride('');
      setNewtonSeed('');
      setSecantS0('');
      setSecantS1('');
      await loadSample('nginx_rampa.log');
      setPresetNote('Plantilla aplicada: log forense de Nginx cargado (ventanas de 5 s, ajuste robusto Theil-Sen).');
    } else {
      setSourceKind('PROBE');
      setProbeMethod('GET');
      setProbeRps(3);
      setProbeDurationS(6);
      setProbeConcurrency(1);
      // Nunca pre-marcar autorización explícita (regla obligatoria)
      setExplicitConsent(false);
      setModel('MM1');
      setObjectiveType('MEAN_LATENCY');
      setTargetLatencyS(0.05);
      setPresetNote('Plantilla aplicada: sondeo seguro sobre Mock Local (3 req/s, 6 s). Marque la autorización explícita abajo antes de ejecutar.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRawLogText(String(reader.result ?? ''));
    };
    reader.readAsText(file);
  };

  const handleExecute = async () => {
    if (!targetId) {
      setError('Seleccione una infraestructura objetivo.');
      return;
    }
    if (!Number.isFinite(targetLatencyS) || targetLatencyS < 0.005) {
      setError('El límite de latencia T debe ser al menos 0.005 s (5 ms).');
      return;
    }
    if (sourceKind === 'LOG' && !rawLogText.trim()) {
      setError('Para análisis forense de logs debe subir un archivo o cargar una muestra.');
      return;
    }
    if (sourceKind === 'PROBE' && !explicitConsent) {
      setError('Para ejecutar un sondeo activo debe marcar la casilla de autorización explícita.');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        targetId,
        sourceKind,
        model,
        objective: {
          type: objectiveType,
          targetLatencyS,
          percentile,
          timeoutEpsilon,
        },
        c: cVal,
        K: kVal,
        cv: cvVal,
        tol,
      };
      if (muOverride.trim()) payload.muOverride = Number(muOverride);
      if (newtonSeed.trim()) payload.newtonSeed = Number(newtonSeed);
      if (secantS0.trim() && secantS1.trim()) {
        payload.secantSeeds = [Number(secantS0), Number(secantS1)];
      }

      if (sourceKind === 'LAB') {
        payload.labScenario = labScenario;
        payload.labDurationS = labDurationS;
        payload.labLambdaStart = labLambdaStart;
        payload.labLambdaPeak = labLambdaPeak;
      } else if (sourceKind === 'LOG') {
        payload.rawLogText = rawLogText;
        payload.logWindowS = logWindowS;
      } else if (sourceKind === 'PROBE') {
        payload.probeMethod = probeMethod;
        payload.probeRps = probeRps;
        payload.probeDurationS = probeDurationS;
        payload.probeConcurrency = probeConcurrency;
        payload.explicitAuthorizationChecked = explicitConsent;
        payload.autoTargetLatency = true;
      }

      const res = await umbralApi.runExperiment(payload);
      onExperimentCreated(res.detail.experiment.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Asistente de Nuevo Experimento
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Configure la fuente de datos, el modelo de teoría de colas y los métodos numéricos para calcular λ*.
        </p>
      </div>

      {/* Stepper indicator */}
      <div className="space-y-2 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 1 as const, label: '1. Objetivo y Fuente' },
            { id: 2 as const, label: '2. Modelo y Umbral' },
            { id: 3 as const, label: '3. Revisar y Ejecutar' },
          ].map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStep(s.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                step === s.id
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {step === 1
            ? 'Pasos 1–2 de 7: elija el tipo de análisis y la infraestructura o laboratorio. Puede ejecutar directo con valores recomendados o personalizar.'
            : step === 2
              ? 'Paso 3 de 7: defina el tiempo máximo aceptable (T). Los parámetros matemáticos avanzados ya tienen valores seguros por defecto.'
              : 'Paso 4 de 7: ejecute el análisis; luego visualizará el Dashboard, comparación Newton vs. Secante y descarga de informe.'}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 rounded-lg px-4 py-3 text-sm text-red-800 dark:text-red-200"
        >
          {error}
        </div>
      )}

      {step === 1 && (
        <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-6 space-y-5">
          {/* Plantillas rápidas de 1 clic */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                Plantillas listas para probar (1 clic)
              </span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                Configura fuente, modelo M/M/1 y T = 50 ms automáticamente
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => applyPreset('LAB_RAMP')}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:border-blue-500 transition-colors whitespace-nowrap"
              >
                Simular ataque en rampa (Lab M/M/1)
              </button>
              <button
                type="button"
                onClick={() => applyPreset('LOG_NGINX')}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:border-blue-500 transition-colors whitespace-nowrap"
              >
                Analizar log real de Nginx (Forense)
              </button>
              <button
                type="button"
                onClick={() => applyPreset('PROBE_MOCK')}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:border-blue-500 transition-colors whitespace-nowrap"
              >
                Probar sondeo seguro en Mock Local
              </button>
            </div>
            {presetNote && (
              <p className="text-xs text-blue-700 dark:text-blue-300">{presetNote}</p>
            )}
          </div>

          <div>
            <label htmlFor="wiz-target" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Infraestructura objetivo
            </label>
            <select
              id="wiz-target"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.baseUrl})
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              Fuente de datos (define la procedencia MEDIDO / SIMULADO / PREDICHO)
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(
                [
                  {
                    id: 'LAB',
                    title: 'Laboratorio (Simulador DES)',
                    desc: 'Simulador de eventos discretos en memoria sin tráfico de red.',
                  },
                  {
                    id: 'LOG',
                    title: 'Análisis Forense de Logs',
                    desc: 'Parser de Nginx combinado, JSON Lines o CSV con ajuste robusto de μ.',
                  },
                  {
                    id: 'PROBE',
                    title: 'Sondeo Activo Autorizado',
                    desc: 'Baja intensidad (≤5 req/s, ≤60 s) con verificación de propiedad y SSRF.',
                  },
                  {
                    id: 'DECLARED',
                    title: 'Perfil Declarado / Analítico',
                    desc: 'Evalúa μ y parámetros declarados de la infraestructura.',
                  },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSourceKind(opt.id)}
                  className={`text-left p-3.5 rounded-lg border transition-colors ${
                    sourceKind === opt.id
                      ? 'border-blue-600 bg-blue-50/60 dark:bg-blue-950/30'
                      : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{opt.title}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {sourceKind === 'LAB' && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
              <div>
                <label htmlFor="lab-scen" className="block text-xs font-medium mb-1">
                  Escenario
                </label>
                <select
                  id="lab-scen"
                  value={labScenario}
                  onChange={(e) => setLabScenario(e.target.value as typeof labScenario)}
                  className="w-full px-2.5 py-1.5 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="RAMP">Rampa</option>
                  <option value="STEP">Escalón</option>
                  <option value="PULSE">Pulso</option>
                  <option value="SURGE">Oleada</option>
                  <option value="STEADY">Estacionario</option>
                </select>
              </div>
              <div>
                <label htmlFor="lab-dur" className="block text-xs font-medium mb-1">
                  Duración (s)
                </label>
                <input
                  id="lab-dur"
                  type="number"
                  min={5}
                  max={120}
                  value={labDurationS}
                  onChange={(e) => setLabDurationS(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="lab-l0" className="block text-xs font-medium mb-1">
                  λ inicial (req/s)
                </label>
                <input
                  id="lab-l0"
                  type="number"
                  min={1}
                  value={labLambdaStart}
                  onChange={(e) => setLabLambdaStart(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="lab-l1" className="block text-xs font-medium mb-1">
                  λ pico (req/s)
                </label>
                <input
                  id="lab-l1"
                  type="number"
                  min={1}
                  value={labLambdaPeak}
                  onChange={(e) => setLabLambdaPeak(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
          )}

          {sourceKind === 'LOG' && (
            <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Upload className="w-3.5 h-3.5" />
                    <span>Subir .log / .csv / .jsonl</span>
                    <input type="file" accept=".log,.txt,.csv,.jsonl" onChange={handleFileUpload} className="sr-only" />
                  </label>
                  <button
                    type="button"
                    onClick={() => loadSample('nginx_rampa.log')}
                    className="px-2.5 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Cargar muestra Nginx
                  </button>
                  <button
                    type="button"
                    onClick={() => loadSample('latencias_api.csv')}
                    className="px-2.5 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Cargar muestra CSV
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <label htmlFor="log-win" className="text-xs font-medium">
                    Ventana:
                  </label>
                  <select
                    id="log-win"
                    value={logWindowS}
                    onChange={(e) => setLogWindowS(Number(e.target.value))}
                    className="px-2 py-1 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value={1}>1 s</option>
                    <option value={5}>5 s</option>
                    <option value={60}>60 s</option>
                  </select>
                </div>
              </div>

              <textarea
                aria-label="Contenido del archivo de log"
                rows={5}
                value={rawLogText}
                onChange={(e) => setRawLogText(e.target.value)}
                placeholder="Pegue aquí líneas Nginx combinado (con rt=...), JSON Lines o CSV (timestamp,latency_s,status)..."
                className="w-full p-3 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
          )}

          {sourceKind === 'PROBE' && (
            <div className="space-y-4 pt-2 border-t border-slate-200 dark:border-slate-800">
              <div className="text-xs text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/60 p-3 rounded">
                Límites inmutables activos: máx. 5 req/s, máx. 60 s, concurrencia máx. 2, solo GET/HEAD sin cuerpo, enfriamiento de 5 min por objetivo, respeto de robots.txt y aborto automático ante 429/503 o p95 &gt; 3× línea base.
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label htmlFor="pr-meth" className="block text-xs font-medium mb-1">
                    Método HTTP
                  </label>
                  <select
                    id="pr-meth"
                    value={probeMethod}
                    onChange={(e) => setProbeMethod(e.target.value as 'GET' | 'HEAD')}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="GET">GET</option>
                    <option value="HEAD">HEAD</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="pr-rps" className="block text-xs font-medium mb-1">
                    Tasa máx. (≤ 5 req/s)
                  </label>
                  <input
                    id="pr-rps"
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
                  <label htmlFor="pr-dur" className="block text-xs font-medium mb-1">
                    Duración (≤ 60 s)
                  </label>
                  <input
                    id="pr-dur"
                    type="number"
                    min={2}
                    max={60}
                    value={probeDurationS}
                    onChange={(e) => setProbeDurationS(Math.min(60, Math.max(2, Number(e.target.value))))}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="pr-conc" className="block text-xs font-medium mb-1">
                    Concurrencia (≤ 2)
                  </label>
                  <input
                    id="pr-conc"
                    type="number"
                    min={1}
                    max={2}
                    value={probeConcurrency}
                    onChange={(e) => setProbeConcurrency(Math.min(2, Math.max(1, Number(e.target.value))))}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <label className="flex items-start gap-2.5 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={explicitConsent}
                  onChange={(e) => setExplicitConsent(e.target.checked)}
                  className="mt-0.5 rounded border-slate-400"
                />
                <span>
                  Declaro explícitamente que poseo autorización escrita vigente para ejecutar este sondeo de baja intensidad sobre el objetivo seleccionado.
                </span>
              </label>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              disabled={running}
              onClick={handleExecute}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              <span>{running ? 'Ejecutando...' : 'Ejecutar ahora con valores recomendados'}</span>
            </button>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap"
            >
              <span>Personalizar modelo y objetivo</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="wiz-model" className="inline-flex items-center gap-1.5 text-xs font-medium mb-1.5">
                <span>Modelo de teoría de colas</span>
                <HelpTip
                  label="modelo de colas"
                  text="M/M/1 es el modelo base recomendado para un servidor; use M/M/c para múltiples trabajadores o M/G/1 si las latencias varían mucho."
                />
              </label>
              <select
                id="wiz-model"
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
              <label htmlFor="wiz-obj" className="inline-flex items-center gap-1.5 text-xs font-medium mb-1.5">
                <span>Criterio de saturación f(λ) = 0</span>
                <HelpTip
                  label="criterio de saturación"
                  text="Define qué condición de latencia o timeout marca el límite crítico λ*."
                />
              </label>
              <select
                id="wiz-obj"
                value={objectiveType}
                onChange={(e) => setObjectiveType(e.target.value as typeof objectiveType)}
                className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {Object.entries(ES.objectives).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="wiz-t" className="inline-flex items-center gap-1 text-xs font-medium">
                  <span>Límite de latencia T (s)</span>
                  <HelpTip
                    label="límite de latencia T"
                    text="Tiempo máximo aceptable por petición. Por ejemplo, 0.05 s equivale a 50 milisegundos."
                  />
                </label>
                <span className="text-[11px] font-mono text-blue-600 dark:text-blue-400 tabular-nums">
                  = {(targetLatencyS * 1000).toFixed(0)} ms
                </span>
              </div>
              <input
                id="wiz-t"
                type="number"
                min={0.005}
                step={0.005}
                value={targetLatencyS}
                onChange={(e) => setTargetLatencyS(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {[0.025, 0.05, 0.1, 0.2].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setTargetLatencyS(val)}
                    className={`px-2 py-0.5 text-[11px] font-mono rounded border ${
                      Math.abs(targetLatencyS - val) < 1e-6
                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                        : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {(val * 1000).toFixed(0)} ms
                  </button>
                ))}
              </div>
            </div>

            {objectiveType === 'PERCENTILE_LATENCY' && (
              <div>
                <label htmlFor="wiz-p" className="block text-xs font-medium mb-1">
                  Percentil p (0.5 – 0.999)
                </label>
                <input
                  id="wiz-p"
                  type="number"
                  min={0.5}
                  max={0.999}
                  step={0.01}
                  value={percentile}
                  onChange={(e) => setPercentile(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
                <p className="text-[11px] text-slate-500 mt-1">Ej. 0.95 exige que el 95% responda antes de T.</p>
              </div>
            )}

            {objectiveType === 'TIMEOUT_PROBABILITY' && (
              <div>
                <label htmlFor="wiz-eps" className="block text-xs font-medium mb-1">
                  Tolerancia timeout ε
                </label>
                <input
                  id="wiz-eps"
                  type="number"
                  min={0.001}
                  max={0.5}
                  step={0.01}
                  value={timeoutEpsilon}
                  onChange={(e) => setTimeoutEpsilon(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
                <p className="text-[11px] text-slate-500 mt-1">Ej. 0.05 = máx. 5% de peticiones exceden T.</p>
              </div>
            )}
          </div>

          {/* Acordeón de divulgación progresiva para parámetros matemáticos avanzados */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-3">
            <button
              type="button"
              aria-expanded={showAdvancedModel}
              onClick={() => setShowAdvancedModel((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:border-slate-400 dark:hover:border-slate-600 transition-colors"
            >
              <span>Configuración matemática avanzada (opcional — valores recomendados activos)</span>
              {showAdvancedModel ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showAdvancedModel && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                <div>
                  <label htmlFor="wiz-mu" className="inline-flex items-center gap-1 text-xs font-medium mb-1">
                    <span>μ manual (opcional)</span>
                    <HelpTip
                      label="tasa de servicio μ"
                      text="Capacidad del servidor en req/s. Déjelo vacío para estimarlo automáticamente desde logs o perfil."
                    />
                  </label>
                  <input
                    id="wiz-mu"
                    type="number"
                    placeholder="Automática"
                    value={muOverride}
                    onChange={(e) => setMuOverride(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Déjelo vacío para usar logs o perfil.</p>
                </div>
                <div>
                  <label htmlFor="wiz-c" className="inline-flex items-center gap-1 text-xs font-medium mb-1">
                    <span>Servidores (c)</span>
                    <HelpTip
                      label="servidores c"
                      text="Número de workers o núcleos paralelos atendiendo la cola (aplica en modelo M/M/c)."
                    />
                  </label>
                  <input
                    id="wiz-c"
                    type="number"
                    min={1}
                    value={cVal}
                    onChange={(e) => setCVal(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Trabajadores paralelos (M/M/c).</p>
                </div>
                <div>
                  <label htmlFor="wiz-k" className="inline-flex items-center gap-1 text-xs font-medium mb-1">
                    <span>Capacidad (K)</span>
                    <HelpTip
                      label="capacidad K"
                      text="Máximo de peticiones simultáneas admitidas en cola + servicio antes de rechazar (M/M/1/K)."
                    />
                  </label>
                  <input
                    id="wiz-k"
                    type="number"
                    min={1}
                    value={kVal}
                    onChange={(e) => setKVal(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Límite de cola + servicio (M/M/1/K).</p>
                </div>
                <div>
                  <label htmlFor="wiz-cv" className="inline-flex items-center gap-1 text-xs font-medium mb-1">
                    <span>CV servicio</span>
                    <HelpTip
                      label="coeficiente de variación"
                      text="Variabilidad del tiempo de servicio (desviación estándar / media). 1.0 corresponde a tiempos exponenciales."
                    />
                  </label>
                  <input
                    id="wiz-cv"
                    type="number"
                    min={0.05}
                    max={4}
                    step={0.05}
                    value={cvVal}
                    onChange={(e) => setCvVal(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Dispersión de latencias (M/G/1).</p>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="px-4 py-2 text-sm font-medium rounded-md border border-slate-300 dark:border-slate-700"
            >
              Atrás
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
            >
              <span>Continuar a Solvers</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-6 space-y-5">
          <div className="rounded-md bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-4 space-y-2 text-xs">
            <div className="font-semibold text-slate-900 dark:text-slate-100">
              Resumen listo para ejecutar
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-600 dark:text-slate-300 font-mono tabular-nums">
              <span>Fuente: {sourceKind}</span>
              <span>Modelo: {model}</span>
              <span>Umbral T: {(targetLatencyS * 1000).toFixed(0)} ms</span>
              <span>Semillas: {newtonSeed || secantS0 ? 'Manual' : 'Automáticas seguras'}</span>
            </div>
            <p className="text-slate-500 dark:text-slate-400">
              Se ejecutarán en paralelo Newton-Raphson, Secante y Bisección para comparar precisión y costo de evaluaciones.
            </p>
          </div>

          <button
            type="button"
            aria-expanded={showAdvancedSolvers}
            onClick={() => setShowAdvancedSolvers((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:border-slate-400 dark:hover:border-slate-600 transition-colors"
          >
            <span>Opciones numéricas avanzadas (semillas iniciales y tolerancia)</span>
            {showAdvancedSolvers ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showAdvancedSolvers && (
            <div className="space-y-3">
              <div className="text-xs text-slate-600 dark:text-slate-300">
                Si deja las semillas en blanco, UmbralSim busca automáticamente un intervalo seguro dentro de [0, μ). Ingrese semillas manuales solo si desea analizar sensibilidad o divergencias.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div>
                  <label htmlFor="wiz-nseed" className="block text-xs font-medium mb-1">
                    Semilla Newton λ₀ (opcional)
                  </label>
                  <input
                    id="wiz-nseed"
                    type="number"
                    placeholder="Automática"
                    value={newtonSeed}
                    onChange={(e) => setNewtonSeed(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="wiz-s0" className="block text-xs font-medium mb-1">
                    Semilla Secante λ₀
                  </label>
                  <input
                    id="wiz-s0"
                    type="number"
                    placeholder="Automática"
                    value={secantS0}
                    onChange={(e) => setSecantS0(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="wiz-s1" className="block text-xs font-medium mb-1">
                    Semilla Secante λ₁
                  </label>
                  <input
                    id="wiz-s1"
                    type="number"
                    placeholder="Automática"
                    value={secantS1}
                    onChange={(e) => setSecantS1(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="wiz-tol" className="block text-xs font-medium mb-1">
                    Tolerancia
                  </label>
                  <select
                    id="wiz-tol"
                    value={tol}
                    onChange={(e) => setTol(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 text-sm font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value={1e-6}>1e-6</option>
                    <option value={1e-9}>1e-9</option>
                    <option value={1e-12}>1e-12</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="px-4 py-2 text-sm font-medium rounded-md border border-slate-300 dark:border-slate-700"
            >
              Atrás
            </button>
            <button
              type="button"
              disabled={running}
              onClick={handleExecute}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <PlayCircle className="w-4 h-4" />
              <span>{running ? 'Ejecutando experimento...' : 'Ejecutar experimento'}</span>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
