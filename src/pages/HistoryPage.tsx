import React, { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { umbralApi, type ExperimentSummary } from '../api/client';

interface HistoryPageProps {
  experiments: ExperimentSummary[];
  onSelectForDashboard: (id: string) => void;
  onSelectForReport: (id: string) => void;
  onRefresh: () => Promise<void>;
}

export function HistoryPage({
  experiments,
  onSelectForDashboard,
  onSelectForReport,
  onRefresh,
}: HistoryPageProps) {
  const [modelFilter, setModelFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [rerunningId, setRerunningId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return experiments.filter((e) => {
      if (modelFilter && e.model !== modelFilter) return false;
      if (sourceFilter && e.sourceKind !== sourceFilter) return false;
      return true;
    });
  }, [experiments, modelFilter, sourceFilter]);

  const compared = useMemo(
    () => experiments.filter((e) => compareIds.includes(e.id)),
    [experiments, compareIds],
  );

  const toggleCompare = (id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };

  const handleRerun = async (id: string) => {
    setRerunningId(id);
    setError(null);
    try {
      const res = await umbralApi.rerunExperiment(id);
      await onRefresh();
      onSelectForDashboard(res.detail.experiment.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRerunningId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Historial y Comparación de Experimentos
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Filtre por modelo o fuente, compare dos corridas lado a lado o reejecute con los mismos parámetros.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Filtrar por modelo"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            className="px-3 py-1.5 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            <option value="">Todos los modelos</option>
            <option value="MM1">M/M/1</option>
            <option value="MMC">M/M/c</option>
            <option value="MG1">M/G/1</option>
            <option value="MM1K">M/M/1/K</option>
            <option value="EMPIRICAL">EMPIRICAL</option>
          </select>

          <select
            aria-label="Filtrar por fuente"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="px-3 py-1.5 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            <option value="">Todas las fuentes</option>
            <option value="LAB">LAB (Simulador)</option>
            <option value="LOG">LOG (Forense)</option>
            <option value="PROBE">PROBE (Sondeo)</option>
            <option value="DECLARED">DECLARED</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Side-by-side comparison */}
      {compared.length === 2 && (
        <section className="border border-blue-300 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-950/20 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Comparación lado a lado (2 experimentos seleccionados)
            </h2>
            <button
              type="button"
              onClick={() => setCompareIds([])}
              className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
            >
              Limpiar selección
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {compared.map((c) => (
              <div
                key={c.id}
                className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded p-3 text-xs space-y-1 font-mono tabular-nums"
              >
                <div className="font-sans font-semibold text-sm text-slate-900 dark:text-slate-100">
                  {c.targetName}
                </div>
                <div>Modelo: {c.model} · Fuente: {c.sourceKind}</div>
                <div>λ* predicho: {c.lambdaStar?.toFixed(3) ?? '—'} req/s</div>
                <div>IC 95%: [{c.ciLow?.toFixed(2) ?? '—'}, {c.ciHigh?.toFixed(2) ?? '—'}]</div>
                <div>Confianza: {c.confidenceLevel} {c.extrapolated ? '(EXTRAPOLACIÓN)' : ''}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-3 font-medium">Comparar</th>
                <th className="py-2.5 px-3 font-medium">Objetivo</th>
                <th className="py-2.5 px-3 font-medium">Modelo</th>
                <th className="py-2.5 px-3 font-medium">Fuente</th>
                <th className="py-2.5 px-3 font-medium text-right">λ* (req/s)</th>
                <th className="py-2.5 px-3 font-medium">Confianza</th>
                <th className="py-2.5 px-3 font-medium">Fecha</th>
                <th className="py-2.5 px-3 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((exp) => (
                <tr key={exp.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="py-2.5 px-3">
                    <input
                      type="checkbox"
                      aria-label={`Comparar experimento ${exp.id}`}
                      checked={compareIds.includes(exp.id)}
                      onChange={() => toggleCompare(exp.id)}
                    />
                  </td>
                  <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100">
                    {exp.targetName}
                  </td>
                  <td className="py-2.5 px-3 font-mono">{exp.model}</td>
                  <td className="py-2.5 px-3 font-mono">{exp.sourceKind}</td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {exp.lambdaStar !== null ? exp.lambdaStar.toFixed(2) : '—'}
                  </td>
                  <td className="py-2.5 px-3 font-mono">
                    {exp.confidenceLevel ?? '—'}
                    {exp.extrapolated && (
                      <span className="ml-1.5 text-amber-600 dark:text-amber-400">EXTRAP.</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-slate-500">
                    {new Date(exp.createdAt).toLocaleString('es-ES')}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectForDashboard(exp.id)}
                        className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                      >
                        Abrir
                      </button>
                      <button
                        type="button"
                        onClick={() => onSelectForReport(exp.id)}
                        className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                      >
                        Informe
                      </button>
                      <button
                        type="button"
                        disabled={rerunningId === exp.id}
                        onClick={() => handleRerun(exp.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>{rerunningId === exp.id ? '...' : 'Reejecutar'}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    No hay experimentos que coincidan con el filtro actual.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
