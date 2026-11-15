import React, { useMemo } from 'react';
import type { SolverIterationDto } from '../api/client';

interface ErrorConvergenceChartProps {
  newtonIterations: SolverIterationDto[];
  secantIterations: SolverIterationDto[];
  bisectionIterations?: SolverIterationDto[];
  activeStepIndex?: number;
}

export function ErrorConvergenceChart({
  newtonIterations,
  secantIterations,
  bisectionIterations = [],
  activeStepIndex,
}: ErrorConvergenceChartProps) {
  const width = 560;
  const height = 240;
  const pad = { top: 20, right: 20, bottom: 38, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const extractLogSeries = (iters: SolverIterationDto[], limit?: number) => {
    const slice = limit !== undefined ? iters.slice(0, limit + 1) : iters;
    return slice
      .map((it) => {
        const err = it.errTrue ?? it.errAbs ?? Math.abs(it.fx);
        const clamped = Math.max(1e-14, Math.min(100, err || 1e-14));
        return { n: it.n, logErr: Math.log10(clamped), rawErr: err };
      })
      .filter((p) => Number.isFinite(p.logErr));
  };

  const newtonPts = useMemo(
    () => extractLogSeries(newtonIterations, activeStepIndex),
    [newtonIterations, activeStepIndex],
  );
  const secantPts = useMemo(
    () => extractLogSeries(secantIterations, activeStepIndex),
    [secantIterations, activeStepIndex],
  );
  const bisectionPts = useMemo(
    () => extractLogSeries(bisectionIterations.slice(0, 20)),
    [bisectionIterations],
  );

  const maxIter = Math.max(
    6,
    newtonIterations.length,
    secantIterations.length,
    Math.min(18, bisectionIterations.length),
  );
  const minLog = -14;
  const maxLog = 2;

  const toX = (n: number) => pad.left + (n / Math.max(1, maxIter - 1)) * plotW;
  const toY = (logE: number) =>
    pad.top + ((maxLog - Math.max(minLog, Math.min(maxLog, logE))) / (maxLog - minLog)) * plotH;

  const buildPath = (pts: Array<{ n: number; logErr: number }>) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(p.n).toFixed(1)} ${toY(p.logErr).toFixed(1)}`).join(' ');

  const logTicks = [0, -3, -6, -9, -12];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto select-none"
      role="img"
      aria-label="Gráfica de error en escala logarítmica por iteración para Newton-Raphson y Secante"
    >
      {logTicks.map((lt) => {
        const y = toY(lt);
        return (
          <g key={lt}>
            <line
              x1={pad.left}
              y1={y}
              x2={width - pad.right}
              y2={y}
              className="stroke-slate-200 dark:stroke-slate-800"
              strokeWidth="1"
            />
            <text
              x={pad.left - 8}
              y={y + 3}
              textAnchor="end"
              className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
            >
              1e{lt}
            </text>
          </g>
        );
      })}

      <text
        x={pad.left + plotW / 2}
        y={height - 6}
        textAnchor="middle"
        className="fill-slate-600 dark:fill-slate-300 text-[10px] font-medium"
      >
        Iteración (n)
      </text>

      {bisectionPts.length > 1 && (
        <path
          d={buildPath(bisectionPts)}
          fill="none"
          className="stroke-slate-400 dark:stroke-slate-500"
          strokeWidth="1.5"
          strokeDasharray="3,3"
        />
      )}

      {secantPts.length > 1 && (
        <path d={buildPath(secantPts)} fill="none" stroke="#9333EA" strokeWidth="2.2" />
      )}
      {secantPts.map((p) => (
        <circle key={`s-${p.n}`} cx={toX(p.n)} cy={toY(p.logErr)} r="3" fill="#9333EA" />
      ))}

      {newtonPts.length > 1 && (
        <path d={buildPath(newtonPts)} fill="none" stroke="#2563EB" strokeWidth="2.2" />
      )}
      {newtonPts.map((p) => (
        <circle key={`n-${p.n}`} cx={toX(p.n)} cy={toY(p.logErr)} r="3.2" fill="#2563EB" />
      ))}
    </svg>
  );
}
