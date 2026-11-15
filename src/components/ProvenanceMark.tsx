import React from 'react';
import { ES } from '../i18n/es';

export type ProvenanceKind = 'MEASURED' | 'SIMULATED' | 'PREDICTED';

export function ProvenanceTag({ kind }: { kind: ProvenanceKind | string }) {
  const normalized: ProvenanceKind =
    kind === 'MEASURED' || kind === 'SIMULATED' || kind === 'PREDICTED' ? kind : 'PREDICTED';

  const colorClasses: Record<ProvenanceKind, string> = {
    MEASURED:
      'text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 bg-emerald-50/70 dark:bg-emerald-950/40',
    SIMULATED:
      'text-cyan-700 dark:text-cyan-300 border-cyan-300 dark:border-cyan-700 bg-cyan-50/70 dark:bg-cyan-950/40',
    PREDICTED:
      'text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700 bg-amber-50/70 dark:bg-amber-950/40',
  };

  const dashArray: Record<ProvenanceKind, string | undefined> = {
    MEASURED: undefined,
    SIMULATED: '2,3',
    PREDICTED: '6,3',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono font-semibold border rounded-sm whitespace-nowrap shrink-0 ${colorClasses[normalized]}`}
    >
      <svg width="16" height="6" viewBox="0 0 16 6" aria-hidden="true">
        <line
          x1="0"
          y1="3"
          x2="16"
          y2="3"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={dashArray[normalized]}
        />
      </svg>
      <span>{ES.provenance[normalized]}</span>
    </span>
  );
}

export function PermanentProvenanceLegend() {
  return (
    <div
      className="flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-300"
      aria-label="Leyenda de procedencia de datos"
    >
      <span className="font-medium text-slate-500 dark:text-slate-400">Procedencia:</span>
      <ProvenanceTag kind="MEASURED" />
      <ProvenanceTag kind="SIMULATED" />
      <ProvenanceTag kind="PREDICTED" />
    </div>
  );
}
