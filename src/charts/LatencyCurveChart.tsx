import React, { useMemo, useState } from 'react';
import type { SolverIterationDto } from '../api/client';

interface DataPoint {
  lambda: number;
  latency: number;
  provenance: 'MEASURED' | 'SIMULATED' | 'PREDICTED';
}

interface LatencyCurveChartProps {
  curvePoints: Array<{ lambda: number; latency: number }>;
  observations: DataPoint[];
  mu: number;
  targetLatencyS: number;
  lambdaStar: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  newtonIterations?: SolverIterationDto[];
  secantIterations?: SolverIterationDto[];
  activeStepIndex?: number;
  showNewton?: boolean;
  showSecant?: boolean;
}

export function LatencyCurveChart({
  curvePoints,
  observations,
  mu,
  targetLatencyS,
  lambdaStar,
  ciLow,
  ciHigh,
  newtonIterations = [],
  secantIterations = [],
  activeStepIndex,
  showNewton = true,
  showSecant = true,
}: LatencyCurveChartProps) {
  const [hoverX, setHoverX] = useState<number | null>(null);

  const width = 760;
  const height = 340;
  const pad = { top: 24, right: 28, bottom: 44, left: 64 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const { maxX, maxY } = useMemo(() => {
    const allX = [
      ...curvePoints.map((p) => p.lambda),
      ...observations.map((o) => o.lambda),
      mu,
      lambdaStar ?? 0,
      ciHigh ?? 0,
    ];
    const allY = [
      ...curvePoints.map((p) => p.latency),
      ...observations.map((o) => o.latency),
      targetLatencyS * 1.6,
    ].filter((y) => Number.isFinite(y) && y > 0);
    const mx = Math.max(10, ...allX) * 1.03;
    const my = Math.min(Math.max(targetLatencyS * 2.4, ...allY, 0.05), targetLatencyS * 5);
    return { maxX: mx, maxY: my };
  }, [curvePoints, observations, mu, lambdaStar, ciHigh, targetLatencyS]);

  const toSvgX = (lam: number) => pad.left + (Math.max(0, Math.min(maxX, lam)) / maxX) * plotW;
  const toSvgY = (w: number) => pad.top + plotH - (Math.max(0, Math.min(maxY, w)) / maxY) * plotH;

  const predictedPath = useMemo(() => {
    const pts = curvePoints.filter((p) => p.latency <= maxY);
    if (pts.length === 0) return '';
    return pts
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${toSvgX(p.lambda).toFixed(1)} ${toSvgY(p.latency).toFixed(1)}`)
      .join(' ');
  }, [curvePoints, maxX, maxY]);

  const sortedMeasured = useMemo(
    () => [...observations].filter((o) => o.provenance === 'MEASURED').sort((a, b) => a.lambda - b.lambda),
    [observations],
  );
  const sortedSimulated = useMemo(
    () => [...observations].filter((o) => o.provenance === 'SIMULATED').sort((a, b) => a.lambda - b.lambda),
    [observations],
  );

  const buildPath = (pts: DataPoint[]) =>
    pts.length > 1
      ? pts
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${toSvgX(p.lambda).toFixed(1)} ${toSvgY(p.latency).toFixed(1)}`)
          .join(' ')
      : '';

  const interpolateCurveW = (lam: number): number => {
    if (curvePoints.length === 0) return 0;
    let closest = curvePoints[0];
    let bestDist = Infinity;
    for (const p of curvePoints) {
      const d = Math.abs(p.lambda - lam);
      if (d < bestDist) {
        bestDist = d;
        closest = p;
      }
    }
    return closest.latency;
  };

  const activeNewtonStep =
    activeStepIndex !== undefined && newtonIterations.length > 0
      ? newtonIterations[Math.min(activeStepIndex, newtonIterations.length - 1)]
      : null;

  const activeSecantPair = useMemo(() => {
    if (activeStepIndex === undefined || secantIterations.length < 2) return null;
    const idx = Math.min(activeStepIndex, secantIterations.length - 1);
    if (idx === 0) return { prev: secantIterations[0], curr: secantIterations[1] };
    return { prev: secantIterations[idx - 1], curr: secantIterations[idx] };
  }, [activeStepIndex, secantIterations]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    if (relX >= pad.left && relX <= width - pad.right) {
      const lam = ((relX - pad.left) / plotW) * maxX;
      setHoverX(lam);
    } else {
      setHoverX(null);
    }
  };

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxX);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto select-none cursor-crosshair overflow-visible"
        role="img"
        aria-label="Curva de latencia W(lambda) con umbral de timeout T y tasa crítica lambda estrella"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverX(null)}
      >
        {/* Grid lines */}
        {yTicks.map((val, idx) => {
          const y = toSvgY(val);
          return (
            <g key={`y-${idx}`}>
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
                y={y + 4}
                textAnchor="end"
                className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
              >
                {(val * 1000).toFixed(0)} ms
              </text>
            </g>
          );
        })}

        {xTicks.map((val, idx) => {
          const x = toSvgX(val);
          return (
            <g key={`x-${idx}`}>
              <line
                x1={x}
                y1={pad.top}
                x2={x}
                y2={height - pad.bottom}
                className="stroke-slate-200 dark:stroke-slate-800"
                strokeWidth="1"
              />
              <text
                x={x}
                y={height - pad.bottom + 18}
                textAnchor="middle"
                className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
              >
                {val.toFixed(0)}
              </text>
            </g>
          );
        })}

        {/* Axis labels */}
        <text
          x={pad.left + plotW / 2}
          y={height - 6}
          textAnchor="middle"
          className="fill-slate-600 dark:fill-slate-300 text-[11px] font-medium"
        >
          Tasa de llegada λ (req/s)
        </text>
        <text
          x={16}
          y={pad.top + plotH / 2}
          textAnchor="middle"
          transform={`rotate(-90 16 ${pad.top + plotH / 2})`}
          className="fill-slate-600 dark:fill-slate-300 text-[11px] font-medium"
        >
          Latencia W(λ) (ms)
        </text>

        {/* Bootstrap Confidence Interval band around lambda* */}
        {ciLow !== null && ciHigh !== null && ciHigh > ciLow && (
          <rect
            x={toSvgX(ciLow)}
            y={pad.top}
            width={Math.max(2, toSvgX(ciHigh) - toSvgX(ciLow))}
            height={plotH}
            className="fill-amber-500/15 dark:fill-amber-400/15"
          />
        )}

        {/* Timeout Threshold Line T */}
        {targetLatencyS <= maxY && (
          <g>
            <line
              x1={pad.left}
              y1={toSvgY(targetLatencyS)}
              x2={width - pad.right}
              y2={toSvgY(targetLatencyS)}
              stroke="#DC2626"
              strokeWidth="1.5"
              strokeDasharray="4,4"
            />
            <text
              x={pad.left + 8}
              y={toSvgY(targetLatencyS) - 6}
              textAnchor="start"
              className="fill-red-600 dark:fill-red-400 text-[10px] font-mono font-semibold"
            >
              Umbral T = {(targetLatencyS * 1000).toFixed(1)} ms
            </text>
          </g>
        )}

        {/* Capacity asymptote mu */}
        {mu <= maxX && (
          <g>
            <line
              x1={toSvgX(mu)}
              y1={pad.top}
              x2={toSvgX(mu)}
              y2={height - pad.bottom}
              className="stroke-slate-400 dark:stroke-slate-500"
              strokeWidth="1.2"
              strokeDasharray="2,3"
            />
            <text
              x={toSvgX(mu) - 6}
              y={pad.top + 12}
              textAnchor="end"
              className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
            >
              μ = {mu.toFixed(1)}
            </text>
          </g>
        )}

        {/* PREDICTED Curve: Dashed line */}
        {predictedPath && (
          <path
            d={predictedPath}
            fill="none"
            stroke="#D97706"
            strokeWidth="2.2"
            strokeDasharray="7,4"
          />
        )}

        {/* SIMULATED Series: Dotted line + points */}
        {sortedSimulated.length > 1 && (
          <path
            d={buildPath(sortedSimulated)}
            fill="none"
            stroke="#0891B2"
            strokeWidth="2"
            strokeDasharray="2,4"
          />
        )}
        {sortedSimulated.map((p, idx) => (
          <circle
            key={`sim-${idx}`}
            cx={toSvgX(p.lambda)}
            cy={toSvgY(p.latency)}
            r="3"
            className="fill-cyan-600 dark:fill-cyan-400"
          />
        ))}

        {/* MEASURED Series: Solid line + points */}
        {sortedMeasured.length > 1 && (
          <path d={buildPath(sortedMeasured)} fill="none" stroke="#16A34A" strokeWidth="2.2" />
        )}
        {sortedMeasured.map((p, idx) => (
          <circle
            key={`meas-${idx}`}
            cx={toSvgX(p.lambda)}
            cy={toSvgY(p.latency)}
            r="3.5"
            className="fill-emerald-600 dark:fill-emerald-400 stroke-white dark:stroke-slate-900"
            strokeWidth="1"
          />
        ))}

        {/* Critical Arrival Rate Marker lambda* */}
        {lambdaStar !== null && lambdaStar <= maxX && (
          <g>
            <line
              x1={toSvgX(lambdaStar)}
              y1={pad.top}
              x2={toSvgX(lambdaStar)}
              y2={height - pad.bottom}
              stroke="#2563EB"
              strokeWidth="1.8"
            />
            <circle
              cx={toSvgX(lambdaStar)}
              cy={toSvgY(targetLatencyS)}
              r="5"
              fill="#2563EB"
              stroke="#FFFFFF"
              strokeWidth="1.5"
            />
            <text
              x={toSvgX(lambdaStar) - 6}
              y={pad.top + 30}
              textAnchor="end"
              className="fill-blue-600 dark:fill-blue-400 text-[11px] font-mono font-bold"
            >
              λ* = {lambdaStar.toFixed(2)} req/s
            </text>
          </g>
        )}

        {/* Animated Newton Step Tangent on W(lambda) = T + f(lambda) */}
        {showNewton && activeNewtonStep && Number.isFinite(activeNewtonStep.x) && (
          <g>
            {(() => {
              const xk = activeNewtonStep.x;
              const yk = targetLatencyS + activeNewtonStep.fx;
              const nextX = xk + (activeNewtonStep.step ?? 0);
              const sx1 = toSvgX(xk);
              const sy1 = toSvgY(yk);
              const sx2 = toSvgX(nextX);
              const sy2 = toSvgY(targetLatencyS);
              return (
                <>
                  <line x1={sx1} y1={sy1} x2={sx2} y2={sy2} stroke="#2563EB" strokeWidth="2" />
                  <circle cx={sx1} cy={sy1} r="5.5" fill="#2563EB" stroke="#FFFFFF" strokeWidth="1.5" />
                  <circle cx={sx2} cy={sy2} r="4" fill="none" stroke="#2563EB" strokeWidth="2" />
                </>
              );
            })()}
          </g>
        )}

        {/* Animated Secant Chord */}
        {showSecant && activeSecantPair && (
          <g>
            {(() => {
              const y0 = targetLatencyS + activeSecantPair.prev.fx;
              const y1 = targetLatencyS + activeSecantPair.curr.fx;
              const nextX = activeSecantPair.curr.x + (activeSecantPair.curr.step ?? 0);
              return (
                <>
                  <line
                    x1={toSvgX(activeSecantPair.prev.x)}
                    y1={toSvgY(y0)}
                    x2={toSvgX(activeSecantPair.curr.x)}
                    y2={toSvgY(y1)}
                    stroke="#9333EA"
                    strokeWidth="2"
                  />
                  <line
                    x1={toSvgX(activeSecantPair.curr.x)}
                    y1={toSvgY(y1)}
                    x2={toSvgX(nextX)}
                    y2={toSvgY(targetLatencyS)}
                    stroke="#9333EA"
                    strokeWidth="1.4"
                    strokeDasharray="3,3"
                  />
                  <circle
                    cx={toSvgX(activeSecantPair.prev.x)}
                    cy={toSvgY(y0)}
                    r="4"
                    fill="#9333EA"
                    stroke="#FFFFFF"
                    strokeWidth="1"
                  />
                  <circle
                    cx={toSvgX(activeSecantPair.curr.x)}
                    cy={toSvgY(y1)}
                    r="5"
                    fill="#9333EA"
                    stroke="#FFFFFF"
                    strokeWidth="1.5"
                  />
                </>
              );
            })()}
          </g>
        )}

        {/* Interactive Crosshair HUD */}
        {hoverX !== null && (
          <g>
            <line
              x1={toSvgX(hoverX)}
              y1={pad.top}
              x2={toSvgX(hoverX)}
              y2={height - pad.bottom}
              className="stroke-slate-400 dark:stroke-slate-500"
              strokeWidth="1"
              strokeDasharray="2,2"
            />
            {(() => {
              const w = interpolateCurveW(hoverX);
              return (
                <g transform={`translate(${Math.min(width - 175, toSvgX(hoverX) + 8)}, ${pad.top + 8})`}>
                  <rect
                    width="160"
                    height="38"
                    rx="4"
                    className="fill-slate-900/90 dark:fill-slate-800/95 stroke-slate-700"
                    strokeWidth="1"
                  />
                  <text x="8" y="15" className="fill-slate-100 text-[10px] font-mono">
                    λ = {hoverX.toFixed(2)} req/s
                  </text>
                  <text x="8" y="30" className="fill-amber-300 text-[10px] font-mono">
                    W_pred = {(w * 1000).toFixed(2)} ms
                  </text>
                </g>
              );
            })()}
          </g>
        )}
      </svg>
    </div>
  );
}
