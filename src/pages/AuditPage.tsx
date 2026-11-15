import React, { useEffect, useState } from 'react';
import { Lock, ShieldCheck, ShieldAlert } from 'lucide-react';
import { umbralApi, type AuditResponse } from '../api/client';

export function AuditPage() {
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    umbralApi
      .getAudit()
      .then((res) => {
        setAudit(res);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Registro de Auditoría Inmutable (Solo Lectura)
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Cada acción de autorización, sondeo, experimento y reporte se encadena mediante hash criptográfico SHA-256.
          </p>
        </div>

        <button
          type="button"
          onClick={load}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
        >
          Verificar cadena SHA-256
        </button>
      </div>

      {error && (
        <div className="border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 rounded-lg p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {audit && (
        <div
          className={`border rounded-lg px-4 py-3 flex items-center gap-3 text-sm ${
            audit.verification.valid
              ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200'
              : 'border-red-300 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-900 dark:text-red-200'
          }`}
        >
          {audit.verification.valid ? (
            <ShieldCheck className="w-5 h-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ShieldAlert className="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
          )}
          <div>
            <strong>
              {audit.verification.valid
                ? `Cadena íntegra verificada (${audit.verification.checkedCount} registros enlazados)`
                : 'ALERTA: Ruptura detectada en la cadena de hashes'}
            </strong>
            {audit.verification.reason && <div className="text-xs mt-0.5">{audit.verification.reason}</div>}
          </div>
          <Lock className="w-4 h-4 ml-auto opacity-60 shrink-0" aria-hidden="true" />
        </div>
      )}

      {loading && !audit ? (
        <div className="h-48 rounded-lg bg-slate-200/70 dark:bg-slate-800/70 animate-pulse" />
      ) : (
        <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-3 font-medium">Marca temporal</th>
                  <th className="py-2.5 px-3 font-medium">Actor</th>
                  <th className="py-2.5 px-3 font-medium">Acción</th>
                  <th className="py-2.5 px-3 font-medium">Detalle</th>
                  <th className="py-2.5 px-3 font-medium">Hash SHA-256 (prev → curr)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                {(audit?.entries ?? []).map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 px-3 whitespace-nowrap text-slate-500">
                      {new Date(entry.ts).toLocaleString('es-ES')}
                    </td>
                    <td className="py-2.5 px-3 font-sans">{entry.actor}</td>
                    <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-slate-100">
                      {entry.action}
                    </td>
                    <td className="py-2.5 px-3 font-sans max-w-md truncate" title={entry.detailJson}>
                      {entry.detailJson}
                    </td>
                    <td className="py-2.5 px-3 text-[11px] text-slate-500 whitespace-nowrap">
                      {entry.prevHash.slice(0, 8)}… → {entry.hash.slice(0, 12)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
