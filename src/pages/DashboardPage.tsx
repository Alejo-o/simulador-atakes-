import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileBarChart2,
  GitCompare,
  Globe,
  Pause,
  Play,
  RotateCcw,
  StepForward,
} from 'lucide-react';
import {
  umbralApi,
  type ExperimentDetailDto,
  type ExperimentSummary,
  type MathAnalysisResponse,
} from '../api/client';
import { ErrorConvergenceChart } from '../charts/ErrorConvergenceChart';
import { LatencyCurveChart } from '../charts/LatencyCurveChart';
import { HelpTip } from '../components/HelpTip';
import { ProvenanceTag } from '../components/ProvenanceMark';
import { ES } from '../i18n/es';

interface DashboardPageProps {
  experiments: ExperimentSummary[];
  selectedExperimentId: string | null;
  onSelectExperiment: (id: string) => void;
  onNavigateWizard: () => void;
  onNavigateWeb?: () => void;
  onNavigateComparison?: () => void;
  onNavigateReports?: () => void;
  liveWindows: Array<{
    lambdaObs: number;
    wMean: number;
    wP50: number;
    wP95: number;
    wP99: number;
    provenance: 'MEASURED' | 'SIMULATED' | 'PREDICTED';
  }>;
}

const SOLVER_LABELS: Record<string, string> = {
  NEWTON: 'Newton-Raphson',
  SECANT: 'Secante',
  BISECTION: 'Bisección',
};

const CRITERION_LABELS: Record<string, string> = {
  TOL_F: 'Precisión en f(λ)',
  TOL_X: 'Paso mínimo Δλ',
  EXACT: 'Raíz exacta',
  MAX_ITER: 'Máx. iteraciones',
};

export function DashboardPage({
  experiments,
  selectedExperimentId,
  onSelectExperiment,
  onNavigateWizard,
  onNavigateWeb,
  onNavigateComparison,
  onNavigateReports,
  liveWindows,
}: DashboardPageProps) {
  const [detail, setDetail] = useState<ExperimentDetailDto | null>(null);
  const [analysis, setAnalysis] = useState<MathAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Playback state for step-by-step Newton/Secant animation
  const [stepIdx, setStepIdx] = useState<number>(0);
  const [playing, setPlaying] = useState<boolean>(false);
  const [showNewton, setShowNewton] = useState<boolean>(true);
  const [showSecant, setShowSecant] = useState<boolean>(true);

  const activeId = selectedExperimentId ?? experiments[0]?.id ?? null;

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    umbralApi
      .getExperimentDetail(activeId)
      .then(async (det) => {
        if (cancelled) return;
        setDetail(det);
        const newtonRun = det.solverRuns.find((r) => r.method === 'NEWTON');
        const secantRun = det.solverRuns.find((r) => r.method === 'SECANT');
        const maxSteps = Math.max(
          newtonRun?.iterations.length ?? 1,
          secantRun?.iterations.length ?? 1,
        );
        setStepIdx(Math.max(0, maxSteps - 1));
        setPlaying(false);

        const qParams = det.experiment.params.params ?? { mu: 100 };
        const obj = det.experiment.params.objective ?? {
          type: det.experiment.objective,
          targetLatencyS: 0.05,
        };
        const mathRes = await umbralApi.analyzeMath({
          model: det.experiment.model,
          params: {
            ...qParams,
            empiricalPoints: det.measurements.map((m) => ({ lambda: m.lambdaObs, latency: m.wMean })),
          },
          objective: obj,
          newtonSeed: newtonRun?.seeds?.[0],
          secantSeeds: secantRun?.seeds?.length === 2 ? secantRun.seeds : undefined,
        });
        if (!cancelled) setAnalysis(mathRes);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const newtonRun = useMemo(
    () => detail?.solverRuns.find((r) => r.method === 'NEWTON'),
    [detail],
  );
  const secantRun = useMemo(
    () => detail?.solverRuns.find((r) => r.method === 'SECANT'),
    [detail],
  );
  const bisectionRun = useMemo(
    () => detail?.solverRuns.find((r) => r.method === 'BISECTION'),
    [detail],
  );

  const maxStepCount = Math.max(
    newtonRun?.iterations.length ?? 0,
    secantRun?.iterations.length ?? 0,
    1,
  );

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setStepIdx((prev) => {
        if (prev + 1 >= maxStepCount) {
          setPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [playing, maxStepCount]);

  if (!activeId && !loading) {
    return (
      <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-10 text-center space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Aún no hay experimentos ejecutados
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 max-w-md mx-auto">
          Ejecute una simulación en el laboratorio, analice un archivo de logs o sondee un objetivo autorizado para visualizar la curva W(λ) y predecir λ*.
        </p>
        <button
          type="button"
          onClick={onNavigateWizard}
          className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap"
        >
          Crear primer experimento
        </button>
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-24 rounded-lg bg-slate-200/70 dark:bg-slate-800/70 animate-pulse" />
        <div className="h-80 rounded-lg bg-slate-200/70 dark:bg-slate-800/70 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 rounded-lg p-6 text-sm text-red-800 dark:text-red-200">
        Error cargando dashboard: {error}
      </div>
    );
  }

  if (!detail) return null;

  const mu = detail.experiment.params.params?.mu ?? 100;
  const cVal = detail.experiment.params.params?.c ?? 1;
  const muTotal = detail.experiment.model === 'MMC' ? mu * cVal : mu;
  const targetLatencyS = detail.experiment.params.objective?.targetLatencyS ?? 0.05;
  const measurements = liveWindows.length > 0 ? liveWindows : detail.measurements;
  const lastMeas = measurements[measurements.length - 1];
  const currentLambda = lastMeas?.lambdaObs ?? 0;
  const rho = muTotal > 0 ? currentLambda / muTotal : 0;
  const lambdaStar = detail.prediction?.lambdaStar ?? null;
  const riskPct = lambdaStar && lambdaStar > 0 ? (currentLambda / lambdaStar) * 100 : 0;
  const simSummary = detail.experiment.params.simSummary;
  const fitting = detail.experiment.params.fitting;
  const probeMeta = detail.experiment.params.probeMeta;
  const probeCalibration = detail.experiment.params.probeCalibration;
  const targetMs = targetLatencyS * 1000;
  const headroom = lambdaStar !== null ? lambdaStar - currentLambda : null;
  const riskStatus =
    lambdaStar === null || riskPct >= 95
      ? 'CRITICAL'
      : riskPct >= 75
        ? 'WARNING'
        : 'NOMINAL';

  // Disponibilidad real/simulada derivada exclusivamente de datos existentes
  const availabilityPct = (() => {
    if (probeMeta && typeof probeMeta.availability === 'number') {
      return probeMeta.availability * 100;
    }
    if (simSummary && simSummary.totalArrivals > 0) {
      const ok = Math.max(0, simSummary.totalProcessed - simSummary.totalTimeouts);
      return (ok / simSummary.totalArrivals) * 100;
    }
    if (detail.measurements.length > 0) {
      const avgErr =
        detail.measurements.reduce((acc, m) => acc + (m.errorRate ?? 0), 0) / detail.measurements.length;
      return Math.max(0, Math.min(100, (1 - avgErr) * 100));
    }
    return 100;
  })();

  const meanLatencyMs = lastMeas ? lastMeas.wMean * 1000 : null;
  const baseServiceMs = muTotal > 0 ? 1000 / muTotal : null;
  const latencyRatio =
    meanLatencyMs !== null && baseServiceMs !== null && baseServiceMs > 0
      ? meanLatencyMs / baseServiceMs
      : null;

  // Interpretación inteligente estrictamente basada en los datos reales/simulados/predichos del experimento
  const interpretations: string[] = [];
  if (rho >= 0.85) {
    interpretations.push(
      `El servidor está trabajando cerca de su capacidad máxima (utilización ρ = ${(rho * 100).toFixed(1)}%).`,
    );
  } else if (rho >= 0.6) {
    interpretations.push(
      `La utilización actual es moderada-alta (ρ = ${(rho * 100).toFixed(1)}%), con margen de crecimiento acotado.`,
    );
  } else {
    interpretations.push(
      `La infraestructura opera con holgura de capacidad (utilización ρ = ${(rho * 100).toFixed(1)}%).`,
    );
  }

  if (latencyRatio !== null && meanLatencyMs !== null && baseServiceMs !== null) {
    if (latencyRatio >= 2.5) {
      interpretations.push(
        `La latencia promedio presenta un incremento considerable (${meanLatencyMs.toFixed(1)} ms frente a ${baseServiceMs.toFixed(1)} ms en reposo).`,
      );
    } else {
      interpretations.push(
        `La latencia promedio (${meanLatencyMs.toFixed(1)} ms) se mantiene cercana al tiempo base de servicio (${baseServiceMs.toFixed(1)} ms).`,
      );
    }
  }

  if (lambdaStar !== null && headroom !== null) {
    if (headroom < 0) {
      interpretations.push(
        `El umbral estimado de timeout (${lambdaStar.toFixed(1)} req/s para T = ${targetMs.toFixed(0)} ms) ya fue superado por ${Math.abs(headroom).toFixed(1)} req/s.`,
      );
    } else if (riskPct >= 75) {
      interpretations.push(
        `El umbral estimado de timeout (${lambdaStar.toFixed(1)} req/s) se encuentra próximo: restan ${headroom.toFixed(1)} req/s de margen.`,
      );
    } else {
      interpretations.push(
        `El umbral crítico predicho es ${lambdaStar.toFixed(1)} req/s (${headroom.toFixed(1)} req/s por encima de la carga observada).`,
      );
    }
  } else {
    interpretations.push(
      `No existe una tasa positiva válida para T = ${targetMs.toFixed(0)} ms porque el servicio en vacío ya iguala o supera ese límite.`,
    );
  }

  if (newtonRun && secantRun) {
    if (newtonRun.converged && secantRun.converged) {
      if (newtonRun.iterations.length < secantRun.iterations.length && !newtonRun.usedFiniteDifference) {
        interpretations.push(
          `Newton-Raphson obtuvo convergencia en menos iteraciones (${newtonRun.iterations.length} vs. ${secantRun.iterations.length} de Secante) aprovechando derivada analítica.`,
        );
      } else if (newtonRun.usedFiniteDifference) {
        interpretations.push(
          `Al no existir derivada analítica cerrada, Secante resolvió con menos evaluaciones de función (${secantRun.fEvals} vs. ${newtonRun.fEvals} en Newton).`,
        );
      } else {
        interpretations.push(
          `Newton-Raphson (${newtonRun.iterations.length} iter.) y Secante (${secantRun.iterations.length} iter.) coincidieron en la misma raíz λ*.`,
        );
      }
    } else if (!newtonRun.converged && secantRun.converged) {
      interpretations.push(
        `Newton-Raphson falló (${ES.failureReasons[newtonRun.failureReason] ?? newtonRun.failureReason}), mientras la Secante convergió en ${secantRun.iterations.length} iteraciones.`,
      );
    }
  }

  if (probeCalibration) {
    interpretations.push(
      `Calibración HTTP real del sitio: S₀ = ${probeCalibration.s0Ms.toFixed(1)} ms (${probeMeta?.totalRequests ?? 0} peticiones) → capacidad estimada μ = ${probeCalibration.muCalibrated.toFixed(2)} req/s con ${probeCalibration.workersUsed} worker(s).${
        probeCalibration.httpSignals?.cacheDetected
          ? ` Se detectó respuesta desde caché/CDN (${probeCalibration.httpSignals.cacheStatus}); las peticiones sin caché al origen tendrán menor umbral.`
          : ''
      }${
        probeCalibration.httpSignals?.rateLimitDetected
          ? ` El sitio expone límite de tasa (${probeCalibration.httpSignals.rateLimitHeader}).`
          : ''
      }`,
    );
  }

  return (
    <div className="space-y-6">
      {/* Selector rápido de experimento */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Telemetría de Saturación y Predicción de λ*
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {detail.experiment.targetName} · {ES.models[detail.experiment.model as keyof typeof ES.models] ?? detail.experiment.model} · Fuente: {detail.experiment.sourceKind}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto min-w-0">
          <label htmlFor="dash-exp-select" className="text-xs font-medium text-slate-600 dark:text-slate-400">
            Experimento activo:
          </label>
          <select
            id="dash-exp-select"
            value={detail.experiment.id}
            onChange={(e) => onSelectExperiment(e.target.value)}
            className="w-full sm:w-auto max-w-full min-w-0 px-3 py-1.5 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          >
            {experiments.map((exp) => (
              <option key={exp.id} value={exp.id}>
                {exp.targetName} ({exp.model} · {exp.sourceKind})
              </option>
            ))}
          </select>
          {onNavigateWeb && (
            <button
              type="button"
              onClick={onNavigateWeb}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-blue-600/50 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/70 transition-colors whitespace-nowrap"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>Evaluar página web</span>
            </button>
          )}
          {onNavigateReports && (
            <button
              type="button"
              onClick={onNavigateReports}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              <FileBarChart2 className="w-3.5 h-3.5" />
              <span>Ver / Descargar Informe</span>
            </button>
          )}
        </div>
      </div>

      {/* Guía de recorrido de 7 pasos */}
      <nav
        aria-label="Flujo de análisis guiado"
        className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
      >
        <div className="flex flex-wrap items-center gap-2 text-slate-500 dark:text-slate-400">
          <button
            type="button"
            onClick={onNavigateWizard}
            className="hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap"
          >
            1–4. Configurar y ejecutar
          </button>
          <span aria-hidden="true">→</span>
          <span className="font-semibold text-blue-600 dark:text-blue-400 whitespace-nowrap">
            5. Resultados actuales
          </span>
          <span aria-hidden="true">→</span>
          {onNavigateComparison ? (
            <button
              type="button"
              onClick={onNavigateComparison}
              className="hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap"
            >
              6. Comparar Newton vs. Secante
            </button>
          ) : (
            <span>6. Comparar Newton vs. Secante</span>
          )}
          <span aria-hidden="true">→</span>
          {onNavigateReports ? (
            <button
              type="button"
              onClick={onNavigateReports}
              className="hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap"
            >
              7. Recomendaciones e informe
            </button>
          ) : (
            <span>7. Recomendaciones e informe</span>
          )}
        </div>
        {onNavigateComparison && (
          <button
            type="button"
            onClick={onNavigateComparison}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
          >
            <GitCompare className="w-3.5 h-3.5" />
            <span>Ir a comparador numérico</span>
          </button>
        )}
      </nav>

      {/* Interpretación Inteligente (basada estrictamente en datos reales/simulados) */}
      <section
        aria-label="Diagnóstico rápido"
        className={`rounded-lg border p-4 space-y-3 ${
          riskStatus === 'CRITICAL'
            ? 'border-red-300 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30'
            : riskStatus === 'WARNING'
              ? 'border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30'
              : 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/25'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            {riskStatus === 'NOMINAL' ? (
              <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" aria-hidden="true" />
            ) : (
              <AlertTriangle
                className={`w-5 h-5 shrink-0 mt-0.5 ${
                  riskStatus === 'CRITICAL' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                }`}
                aria-hidden="true"
              />
            )}
            <div className="space-y-1">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Interpretación Inteligente —{' '}
                {lambdaStar === null
                  ? `Sin umbral válido para T = ${targetMs.toFixed(0)} ms`
                  : headroom !== null && headroom < 0
                    ? `Estado CRÍTICO: límite de ${targetMs.toFixed(0)} ms excedido`
                    : riskStatus === 'WARNING'
                      ? `Estado PRECAUCIÓN: próximo al umbral de ${targetMs.toFixed(0)} ms`
                      : `Estado NOMINAL: margen disponible antes de ${targetMs.toFixed(0)} ms`}
              </div>
              <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300 leading-relaxed tabular-nums">
                {interpretations.map((line, i) => (
                  <li key={i}>• {line}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="flex items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
            <span>Origen:</span>
            <ProvenanceTag kind={lastMeas?.provenance ?? 'SIMULATED'} />
          </div>
        </div>
      </section>

      {/* Banner EXTRAPOLACIÓN obligatorio cuando lambda* supera carga observada */}
      {detail.prediction?.extrapolated && (
        <div
          role="status"
          className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2.5 text-sm text-amber-900 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>
              <strong className="font-semibold">EXTRAPOLACIÓN:</strong>{' '}
              {(detail.prediction.extrapolationWarning ||
                'El umbral λ* predicho supera la tasa máxima observada en las mediciones.'
              ).replace(/^EXTRAPOLACIÓN:\s*/i, '')}
            </span>
          </div>
          <span className="font-mono text-xs font-semibold text-amber-800 dark:text-amber-300 whitespace-nowrap">
            Confianza: {detail.prediction.confidenceLevel}
          </span>
        </div>
      )}

      {/* Nota de calibración y señales HTTP del sondeo real si aplica */}
      {(probeMeta || probeCalibration) && (
        <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg px-4 py-3 text-xs text-slate-700 dark:text-slate-300 space-y-1.5">
          {probeCalibration && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono tabular-nums text-slate-800 dark:text-slate-200">
              <span>
                S₀ medido: <strong>{probeCalibration.s0Ms.toFixed(1)} ms</strong> (IC [{probeCalibration.s0CiLowMs.toFixed(1)} ; {probeCalibration.s0CiHighMs.toFixed(1)}] ms)
              </span>
              <span>
                μ calibrado: <strong>{probeCalibration.muCalibrated.toFixed(2)} req/s</strong> ({probeCalibration.method})
              </span>
              {probeCalibration.httpSignals?.serverHeader && (
                <span>Servidor: {probeCalibration.httpSignals.serverHeader}</span>
              )}
              {probeCalibration.httpSignals?.cacheStatus && (
                <span>Caché/CDN: {probeCalibration.httpSignals.cacheStatus}</span>
              )}
              {probeCalibration.autoAdjustedT && (
                <span className="text-blue-600 dark:text-blue-400">
                  Umbral T autoajustado a {(probeCalibration.effectiveTargetLatencyS * 1000).toFixed(0)} ms (2.5× S₀)
                </span>
              )}
            </div>
          )}
          {probeMeta && <p className="text-slate-500 dark:text-slate-400">{probeMeta.limitationNote}</p>}
        </div>
      )}

      {/* KPI strip (4 columnas equilibradas cubriendo umbral, utilización/disponibilidad, latencia promedio/p95, estado/riesgo) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              <span>Umbral de saturación (λ*)</span>
              <HelpTip
                label="umbral de saturación"
                text="Cantidad máxima de peticiones por segundo que el servicio soporta antes de que la latencia supere el límite T."
              />
            </span>
            <ProvenanceTag kind="PREDICTED" />
          </div>
          <div className="text-2xl font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {lambdaStar !== null ? lambdaStar.toFixed(2) : '—'}{' '}
            <span className="text-xs font-normal text-slate-500">req/s</span>
          </div>
          <div className="text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums">
            IC 95%: [{detail.prediction?.ciLow?.toFixed(2) ?? '—'} ; {detail.prediction?.ciHigh?.toFixed(2) ?? '—'}]
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Límite máximo antes de superar T = {targetMs.toFixed(0)} ms
          </p>
        </div>

        <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              <span>Utilización y Disponibilidad</span>
              <HelpTip
                label="utilización y disponibilidad"
                text="ρ = λ/μ indica qué porcentaje de la capacidad del servidor está ocupado. La disponibilidad refleja peticiones completadas sin timeout ni error."
              />
            </span>
            <ProvenanceTag kind={lastMeas?.provenance ?? 'SIMULATED'} />
          </div>
          <div className="flex items-baseline gap-3 font-mono tabular-nums">
            <span className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {(rho * 100).toFixed(1)}
              <span className="text-xs font-normal text-slate-500 ml-0.5">%</span>
            </span>
            <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              Disp. {availabilityPct.toFixed(1)}%
            </span>
          </div>
          <div className="text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums">
            λ_act = {currentLambda.toFixed(2)} · μ_tot = {muTotal.toFixed(1)} req/s
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Capacidad ocupada vs. respuestas exitosas
          </p>
        </div>

        <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              <span>Latencia promedio y p95</span>
              <HelpTip
                label="latencia promedio y percentiles"
                text="W promedio indica el tiempo medio de respuesta; p95 y p99 muestran la latencia que experimenta el 5% y 1% de peticiones más lentas."
              />
            </span>
            <ProvenanceTag kind={lastMeas?.provenance ?? 'SIMULATED'} />
          </div>
          <div className="flex items-baseline gap-2.5 font-mono tabular-nums">
            <span className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {meanLatencyMs !== null ? meanLatencyMs.toFixed(1) : '—'}
              <span className="text-xs font-normal text-slate-500 ml-1">ms</span>
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              p95: {lastMeas ? `${(lastMeas.wP95 * 1000).toFixed(1)} ms` : '—'}
            </span>
          </div>
          <div className="text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums">
            {lastMeas
              ? `p50 ${(lastMeas.wP50 * 1000).toFixed(1)} · p99 ${(lastMeas.wP99 * 1000).toFixed(1)} ms`
              : `${measurements.length} ventanas`}
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {fitting
              ? `Ajuste R² = ${fitting.rSquared.toFixed(3)} · ${measurements.length} ventanas`
              : `${measurements.length} ventanas analizadas`}
          </p>
        </div>

        <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              <span>Estado general (λ/λ*)</span>
              <HelpTip
                label="estado y nivel de riesgo"
                text="Mide qué tan cerca está la carga actual λ del punto de colapso λ*. Al llegar a 100% se supera el tiempo máximo T."
              />
            </span>
            <span
              className={`text-xs font-mono font-semibold ${
                riskPct >= 95
                  ? 'text-red-600 dark:text-red-400'
                  : riskPct >= 75
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {riskPct >= 95 ? '▲ CRÍTICO' : riskPct >= 75 ? '▲ ELEVADO' : '● NOMINAL'}
            </span>
          </div>
          <div className="text-2xl font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {riskPct.toFixed(1)}
            <span className="text-xs font-normal text-slate-500 ml-1">%</span>
          </div>
          <div className="w-full h-2 bg-slate-200 dark:bg-slate-800 rounded-sm overflow-hidden">
            <div
              className={`h-full transition-all ${
                riskPct >= 95 ? 'bg-red-600' : riskPct >= 75 ? 'bg-amber-500' : 'bg-emerald-600'
              }`}
              style={{ width: `${Math.min(100, riskPct)}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Cercanía al punto de saturación (100% = colapso)
          </p>
        </div>
      </div>

      {/* Main Chart + Animated Solver Controls */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <section className="xl:col-span-2 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Curva de Latencia W(λ) y Animación Paso a Paso de Solvers
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Mueve el cursor sobre la curva para inspeccionar (λ, W). Línea azul: tangente de Newton · Línea violeta: secante.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowNewton((v) => !v)}
                className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                  showNewton
                    ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                    : 'border-slate-300 dark:border-slate-700 text-slate-500'
                }`}
              >
                Newton
              </button>
              <button
                type="button"
                onClick={() => setShowSecant((v) => !v)}
                className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                  showSecant
                    ? 'border-purple-600 bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300'
                    : 'border-slate-300 dark:border-slate-700 text-slate-500'
                }`}
              >
                Secante
              </button>
            </div>
          </div>

          <LatencyCurveChart
            curvePoints={analysis?.curvePoints ?? []}
            observations={measurements.map((m) => ({
              lambda: m.lambdaObs,
              latency: m.wMean,
              provenance: m.provenance,
            }))}
            mu={muTotal}
            targetLatencyS={targetLatencyS}
            lambdaStar={lambdaStar}
            ciLow={detail.prediction?.ciLow ?? null}
            ciHigh={detail.prediction?.ciHigh ?? null}
            newtonIterations={newtonRun?.iterations ?? []}
            secantIterations={secantRun?.iterations ?? []}
            activeStepIndex={stepIdx}
            showNewton={showNewton}
            showSecant={showSecant}
          />

          {/* Guía visual rápida de la gráfica */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-slate-600 dark:text-slate-400 pt-1">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-blue-600 inline-block" />
              <span>Línea vertical azul: tasa crítica λ*</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2.5 bg-amber-500/25 border border-amber-500/50 inline-block rounded-xs" />
              <span>Franja ámbar: intervalo de confianza (IC 95%)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-0.5 border-t border-dashed border-red-600 inline-block" />
              <span>Línea roja horizontal: límite T ({targetMs.toFixed(0)} ms)</span>
            </span>
          </div>

          {/* Controles de reproducción de iteraciones */}
          <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (stepIdx >= maxStepCount - 1) setStepIdx(0);
                  setPlaying((p) => !p);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap"
              >
                {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                <span>{playing ? 'Pausar' : 'Reproducir iteraciones'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setStepIdx((prev) => Math.min(maxStepCount - 1, prev + 1));
                }}
                aria-label="Siguiente iteración"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                <StepForward className="w-3.5 h-3.5" />
                <span>Paso</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setStepIdx(0);
                }}
                aria-label="Reiniciar animación"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Inicio</span>
              </button>
            </div>

            <div className="text-xs font-mono text-slate-600 dark:text-slate-300 tabular-nums">
              Iteración n = {stepIdx} / {Math.max(0, maxStepCount - 1)}
              {newtonRun?.iterations[Math.min(stepIdx, newtonRun.iterations.length - 1)] && (
                <>
                  {' '}
                  · λ_Newton ={' '}
                  {newtonRun.iterations[Math.min(stepIdx, newtonRun.iterations.length - 1)].x.toFixed(5)}
                </>
              )}
              {secantRun?.iterations[Math.min(stepIdx, secantRun.iterations.length - 1)] && (
                <>
                  {' '}
                  · λ_Secante ={' '}
                  {secantRun.iterations[Math.min(stepIdx, secantRun.iterations.length - 1)].x.toFixed(5)}
                </>
              )}
            </div>
          </div>
        </section>

        {/* Right column: Error log plot + Alerts */}
        <div className="space-y-6">
          <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Error vs. Iteración (Escala Log₁₀)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Newton-Raphson (azul, orden ≈ 2) vs. Secante (violeta, orden ≈ 1.618) vs. Bisección (punteada).
            </p>
            <ErrorConvergenceChart
              newtonIterations={newtonRun?.iterations ?? []}
              secantIterations={secantRun?.iterations ?? []}
              bisectionIterations={bisectionRun?.iterations ?? []}
              activeStepIndex={stepIdx}
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              Eje vertical en escala logarítmica de error residual |f(λ)|; cuanto más pronunciada la caída en menos iteraciones, mayor velocidad de convergencia.
            </p>
          </section>

          <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Alertas Preventivas ({detail.alerts.length})
            </h2>
            {detail.alerts.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Sin umbrales preventivos disparados en la ventana actual.
              </p>
            ) : (
              <ul className="space-y-2">
                {detail.alerts.map((al) => (
                  <li
                    key={al.id}
                    className={`p-3 rounded-md border text-xs ${
                      al.severity === 'CRITICAL'
                        ? 'border-red-300 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-900 dark:text-red-200'
                        : al.severity === 'WARNING'
                          ? 'border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200'
                          : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    <div className="font-mono font-semibold">{al.severity} · {al.rule}</div>
                    <div className="mt-1">{al.message}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Últimas Simulaciones y Análisis
              </h2>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                {experiments.length} total
              </span>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {experiments.slice(0, 4).map((exp) => (
                <li key={exp.id} className="py-2 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectExperiment(exp.id)}
                    className={`text-left min-w-0 flex-1 hover:text-blue-500 transition-colors ${
                      exp.id === detail.experiment.id
                        ? 'font-semibold text-blue-600 dark:text-blue-400'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div className="truncate">{exp.targetName}</div>
                    <div className="text-[11px] font-mono text-slate-500">
                      {exp.model} · {exp.sourceKind} · {exp.status}
                    </div>
                  </button>
                  <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {exp.lambdaStar !== null ? `${exp.lambdaStar.toFixed(1)} req/s` : '—'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {/* Real-time comparison table */}
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Tabla Comparativa de Solvers (Comparación Justa)
          </h2>
          {fitting && (
            <span className="text-xs text-slate-600 dark:text-slate-300">
              Adecuación M/M/1: <strong>{fitting.adequacyMM1.adequate ? 'Adecuado' : `Sugiere ${fitting.adequacyMM1.suggestedModel}`}</strong> — {fitting.adequacyMM1.reason}
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-2.5 pr-4 font-medium">Método</th>
                <th className="py-2.5 px-3 font-medium">Estado / Criterio</th>
                <th className="py-2.5 px-3 font-medium text-right">λ* (req/s)</th>
                <th className="py-2.5 px-3 font-medium text-right">Iteraciones</th>
                <th className="py-2.5 px-3 font-medium text-right">Eval. f / f&apos;</th>
                <th className="py-2.5 px-3 font-medium text-right">Orden est. p</th>
                <th className="py-2.5 px-3 font-medium text-right">Eficiencia p^(1/c)</th>
                <th className="py-2.5 pl-3 font-medium text-right">Tiempo mediano</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 font-mono tabular-nums">
              {detail.solverRuns.map((run) => (
                <tr key={run.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="py-2.5 pr-4 font-sans font-semibold text-slate-900 dark:text-slate-100">
                    {SOLVER_LABELS[run.method] ?? run.method}
                    {run.usedFiniteDifference && (
                      <span className="ml-1.5 text-[10px] font-mono font-normal text-amber-600 dark:text-amber-400">
                        (Dif. finitas)
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-sans">
                    {run.converged ? (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        ● Convergido ({CRITERION_LABELS[run.stoppingCriterion] ?? run.stoppingCriterion})
                      </span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400">
                        ✕ {ES.failureReasons[run.failureReason] ?? run.failureReason}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {run.root !== null ? run.root.toFixed(6) : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right">{run.iterations.length}</td>
                  <td className="py-2.5 px-3 text-right">
                    {run.fEvals} / {run.dfEvals}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {run.estimatedOrder !== null ? run.estimatedOrder.toFixed(3) : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {run.efficiencyIndex !== null ? run.efficiencyIndex.toFixed(3) : '—'}
                  </td>
                  <td className="py-2.5 pl-3 text-right">
                    {(run.elapsedNs / 1000).toFixed(2)} µs
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
