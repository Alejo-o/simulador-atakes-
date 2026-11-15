import React from 'react';
import type { MathAnalysisResponse } from '../api/client';

export function BasinHeatmap({
  basin,
  mu,
}: {
  basin: MathAnalysisResponse['basin'];
  mu: number;
}) {
  const cells = basin.cells;
  if (cells.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
        <span>
          Barrido de semilla inicial <span className="font-mono font-semibold">λ₀ ∈ (0, μ={mu.toFixed(1)})</span>
        </span>
        {basin.theoreticalNewtonLowerBound !== null && (
          <span className="font-mono text-blue-700 dark:text-blue-300">
            Intervalo teórico Newton: ({basin.theoreticalNewtonLowerBound.toFixed(2)}, {basin.theoreticalNewtonUpperBound.toFixed(2)})
          </span>
        )}
      </div>

      {/* Newton row */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-200">
          <span>Newton-Raphson (cuenca de convergencia vs. DOMAIN_ESCAPE)</span>
          <span className="font-mono text-[11px] text-slate-500">
            {cells.filter((c) => c.newtonConverged).length}/{cells.length} semillas convergen
          </span>
        </div>
        <div className="grid grid-cols-12 sm:grid-cols-24 gap-1" role="list" aria-label="Cuenca de convergencia de Newton">
          {cells.map((c, idx) => (
            <div
              key={`nr-${idx}`}
              role="listitem"
              title={`λ₀=${c.seedValue} (${(c.seedRatio * 100).toFixed(0)}% μ) -> ${
                c.newtonConverged ? `Converge en ${c.newtonIterations} iter` : `Fallo: ${c.newtonReason}`
              }`}
              className={`h-8 rounded-xs border flex items-center justify-center text-[10px] font-mono tabular-nums ${
                c.newtonConverged
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-800 dark:text-emerald-200'
                  : 'bg-red-500/20 border-red-500/50 text-red-800 dark:text-red-200'
              }`}
            >
              {c.newtonConverged ? c.newtonIterations : '✕'}
            </div>
          ))}
        </div>
      </div>

      {/* Secant row */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-200">
          <span>Método de la Secante (semilla λ₀ y λ₁ = λ₀ + 0.04·μ)</span>
          <span className="font-mono text-[11px] text-slate-500">
            {cells.filter((c) => c.secantConverged).length}/{cells.length} pares convergen
          </span>
        </div>
        <div className="grid grid-cols-12 sm:grid-cols-24 gap-1" role="list" aria-label="Cuenca de convergencia de Secante">
          {cells.map((c, idx) => (
            <div
              key={`sec-${idx}`}
              role="listitem"
              title={`λ₀=${c.seedValue} -> ${
                c.secantConverged ? `Converge en ${c.secantIterations} iter` : `Fallo: ${c.secantReason}`
              }`}
              className={`h-8 rounded-xs border flex items-center justify-center text-[10px] font-mono tabular-nums ${
                c.secantConverged
                  ? 'bg-purple-500/20 border-purple-500/50 text-purple-800 dark:text-purple-200'
                  : 'bg-red-500/20 border-red-500/50 text-red-800 dark:text-red-200'
              }`}
            >
              {c.secantConverged ? c.secantIterations : '✕'}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500 dark:text-slate-400">
        <span>Número en celda = iteraciones hasta convergencia</span>
        <span aria-hidden="true">·</span>
        <span>✕ = Escape de dominio / No convergencia</span>
      </div>
    </div>
  );
}
