import { buildObjective } from './objectives';
import type {
  ObjectiveConfig,
  QueueModelType,
  QueueParams,
  SolverFailureReason,
  SolverIteration,
  SolverResult,
  StoppingCriterion,
} from './types';

export interface SolverOptions {
  tolF?: number;
  tolX?: number;
  maxIter?: number;
  analyticalRoot?: number | null;
  benchmarkReps?: number;
}

const DEFAULT_TOL_F = 1e-12;
const DEFAULT_TOL_X = 1e-10;
const DEFAULT_MAX_ITER = 60;
const EPS_ZERO = 1e-14;

/**
 * Estima el orden de convergencia empírico p ≈ ln(e_{n+1}/e_n) / ln(e_n/e_{n-1})
 * usando errores reales si la raíz es conocida, o pasos sucesivos |x_k - x_{k-1}|.
 */
export function estimateConvergenceOrder(
  iterations: SolverIteration[],
  root: number | null,
): number | null {
  const errors: number[] = [];
  if (root !== null && Number.isFinite(root)) {
    for (const it of iterations) {
      const e = Math.abs(it.x - root);
      if (e > 1e-15 && Number.isFinite(e)) errors.push(e);
    }
  }
  if (errors.length < 3) {
    errors.length = 0;
    for (const it of iterations) {
      if (it.stepError !== null && it.stepError > 1e-15 && Number.isFinite(it.stepError)) {
        errors.push(it.stepError);
      }
    }
  }
  if (errors.length < 3) return null;

  // Tomar las últimas 3 transiciones limpias antes de alcanzar precisión de máquina
  for (let i = errors.length - 1; i >= 2; i--) {
    const ePrev = errors[i - 2];
    const eCurr = errors[i - 1];
    const eNext = errors[i];
    const denom = Math.log(eCurr / ePrev);
    const numer = Math.log(eNext / eCurr);
    if (Math.abs(denom) > 1e-9 && Number.isFinite(numer / denom)) {
      const p = numer / denom;
      if (p > 0.2 && p < 5) {
        return Number(p.toFixed(4));
      }
    }
  }
  return null;
}

function medianNs(runFn: () => void, reps: number): number {
  const samples: number[] = [];
  const count = Math.max(1, reps);
  for (let i = 0; i < count; i++) {
    const t0 = process.hrtime.bigint();
    runFn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function finalizeResult(
  base: Omit<SolverResult, 'elapsedNs' | 'estimatedOrder' | 'efficiencyIndex' | 'absError' | 'relError'>,
  elapsedNs: number,
): SolverResult {
  const order = base.converged ? estimateConvergenceOrder(base.iterations, base.analyticalRoot ?? base.root) : null;
  const iterCount = Math.max(1, base.iterations.length);
  const totalCostPerIter = (base.fEvals + base.dfEvals) / iterCount;
  const efficiencyIndex =
    order !== null && totalCostPerIter > 0
      ? Number(Math.pow(order, 1 / totalCostPerIter).toFixed(4))
      : null;

  const absError =
    base.converged && base.root !== null && base.analyticalRoot !== null
      ? Math.abs(base.root - base.analyticalRoot)
      : null;
  const relError =
    absError !== null && base.analyticalRoot !== null && Math.abs(base.analyticalRoot) > 1e-15
      ? absError / Math.abs(base.analyticalRoot)
      : null;

  return {
    ...base,
    elapsedNs,
    estimatedOrder: order,
    efficiencyIndex,
    absError,
    relError,
  };
}

/**
 * Newton-Raphson implementado desde cero (sin librerías externas de optimización).
 * Si df es null, calcula diferencias finitas centrales con paso adaptativo y contabiliza las evaluaciones adicionales.
 * Nunca recorta silenciosamente iterados fuera del dominio: reporta DOMAIN_ESCAPE explícitamente.
 */
export function newtonRaphson(
  f: (x: number) => number,
  df: ((x: number) => number) | null,
  x0: number,
  domain: [number, number],
  options: SolverOptions = {},
): SolverResult {
  const tolF = options.tolF ?? DEFAULT_TOL_F;
  const tolX = options.tolX ?? DEFAULT_TOL_X;
  const maxIter = options.maxIter ?? DEFAULT_MAX_ITER;
  const analyticalRoot = options.analyticalRoot ?? null;
  const [domMin, domMax] = domain;

  const execute = (): Omit<
    SolverResult,
    'elapsedNs' | 'estimatedOrder' | 'efficiencyIndex' | 'absError' | 'relError'
  > => {
    const iterations: SolverIteration[] = [];
    let fEvals = 0;
    let dfEvals = 0;
    const usedFiniteDifference = df === null;

    if (!Number.isFinite(x0)) {
      return {
        method: 'NEWTON',
        converged: false,
        root: null,
        failureReason: 'INVALID_SEEDS',
        failureMessage: 'La semilla inicial x0 no es un número finito válido.',
        stoppingCriterion: 'FAILED',
        iterations,
        fEvals,
        dfEvals,
        usedFiniteDifference,
        analyticalRoot,
      };
    }

    if (x0 < domMin || x0 >= domMax) {
      return {
        method: 'NEWTON',
        converged: false,
        root: null,
        failureReason: 'DOMAIN_ESCAPE',
        failureMessage: `La semilla inicial λ₀=${x0.toFixed(6)} está fuera del dominio válido [${domMin}, ${domMax}).`,
        stoppingCriterion: 'FAILED',
        iterations,
        fEvals,
        dfEvals,
        usedFiniteDifference,
        analyticalRoot,
      };
    }

    const evalF = (x: number): number => {
      fEvals++;
      return f(x);
    };

    const evalDf = (x: number): number => {
      if (df !== null) {
        dfEvals++;
        return df(x);
      }
      // Diferencias finitas centrales con paso adaptativo h = max(1e-6, 1e-5 * |x|)
      // Si x+h o x-h sale del dominio, intenta diferencia unilateral antes de declarar escape
      let h = Math.max(1e-6, 1e-5 * Math.max(1, Math.abs(x)));
      if (x + h >= domMax) {
        h = (domMax - x) * 0.25;
      }
      if (x - h < domMin) {
        h = Math.max(1e-7, (x - domMin) * 0.25);
      }
      if (h <= 1e-12 || x + h >= domMax || x - h < domMin) {
        return Number.NaN;
      }
      const fp = evalF(x + h);
      const fm = evalF(x - h);
      return (fp - fm) / (2 * h);
    };

    let x = x0;
    let failureReason: SolverFailureReason = 'NONE';
    let failureMessage: string | null = null;
    let stoppingCriterion: StoppingCriterion = 'MAX_ITER';
    let converged = false;

    for (let n = 0; n < maxIter; n++) {
      if (!Number.isFinite(x)) {
        failureReason = 'NAN_INF';
        failureMessage = `Valor no finito (NaN/Inf) alcanzado en iteración ${n}.`;
        stoppingCriterion = 'FAILED';
        break;
      }
      if (x < domMin || x >= domMax) {
        failureReason = 'DOMAIN_ESCAPE';
        failureMessage = `Iterado λ_${n}=${x.toFixed(6)} escapó del dominio [${domMin}, ${domMax}).`;
        stoppingCriterion = 'FAILED';
        break;
      }

      const fx = evalF(x);
      if (!Number.isFinite(fx)) {
        failureReason = 'NAN_INF';
        failureMessage = `f(λ_${n}) produjo NaN/Inf en λ=${x.toFixed(6)}.`;
        stoppingCriterion = 'FAILED';
        break;
      }

      const dfx = evalDf(x);
      if (!Number.isFinite(dfx)) {
        failureReason = 'DOMAIN_ESCAPE';
        failureMessage = `No se pudo evaluar la derivada cerca de la frontera en λ_${n}=${x.toFixed(6)}.`;
        stoppingCriterion = 'FAILED';
        break;
      }

      const trueError = analyticalRoot !== null ? Math.abs(x - analyticalRoot) : null;

      if (Math.abs(fx) < tolF) {
        iterations.push({ n, x, fx, dfx, step: 0, stepError: 0, trueError });
        converged = true;
        stoppingCriterion = 'TOL_F';
        break;
      }

      if (Math.abs(dfx) < EPS_ZERO) {
        iterations.push({ n, x, fx, dfx, step: null, stepError: null, trueError });
        failureReason = 'ZERO_DERIVATIVE';
        failureMessage = `Derivada cercana a cero (|f'(λ_${n})|=${Math.abs(dfx).toExponential(2)} < ${EPS_ZERO}) en Newton-Raphson.`;
        stoppingCriterion = 'FAILED';
        break;
      }

      const step = -fx / dfx;
      const nextX = x + step;
      const stepError = Math.abs(step);
      const relStep = stepError / Math.max(1, Math.abs(nextX));

      iterations.push({ n, x, fx, dfx, step, stepError, trueError });

      if (!Number.isFinite(nextX)) {
        failureReason = 'NAN_INF';
        failureMessage = `El siguiente iterado es NaN/Inf tras paso ${step}.`;
        stoppingCriterion = 'FAILED';
        break;
      }

      if (nextX < domMin || nextX >= domMax) {
        failureReason = 'DOMAIN_ESCAPE';
        failureMessage = `El paso de Newton lanzó λ_${n + 1}=${nextX.toFixed(6)} fuera del dominio [${domMin}, ${domMax}).`;
        stoppingCriterion = 'FAILED';
        break;
      }

      x = nextX;

      if (relStep < tolX) {
        const finalFx = evalF(x);
        const finalDfx = evalDf(x);
        iterations.push({
          n: n + 1,
          x,
          fx: finalFx,
          dfx: Number.isFinite(finalDfx) ? finalDfx : null,
          step: 0,
          stepError: 0,
          trueError: analyticalRoot !== null ? Math.abs(x - analyticalRoot) : null,
        });
        converged = true;
        stoppingCriterion = 'TOL_X';
        break;
      }
    }

    if (!converged && failureReason === 'NONE') {
      failureReason = 'MAX_ITER';
      failureMessage = `Newton-Raphson no convergió dentro de ${maxIter} iteraciones.`;
      stoppingCriterion = 'MAX_ITER';
    }

    return {
      method: 'NEWTON',
      converged,
      root: converged ? x : null,
      failureReason,
      failureMessage,
      stoppingCriterion,
      iterations,
      fEvals,
      dfEvals,
      usedFiniteDifference,
      analyticalRoot,
    };
  };

  let lastRun = execute();
  const elapsedNs = medianNs(() => {
    lastRun = execute();
  }, options.benchmarkReps ?? 15);

  return finalizeResult(lastRun, elapsedNs);
}

/**
 * Método de la Secante implementado desde cero.
 * Nunca requiere evaluaciones de derivada (dfEvals = 0).
 */
export function secantMethod(
  f: (x: number) => number,
  x0: number,
  x1: number,
  domain: [number, number],
  options: SolverOptions = {},
): SolverResult {
  const tolF = options.tolF ?? DEFAULT_TOL_F;
  const tolX = options.tolX ?? DEFAULT_TOL_X;
  const maxIter = options.maxIter ?? DEFAULT_MAX_ITER;
  const analyticalRoot = options.analyticalRoot ?? null;
  const [domMin, domMax] = domain;

  const execute = (): Omit<
    SolverResult,
    'elapsedNs' | 'estimatedOrder' | 'efficiencyIndex' | 'absError' | 'relError'
  > => {
    const iterations: SolverIteration[] = [];
    let fEvals = 0;

    if (!Number.isFinite(x0) || !Number.isFinite(x1) || Math.abs(x1 - x0) < 1e-14) {
      return {
        method: 'SECANT',
        converged: false,
        root: null,
        failureReason: 'INVALID_SEEDS',
        failureMessage: 'Las semillas de la secante (λ₀, λ₁) deben ser finitas y distintas entre sí.',
        stoppingCriterion: 'FAILED',
        iterations,
        fEvals,
        dfEvals: 0,
        usedFiniteDifference: false,
        analyticalRoot,
      };
    }

    if (x0 < domMin || x0 >= domMax || x1 < domMin || x1 >= domMax) {
      return {
        method: 'SECANT',
        converged: false,
        root: null,
        failureReason: 'DOMAIN_ESCAPE',
        failureMessage: `Las semillas (${x0.toFixed(6)}, ${x1.toFixed(6)}) están fuera del dominio [${domMin}, ${domMax}).`,
        stoppingCriterion: 'FAILED',
        iterations,
        fEvals,
        dfEvals: 0,
        usedFiniteDifference: false,
        analyticalRoot,
      };
    }

    const evalF = (x: number): number => {
      fEvals++;
      return f(x);
    };

    let prevX = x0;
    let currX = x1;
    let fPrev = evalF(prevX);
    let fCurr = evalF(currX);

    if (!Number.isFinite(fPrev) || !Number.isFinite(fCurr)) {
      return {
        method: 'SECANT',
        converged: false,
        root: null,
        failureReason: 'NAN_INF',
        failureMessage: 'f(λ) devolvió NaN/Inf en las semillas iniciales de la secante.',
        stoppingCriterion: 'FAILED',
        iterations,
        fEvals,
        dfEvals: 0,
        usedFiniteDifference: false,
        analyticalRoot,
      };
    }

    iterations.push({
      n: 0,
      x: prevX,
      fx: fPrev,
      dfx: null,
      step: null,
      stepError: null,
      trueError: analyticalRoot !== null ? Math.abs(prevX - analyticalRoot) : null,
    });

    if (Math.abs(fPrev) < tolF) {
      return {
        method: 'SECANT',
        converged: true,
        root: prevX,
        failureReason: 'NONE',
        failureMessage: null,
        stoppingCriterion: 'TOL_F',
        iterations,
        fEvals,
        dfEvals: 0,
        usedFiniteDifference: false,
        analyticalRoot,
      };
    }

    let failureReason: SolverFailureReason = 'NONE';
    let failureMessage: string | null = null;
    let stoppingCriterion: StoppingCriterion = 'MAX_ITER';
    let converged = false;

    for (let n = 1; n <= maxIter; n++) {
      const trueError = analyticalRoot !== null ? Math.abs(currX - analyticalRoot) : null;

      if (Math.abs(fCurr) < tolF) {
        iterations.push({
          n,
          x: currX,
          fx: fCurr,
          dfx: null,
          step: currX - prevX,
          stepError: Math.abs(currX - prevX),
          trueError,
        });
        converged = true;
        stoppingCriterion = 'TOL_F';
        break;
      }

      const denom = fCurr - fPrev;
      if (Math.abs(denom) < EPS_ZERO) {
        iterations.push({
          n,
          x: currX,
          fx: fCurr,
          dfx: null,
          step: null,
          stepError: null,
          trueError,
        });
        failureReason = 'ZERO_DENOMINATOR';
        failureMessage = `Denominador de la secante casi nulo (|f(λ_${n}) - f(λ_${n - 1})| = ${Math.abs(denom).toExponential(2)}).`;
        stoppingCriterion = 'FAILED';
        break;
      }

      const secSlope = denom / (currX - prevX);
      const step = -fCurr * ((currX - prevX) / denom);
      const nextX = currX + step;
      const stepError = Math.abs(step);
      const relStep = stepError / Math.max(1, Math.abs(nextX));

      iterations.push({
        n,
        x: currX,
        fx: fCurr,
        dfx: secSlope,
        step,
        stepError,
        trueError,
      });

      if (!Number.isFinite(nextX)) {
        failureReason = 'NAN_INF';
        failureMessage = `La secante produjo NaN/Inf en iteración ${n}.`;
        stoppingCriterion = 'FAILED';
        break;
      }

      if (nextX < domMin || nextX >= domMax) {
        failureReason = 'DOMAIN_ESCAPE';
        failureMessage = `El paso de la secante lanzó λ_${n + 1}=${nextX.toFixed(6)} fuera del dominio [${domMin}, ${domMax}).`;
        stoppingCriterion = 'FAILED';
        break;
      }

      prevX = currX;
      fPrev = fCurr;
      currX = nextX;
      fCurr = evalF(currX);

      if (!Number.isFinite(fCurr)) {
        failureReason = 'NAN_INF';
        failureMessage = `f(λ_${n + 1}) produjo NaN/Inf en λ=${currX.toFixed(6)}.`;
        stoppingCriterion = 'FAILED';
        break;
      }

      if (relStep < tolX) {
        iterations.push({
          n: n + 1,
          x: currX,
          fx: fCurr,
          dfx: null,
          step: 0,
          stepError: 0,
          trueError: analyticalRoot !== null ? Math.abs(currX - analyticalRoot) : null,
        });
        converged = true;
        stoppingCriterion = 'TOL_X';
        break;
      }
    }

    if (!converged && failureReason === 'NONE') {
      failureReason = 'MAX_ITER';
      failureMessage = `El método de la secante no convergió en ${maxIter} iteraciones.`;
      stoppingCriterion = 'MAX_ITER';
    }

    return {
      method: 'SECANT',
      converged,
      root: converged ? currX : null,
      failureReason,
      failureMessage,
      stoppingCriterion,
      iterations,
      fEvals,
      dfEvals: 0,
      usedFiniteDifference: false,
      analyticalRoot,
    };
  };

  let lastRun = execute();
  const elapsedNs = medianNs(() => {
    lastRun = execute();
  }, options.benchmarkReps ?? 15);

  return finalizeResult(lastRun, elapsedNs);
}

/**
 * Bisección como línea base robusta de referencia.
 */
export function bisectionMethod(
  f: (x: number) => number,
  a0: number,
  b0: number,
  domain: [number, number],
  options: SolverOptions = {},
): SolverResult {
  const tolF = options.tolF ?? DEFAULT_TOL_F;
  const tolX = options.tolX ?? DEFAULT_TOL_X;
  const maxIter = options.maxIter ?? 100;
  const analyticalRoot = options.analyticalRoot ?? null;
  const [domMin, domMax] = domain;

  const execute = (): Omit<
    SolverResult,
    'elapsedNs' | 'estimatedOrder' | 'efficiencyIndex' | 'absError' | 'relError'
  > => {
    const iterations: SolverIteration[] = [];
    let fEvals = 0;

    if (!Number.isFinite(a0) || !Number.isFinite(b0) || a0 >= b0 || a0 < domMin || b0 >= domMax) {
      return {
        method: 'BISECTION',
        converged: false,
        root: null,
        failureReason: 'INVALID_SEEDS',
        failureMessage: `El intervalo de bisección [${a0}, ${b0}] debe ser válido dentro de [${domMin}, ${domMax}).`,
        stoppingCriterion: 'FAILED',
        iterations,
        fEvals,
        dfEvals: 0,
        usedFiniteDifference: false,
        analyticalRoot,
      };
    }

    let a = a0;
    let b = b0;
    let fa = f(a);
    let fb = f(b);
    fEvals += 2;

    if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
      return {
        method: 'BISECTION',
        converged: false,
        root: null,
        failureReason: 'NAN_INF',
        failureMessage: 'f(x) devolvió NaN/Inf en los extremos de bisección.',
        stoppingCriterion: 'FAILED',
        iterations,
        fEvals,
        dfEvals: 0,
        usedFiniteDifference: false,
        analyticalRoot,
      };
    }

    if (fa * fb > 0) {
      return {
        method: 'BISECTION',
        converged: false,
        root: null,
        failureReason: 'INVALID_SEEDS',
        failureMessage: `No hay cambio de signo en [${a0.toFixed(4)}, ${b0.toFixed(4)}]: f(a)=${fa.toExponential(2)}, f(b)=${fb.toExponential(2)}.`,
        stoppingCriterion: 'FAILED',
        iterations,
        fEvals,
        dfEvals: 0,
        usedFiniteDifference: false,
        analyticalRoot,
      };
    }

    let mid = (a + b) / 2;
    let prevMid = mid;
    let converged = false;
    let stoppingCriterion: StoppingCriterion = 'MAX_ITER';

    for (let n = 0; n < maxIter; n++) {
      mid = (a + b) / 2;
      const fmid = f(mid);
      fEvals++;
      const step = n === 0 ? (b - a) / 2 : mid - prevMid;
      const stepError = (b - a) / 2;

      iterations.push({
        n,
        x: mid,
        fx: fmid,
        dfx: null,
        step,
        stepError,
        trueError: analyticalRoot !== null ? Math.abs(mid - analyticalRoot) : null,
      });

      if (Math.abs(fmid) < tolF) {
        converged = true;
        stoppingCriterion = 'TOL_F';
        break;
      }
      if (stepError / Math.max(1, Math.abs(mid)) < tolX) {
        converged = true;
        stoppingCriterion = 'TOL_X';
        break;
      }

      if (fa * fmid < 0) {
        b = mid;
        fb = fmid;
      } else {
        a = mid;
        fa = fmid;
      }
      prevMid = mid;
    }

    return {
      method: 'BISECTION',
      converged,
      root: converged ? mid : null,
      failureReason: converged ? 'NONE' : 'MAX_ITER',
      failureMessage: converged ? null : `Bisección alcanzó maxIter=${maxIter}.`,
      stoppingCriterion,
      iterations,
      fEvals,
      dfEvals: 0,
      usedFiniteDifference: false,
      analyticalRoot,
    };
  };

  let lastRun = execute();
  const elapsedNs = medianNs(() => {
    lastRun = execute();
  }, options.benchmarkReps ?? 10);

  return finalizeResult(lastRun, elapsedNs);
}

/**
 * Ejecuta la suite completa (Newton, Secante y Bisección) para un modelo y objetivo dado,
 * validando existencia de raíz positiva sin ocultar condiciones límite.
 */
export function solveThresholdComparison(input: {
  modelType: QueueModelType;
  params: QueueParams;
  objective: ObjectiveConfig;
  newtonSeed?: number;
  secantSeeds?: [number, number];
  tolF?: number;
  tolX?: number;
  maxIter?: number;
}): {
  newton: SolverResult;
  secant: SolverResult;
  bisection: SolverResult;
  analyticalRoot: number | null;
  domain: [number, number];
  noPositiveRootReason: string | null;
} {
  const evalObj = buildObjective(input.modelType, input.params, input.objective);
  const [domMin, domMax] = evalObj.domain;

  if (evalObj.noPositiveRootReason) {
    const failedResult = (method: 'NEWTON' | 'SECANT' | 'BISECTION'): SolverResult => ({
      method,
      converged: false,
      root: null,
      failureReason: 'NO_POSITIVE_ROOT',
      failureMessage: evalObj.noPositiveRootReason,
      stoppingCriterion: 'FAILED',
      iterations: [],
      fEvals: 0,
      dfEvals: 0,
      elapsedNs: 0,
      estimatedOrder: null,
      efficiencyIndex: null,
      usedFiniteDifference: false,
      analyticalRoot: null,
      absError: null,
      relError: null,
    });
    return {
      newton: failedResult('NEWTON'),
      secant: failedResult('SECANT'),
      bisection: failedResult('BISECTION'),
      analyticalRoot: null,
      domain: evalObj.domain,
      noPositiveRootReason: evalObj.noPositiveRootReason,
    };
  }

  // Localizar intervalo de cambio de signo para bisección y semillas automáticas seguras
  const safeStart = domMin + Math.max(1e-6, (domMax - domMin) * 1e-4);
  const safeEnd = domMax * 0.999;
  let bracketA = safeStart;
  let bracketB = safeEnd;
  const scanSteps = 60;
  const scanStep = (safeEnd - safeStart) / scanSteps;
  let prevX = safeStart;
  let prevF = evalObj.f(prevX);
  for (let i = 1; i <= scanSteps; i++) {
    const currX = safeStart + i * scanStep;
    const currF = evalObj.f(currX);
    if (Number.isFinite(prevF) && Number.isFinite(currF) && prevF * currF <= 0) {
      bracketA = prevX;
      bracketB = currX;
      break;
    }
    prevX = currX;
    prevF = currF;
  }

  // Semillas por defecto cerca del cruce de cero si el usuario no especificó unas personalizadas
  const bracketMid = (bracketA + bracketB) / 2;
  const x0 = input.newtonSeed ?? bracketMid;
  const s0 = input.secantSeeds?.[0] ?? bracketA;
  const s1 = input.secantSeeds?.[1] ?? bracketB;

  const opts: SolverOptions = {
    tolF: input.tolF ?? DEFAULT_TOL_F,
    tolX: input.tolX ?? DEFAULT_TOL_X,
    maxIter: input.maxIter ?? DEFAULT_MAX_ITER,
    analyticalRoot: evalObj.analyticalRoot,
  };

  const newton = newtonRaphson(evalObj.f, evalObj.df, x0, evalObj.domain, opts);
  const secant = secantMethod(evalObj.f, s0, s1, evalObj.domain, opts);
  const bisection = bisectionMethod(evalObj.f, bracketA, bracketB, evalObj.domain, opts);

  return {
    newton,
    secant,
    bisection,
    analyticalRoot: evalObj.analyticalRoot,
    domain: evalObj.domain,
    noPositiveRootReason: null,
  };
}

export interface BasinCell {
  seedRatio: number; // lambda0 / mu
  seedValue: number;
  newtonConverged: boolean;
  newtonIterations: number;
  newtonReason: SolverFailureReason;
  secantConverged: boolean;
  secantIterations: number;
  secantReason: SolverFailureReason;
  insideTheoreticalNewtonInterval: boolean; // lambda0 in (mu - 2/T, mu)
}

/**
 * Análisis de sensibilidad a las semillas (mapa de cuencas de convergencia).
 * Para M/M/1 con latencia media verifica el hecho analítico λ₀ ∈ (μ − 2/T, μ).
 */
export function computeBasinOfConvergence(input: {
  modelType: QueueModelType;
  params: QueueParams;
  objective: ObjectiveConfig;
  samples?: number;
}): {
  theoreticalNewtonLowerBound: number | null;
  theoreticalNewtonUpperBound: number;
  cells: BasinCell[];
} {
  const evalObj = buildObjective(input.modelType, input.params, input.objective);
  const [domMin, domMax] = evalObj.domain;
  const count = Math.min(60, Math.max(12, input.samples ?? 24));
  const T = input.objective.targetLatencyS;
  const theoreticalLower =
    input.modelType === 'MM1' && input.objective.type === 'MEAN_LATENCY'
      ? Math.max(0, input.params.mu - 2 / T)
      : null;

  const cells: BasinCell[] = [];
  for (let i = 0; i < count; i++) {
    const frac = 0.04 + (i / (count - 1)) * 0.94;
    const x0 = domMin + frac * (domMax - domMin);
    const x1 = Math.min(domMax - 1e-4, x0 + (domMax - domMin) * 0.04);

    const nr = newtonRaphson(evalObj.f, evalObj.df, x0, evalObj.domain, {
      benchmarkReps: 1,
      analyticalRoot: evalObj.analyticalRoot,
    });
    const sr = secantMethod(evalObj.f, x0, x1, evalObj.domain, {
      benchmarkReps: 1,
      analyticalRoot: evalObj.analyticalRoot,
    });

    const inside =
      theoreticalLower !== null
        ? x0 > input.params.mu - 2 / T && x0 < input.params.mu
        : nr.converged;

    cells.push({
      seedRatio: Number((x0 / input.params.mu).toFixed(4)),
      seedValue: Number(x0.toFixed(4)),
      newtonConverged: nr.converged,
      newtonIterations: nr.iterations.length,
      newtonReason: nr.failureReason,
      secantConverged: sr.converged,
      secantIterations: sr.iterations.length,
      secantReason: sr.failureReason,
      insideTheoreticalNewtonInterval: inside,
    });
  }

  return {
    theoreticalNewtonLowerBound: theoreticalLower,
    theoreticalNewtonUpperBound: domMax,
    cells,
  };
}

/**
 * Sensibilidad a la tolerancia (1e-3 hasta 1e-12) para comparar costo e iteraciones.
 */
export function computeToleranceSensitivity(input: {
  modelType: QueueModelType;
  params: QueueParams;
  objective: ObjectiveConfig;
  newtonSeed?: number;
  secantSeeds?: [number, number];
}): Array<{
  tolerance: number;
  newtonIters: number;
  newtonEvals: number;
  secantIters: number;
  secantEvals: number;
}> {
  const tolerances = [1e-3, 1e-5, 1e-7, 1e-9, 1e-11];
  return tolerances.map((tol) => {
    const res = solveThresholdComparison({
      ...input,
      tolF: tol,
      tolX: tol,
    });
    return {
      tolerance: tol,
      newtonIters: res.newton.iterations.length,
      newtonEvals: res.newton.fEvals + res.newton.dfEvals,
      secantIters: res.secant.iterations.length,
      secantEvals: res.secant.fEvals,
    };
  });
}
