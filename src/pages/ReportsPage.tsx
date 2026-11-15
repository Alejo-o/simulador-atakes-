import React, { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { umbralApi, type ExperimentDetailDto, type ExperimentSummary } from '../api/client';
import { ProvenanceTag } from '../components/ProvenanceMark';

interface ReportsPageProps {
  experiments: ExperimentSummary[];
  selectedExperimentId: string | null;
  onSelectExperiment: (id: string) => void;
}

export function ReportsPage({
  experiments,
  selectedExperimentId,
  onSelectExperiment,
}: ReportsPageProps) {
  const activeId = selectedExperimentId ?? experiments[0]?.id ?? null;
  const [detail, setDetail] = useState<ExperimentDetailDto | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setLoading(true);
    umbralApi
      .getExperimentDetail(activeId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Generación y Descarga de Reportes
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Vista previa técnica y exportación oficial en PDF, CSV y JSON con trazabilidad de procedencia.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label htmlFor="rep-exp-select" className="text-xs font-medium text-slate-600 dark:text-slate-400">
            Experimento:
          </label>
          <select
            id="rep-exp-select"
            value={activeId ?? ''}
            onChange={(e) => onSelectExperiment(e.target.value)}
            className="px-3 py-1.5 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            {experiments.map((exp) => (
              <option key={exp.id} value={exp.id}>
                {exp.targetName} · {exp.model} ({exp.sourceKind})
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && <div className="h-48 rounded-lg bg-slate-200/70 dark:bg-slate-800/70 animate-pulse" />}

      {detail && (
        <article className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-6 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                <FileText className="w-4 h-4" />
                <span>INFORME ID: {detail.experiment.id}</span>
              </div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {detail.experiment.targetName} — Modelo {detail.experiment.model}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Objetivo: {detail.experiment.targetUrl} · Fuente: {detail.experiment.sourceKind} · Fecha:{' '}
                {new Date(detail.experiment.createdAt).toLocaleString('es-ES')}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`/api/reports/${detail.experiment.id}/download?format=pdf`}
                download
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Descargar PDF</span>
              </a>
              <a
                href={`/api/reports/${detail.experiment.id}/download?format=csv`}
                download
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>CSV</span>
              </a>
              <a
                href={`/api/reports/${detail.experiment.id}/download?format=json`}
                download
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>JSON</span>
              </a>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div className="p-4 rounded border border-slate-200 dark:border-slate-800 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Tasa crítica λ*</span>
                <ProvenanceTag kind="PREDICTED" />
              </div>
              <div className="text-xl font-mono font-semibold tabular-nums">
                {detail.prediction?.lambdaStar?.toFixed(4) ?? '—'} req/s
              </div>
              <div className="text-xs font-mono text-slate-500">
                IC 95%: [{detail.prediction?.ciLow?.toFixed(3) ?? '—'}, {detail.prediction?.ciHigh?.toFixed(3) ?? '—'}]
              </div>
            </div>

            <div className="p-4 rounded border border-slate-200 dark:border-slate-800 space-y-1">
              <span className="text-xs text-slate-500">Confianza y extrapolación</span>
              <div className="text-xl font-mono font-semibold">
                {detail.prediction?.confidenceLevel ?? '—'}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300">
                {detail.prediction?.extrapolated ? 'EXTRAPOLACIÓN ACTIVA' : 'Dentro del rango observado'}
              </div>
            </div>

            <div className="p-4 rounded border border-slate-200 dark:border-slate-800 space-y-1">
              <span className="text-xs text-slate-500">Ventanas registradas</span>
              <div className="text-xl font-mono font-semibold tabular-nums">
                {detail.measurements.length}
              </div>
              <div className="text-xs text-slate-500">
                Alertas emitidas: {detail.alerts.length}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Resumen de Solvers incluidos en el informe
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 font-sans">
                    <th className="py-2 pr-3">Método</th>
                    <th className="py-2 px-3">Convergió</th>
                    <th className="py-2 px-3 text-right">Raíz λ*</th>
                    <th className="py-2 px-3 text-right">Iteraciones</th>
                    <th className="py-2 px-3 text-right">f / f&apos; evals</th>
                    <th className="py-2 pl-3 text-right">Orden est.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {detail.solverRuns.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 pr-3 font-sans font-semibold">{r.method}</td>
                      <td className="py-2 px-3">{r.converged ? 'SÍ' : r.failureReason}</td>
                      <td className="py-2 px-3 text-right">{r.root?.toFixed(6) ?? '—'}</td>
                      <td className="py-2 px-3 text-right">{r.iterations.length}</td>
                      <td className="py-2 px-3 text-right">
                        {r.fEvals} / {r.dfEvals}
                      </td>
                      <td className="py-2 pl-3 text-right">{r.estimatedOrder?.toFixed(3) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </article>
      )}
    </div>
  );
}
