import React, { useEffect, useState } from 'react';
import { umbralApi, type MathAnalysisResponse } from '../api/client';
import { BasinHeatmap } from '../charts/BasinHeatmap';
import { ErrorConvergenceChart } from '../charts/ErrorConvergenceChart';
import { HelpTip } from '../components/HelpTip';
import { ES } from '../i18n/es';

export function ComparisonPage() {
  const [model, setModel] = useState<'MM1' | 'MM1K' | 'MMC' | 'MG1'>('MM1');
  const [mu, setMu] = useState(100);
  const [cVal, setCVal] = useState(2);
  const [kVal, setKVal] = useState(80);
  const [cvVal, setCvVal] = useState(1.25);
  const [targetLatencyS, setTargetLatencyS] = useState(0.05);
  const [newtonSeed, setNewtonSeed] = useState(68);
  const [secantS0, setSecantS0] = useState(55);
  const [secantS1, setSecantS1] = useState(68);
  const [data, setData] = useState<MathAnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scenarioLabel, setScenarioLabel] = useState<string>('Caso ideal: M/M/1 con derivada analítica');

  const applyDemo = (kind: 'IDEAL' | 'DOMAIN_ESCAPE' | 'MMC_NO_DERIV') => {
    if (kind === 'IDEAL') {
      setModel('MM1');
      setMu(100);
      setTargetLatencyS(0.05);
      setNewtonSeed(68);
      setSecantS0(55);
      setSecantS1(68);
      setScenarioLabel('Caso ideal: Newton dentro de (60, 100) converge en orden cuadrático');
    } else if (kind === 'DOMAIN_ESCAPE') {
      setModel('MM1');
      setMu(100);
      setTargetLatencyS(0.05);
      setNewtonSeed(45);
      setSecantS0(55);
      setSecantS1(68);
      setScenarioLabel('Semilla fuera de intervalo: λ₀ = 45 ≤ μ − 2/T = 60 provoca escape de dominio en Newton');
    } else {
      setModel('MMC');
      setMu(50);
      setCVal(2);
      setTargetLatencyS(0.05);
      setNewtonSeed(65);
      setSecantS0(55);
      setSecantS1(68);
      setScenarioLabel('Sin derivada analítica (Erlang C): la secante evita diferencias finitas y gana en eficiencia');
    }
  };

  useEffect(() => {
    let cancelled = false;
    umbralApi
      .analyzeMath({
        model,
        params: { mu, c: cVal, K: kVal, cv: cvVal },
        objective: { type: 'MEAN_LATENCY', targetLatencyS },
        newtonSeed,
        secantSeeds: [secantS0, secantS1],
      })
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [model, mu, cVal, kVal, cvVal, targetLatencyS, newtonSeed, secantS0, secantS1]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Comparación Numérica: Newton-Raphson vs. Secante
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Explore con un clic por qué Newton brilla con derivada analítica y por qué la Secante es superior en curvas sin derivada o análisis forense.
        </p>
      </div>

      {/* Escenarios demostrativos de 1 clic */}
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => applyDemo('IDEAL')}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:border-blue-500 text-slate-800 dark:text-slate-200 transition-colors whitespace-nowrap"
            >
              Caso ideal (M/M/1)
            </button>
            <button
              type="button"
              onClick={() => applyDemo('DOMAIN_ESCAPE')}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:border-amber-500 text-slate-800 dark:text-slate-200 transition-colors whitespace-nowrap"
            >
              Semilla fuera de intervalo (ver escape de dominio)
            </button>
            <button
              type="button"
              onClick={() => applyDemo('MMC_NO_DERIV')}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:border-purple-500 text-slate-800 dark:text-slate-200 transition-colors whitespace-nowrap"
            >
              Sin derivada analítica (Erlang C — ventaja Secante)
            </button>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400">{scenarioLabel}</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <div>
            <label htmlFor="cmp-model" className="block text-xs font-medium mb-1">
              Modelo
            </label>
            <select
              id="cmp-model"
              value={model}
              onChange={(e) => setModel(e.target.value as typeof model)}
              className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="MM1">M/M/1</option>
              <option value="MMC">M/M/c (Erlang C)</option>
              <option value="MG1">M/G/1</option>
              <option value="MM1K">M/M/1/K</option>
            </select>
          </div>
          <div>
            <label htmlFor="cmp-mu" className="block text-xs font-medium mb-1">
              μ (req/s)
            </label>
            <input
              id="cmp-mu"
              type="number"
              min={10}
              value={mu}
              onChange={(e) => setMu(Number(e.target.value))}
              className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div>
            <label htmlFor="cmp-t" className="block text-xs font-medium mb-1">
              Timeout T (s) <span className="font-mono text-slate-500">= {(targetLatencyS * 1000).toFixed(0)} ms</span>
            </label>
            <input
              id="cmp-t"
              type="number"
              min={0.005}
              step={0.005}
              value={targetLatencyS}
              onChange={(e) => setTargetLatencyS(Number(e.target.value))}
              className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div>
            <label htmlFor="cmp-n0" className="inline-flex items-center gap-1 text-xs font-medium mb-1">
              <span>Newton λ₀</span>
              <HelpTip
                label="semilla Newton"
                text="Valor inicial para Newton-Raphson. En M/M/1 debe estar dentro de (μ − 2/T, μ) para no salir del dominio [0, μ)."
              />
            </label>
            <input
              id="cmp-n0"
              type="number"
              step={1}
              value={newtonSeed}
              onChange={(e) => setNewtonSeed(Number(e.target.value))}
              className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div>
            <label htmlFor="cmp-s0" className="inline-flex items-center gap-1 text-xs font-medium mb-1">
              <span>Secante λ₀</span>
              <HelpTip
                label="semillas secante"
                text="La secante usa dos puntos iniciales (λ₀, λ₁) para aproximar la pendiente sin calcular derivadas."
              />
            </label>
            <input
              id="cmp-s0"
              type="number"
              step={1}
              value={secantS0}
              onChange={(e) => setSecantS0(Number(e.target.value))}
              className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div>
            <label htmlFor="cmp-s1" className="block text-xs font-medium mb-1">
              Secante λ₁
            </label>
            <input
              id="cmp-s1"
              type="number"
              step={1}
              value={secantS1}
              onChange={(e) => setSecantS1(Number(e.target.value))}
              className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          {model === 'MMC' ? (
            <div>
              <label htmlFor="cmp-c" className="block text-xs font-medium mb-1">
                Workers c
              </label>
              <input
                id="cmp-c"
                type="number"
                min={1}
                value={cVal}
                onChange={(e) => setCVal(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
          ) : model === 'MG1' ? (
            <div>
              <label htmlFor="cmp-cv" className="block text-xs font-medium mb-1">
                CV servicio
              </label>
              <input
                id="cmp-cv"
                type="number"
                min={0.1}
                step={0.1}
                value={cvVal}
                onChange={(e) => setCvVal(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
          ) : model === 'MM1K' ? (
            <div>
              <label htmlFor="cmp-k" className="block text-xs font-medium mb-1">
                Capacidad K
              </label>
              <input
                id="cmp-k"
                type="number"
                min={2}
                value={kVal}
                onChange={(e) => setKVal(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
          ) : (
            <div>
              <span className="block text-xs font-medium mb-1">Raíz analítica λ*</span>
              <div className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300">
                {targetLatencyS > 1 / mu ? `${(mu - 1 / targetLatencyS).toFixed(2)} req/s` : 'Sin raíz ≥ 0'}
              </div>
            </div>
          )}
        </div>
      </section>

      {error && (
        <div className="border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 rounded-lg p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Resumen instantáneo lado a lado */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-4 space-y-1">
              <div className="text-xs font-medium text-blue-700 dark:text-blue-300">Newton-Raphson</div>
              <div className="text-sm font-mono font-semibold tabular-nums">
                {data.solved.newton.converged
                  ? `Convergió: λ* = ${data.solved.newton.root?.toFixed(4)} req/s`
                  : `Falló: ${ES.failureReasons[data.solved.newton.failureReason] ?? data.solved.newton.failureReason}`}
              </div>
              <div className="text-xs font-mono text-slate-500 tabular-nums">
                {data.solved.newton.iterations.length} iter · {data.solved.newton.fEvals} f / {data.solved.newton.dfEvals} f&apos;
                {data.solved.newton.usedFiniteDifference ? ' · dif. finitas' : ''}
              </div>
            </div>

            <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-4 space-y-1">
              <div className="text-xs font-medium text-purple-700 dark:text-purple-300">Método de la Secante</div>
              <div className="text-sm font-mono font-semibold tabular-nums">
                {data.solved.secant.converged
                  ? `Convergió: λ* = ${data.solved.secant.root?.toFixed(4)} req/s`
                  : `Falló: ${ES.failureReasons[data.solved.secant.failureReason] ?? data.solved.secant.failureReason}`}
              </div>
              <div className="text-xs font-mono text-slate-500 tabular-nums">
                {data.solved.secant.iterations.length} iter · {data.solved.secant.fEvals} eval. de f
              </div>
            </div>

            <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-4 space-y-1">
              <div className="text-xs font-medium text-slate-600 dark:text-slate-300">Conclusión práctica</div>
              <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                {!data.solved.newton.converged && data.solved.secant.converged
                  ? 'Con la semilla ingresada Newton escapó del dominio, mientras la Secante convergió correctamente.'
                  : data.solved.newton.usedFiniteDifference
                    ? 'Sin derivada analítica, Newton cuesta ~3 evaluaciones por paso frente a solo 1 de la Secante.'
                    : 'Con derivada analítica exacta y buena semilla, Newton alcanza orden cuadrático con mínimo costo.'}
              </p>
            </div>
          </section>

          {/* Argumento técnico Newton vs Secante */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-2">
              <h2 className="text-sm font-semibold text-blue-700 dark:text-blue-300">
                Newton-Raphson como defensa activa (derivada analítica)
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Cuando el modelo tiene derivada analítica cerrada y barata (M/M/1 y M/G/1), Newton converge cuadráticamente (orden p ≈ 2) en menos iteraciones. Sin embargo, para M/M/1 con objetivo de latencia media solo converge si λ₀ ∈ (μ − 2/T, μ); fuera de ese intervalo el primer paso escapa del dominio [0, μ).
              </p>
            </div>

            <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-2">
              <h2 className="text-sm font-semibold text-purple-700 dark:text-purple-300">
                Secante para análisis forense y curvas sin derivada
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                En modelos sin derivada analítica cómoda (M/M/c Erlang C, M/M/1/K o interpolación empírica PCHIP sobre logs reales), Newton debe aproximar f&apos; mediante diferencias finitas (+2 evaluaciones de f por iteración). La secante alcanza orden superlineal p ≈ 1.618 con solo 1 evaluación de f por paso, logrando mayor índice de eficiencia p^(1/costo).
              </p>
            </div>
          </div>

          {/* Basin of Convergence */}
          <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-3">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Mapa de Cuencas de Convergencia (Sensibilidad a Semillas)
            </h2>
            <BasinHeatmap basin={data.basin} mu={model === 'MMC' ? mu * cVal : mu} />
          </section>

          {/* Error curve + Tolerance sensitivity */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-3">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Decaimiento de Error por Iteración
              </h2>
              <ErrorConvergenceChart
                newtonIterations={data.solved.newton.iterations}
                secantIterations={data.solved.secant.iterations}
                bisectionIterations={data.solved.bisection.iterations}
              />
              {(!data.solved.newton.converged || !data.solved.secant.converged) && (
                <div className="text-xs text-red-700 dark:text-red-300 font-mono">
                  {!data.solved.newton.converged && (
                    <div>Newton: {ES.failureReasons[data.solved.newton.failureReason]} — {data.solved.newton.failureMessage}</div>
                  )}
                  {!data.solved.secant.converged && (
                    <div>Secante: {ES.failureReasons[data.solved.secant.failureReason]} — {data.solved.secant.failureMessage}</div>
                  )}
                </div>
              )}
            </section>

            <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg p-5 space-y-3">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Sensibilidad a la Tolerancia
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse font-mono tabular-nums">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="py-2 pr-3 font-sans">Tolerancia</th>
                      <th className="py-2 px-3 text-right font-sans">Iter. Newton</th>
                      <th className="py-2 px-3 text-right font-sans">Eval. Newton</th>
                      <th className="py-2 px-3 text-right font-sans">Iter. Secante</th>
                      <th className="py-2 pl-3 text-right font-sans">Eval. Secante</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                    {data.tolSensitivity.map((row) => (
                      <tr key={row.tolerance}>
                        <td className="py-2 pr-3">{row.tolerance.toExponential(0)}</td>
                        <td className="py-2 px-3 text-right">{row.newtonIters}</td>
                        <td className="py-2 px-3 text-right">{row.newtonEvals}</td>
                        <td className="py-2 px-3 text-right">{row.secantIters}</td>
                        <td className="py-2 pl-3 text-right">{row.secantEvals}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
