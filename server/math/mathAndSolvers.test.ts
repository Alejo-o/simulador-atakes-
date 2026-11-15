import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MM1Model,
  MM1KModel,
  MMCModel,
  MG1Model,
  EmpiricalModel,
  erlangC,
} from './queues';
import {
  newtonRaphson,
  secantMethod,
  bisectionMethod,
  solveThresholdComparison,
  computeBasinOfConvergence,
} from './solvers';
import { fitRobustMM1, predictWithConfidence, evaluatePreventiveAlerts } from './fitting';

test('M/M/1, M/M/1/K, M/M/c, M/G/1 and Empirical PCHIP mathematical formulas', () => {
  // M/M/1: mu=100, lambda=60 => W = 1/40 = 0.025 s
  assert.ok(Math.abs(MM1Model.latency(60, { mu: 100 }) - 0.025) < 1e-12);
  assert.ok(Math.abs((MM1Model.latencyDerivative(60, { mu: 100 }) ?? 0) - 1 / 1600) < 1e-12);

  // M/M/1/K special case rho=1 => P_B = 1/(K+1), W = (K+1)/(2*mu)
  const pb1 = MM1KModel.blockingProbability(50, { mu: 50, K: 9 });
  assert.ok(Math.abs(pb1 - 0.1) < 1e-9);
  const w1 = MM1KModel.latency(50, { mu: 50, K: 9 });
  assert.ok(Math.abs(w1 - 10 / 100) < 1e-9);

  // M/M/1/K rho=0.5, K=3 => P_B = (0.5 * 0.125) / (1 - 0.0625) = 0.0625 / 0.9375 = 1/15
  const pbHalf = MM1KModel.blockingProbability(25, { mu: 50, K: 3 });
  assert.ok(Math.abs(pbHalf - 1 / 15) < 1e-9);

  // M/M/c (Erlang C) known textbook value: c=2, a=lambda/mu=1 (rho=0.5) => C(2,1) = 1/3
  const ec = erlangC(2, 1);
  assert.ok(Math.abs(ec - 1 / 3) < 1e-9);
  // W = C(2,1)/(2*50 - 50) + 1/50 = (1/3)/50 + 1/50 = 4/150
  const wMmc = MMCModel.latency(50, { mu: 50, c: 2 });
  assert.ok(Math.abs(wMmc - 4 / 150) < 1e-9);
  assert.equal(MMCModel.latencyDerivative(50, { mu: 50, c: 2 }), null);

  // M/G/1 Pollaczek-Khinchine: CV=1 matches M/M/1; CV=0 (M/D/1) has half queueing wait
  assert.ok(Math.abs(MG1Model.latency(60, { mu: 100, cv: 1 }) - 0.025) < 1e-12);
  // M/D/1: Wq = rho / (2*mu*(1-rho)) = 0.6 / (200 * 0.4) = 0.0075; W = 0.0075 + 0.01 = 0.0175
  assert.ok(Math.abs(MG1Model.latency(60, { mu: 100, cv: 0 }) - 0.0175) < 1e-12);

  // Empirical PCHIP preserves exact knot values and monotonicity
  const pts = [
    { lambda: 10, latency: 0.012 },
    { lambda: 30, latency: 0.018 },
    { lambda: 50, latency: 0.030 },
    { lambda: 70, latency: 0.065 },
  ];
  assert.ok(Math.abs(EmpiricalModel.latency(30, { mu: 100, empiricalPoints: pts }) - 0.018) < 1e-9);
  const w40 = EmpiricalModel.latency(40, { mu: 100, empiricalPoints: pts });
  assert.ok(w40 > 0.018 && w40 < 0.030);
});

test('Analytical convergence theorem for Newton-Raphson on M/M/1 mean latency: lambda0 in (mu - 2/T, mu) and order ~2 vs Secant ~1.618', () => {
  const mu = 100;
  const T = 0.05; // 2/T = 40 => convergence interval is (60, 100), analytical root = 80

  const insideRes = solveThresholdComparison({
    modelType: 'MM1',
    params: { mu },
    objective: { type: 'MEAN_LATENCY', targetLatencyS: T },
    newtonSeed: 68, // inside (60, 100)
    secantSeeds: [55, 68],
  });

  assert.equal(insideRes.newton.converged, true);
  assert.ok(Math.abs((insideRes.newton.root ?? 0) - 80) < 1e-9);
  assert.ok(insideRes.newton.estimatedOrder !== null && insideRes.newton.estimatedOrder >= 1.85);

  assert.equal(insideRes.secant.converged, true);
  assert.ok(Math.abs((insideRes.secant.root ?? 0) - 80) < 1e-9);
  assert.ok(
    insideRes.secant.estimatedOrder !== null &&
      insideRes.secant.estimatedOrder > 1.35 &&
      insideRes.secant.estimatedOrder < 1.85,
  );

  // Outside interval (lambda0 <= mu - 2/T = 60, e.g. 50): Newton MUST report DOMAIN_ESCAPE
  const outsideRes = solveThresholdComparison({
    modelType: 'MM1',
    params: { mu },
    objective: { type: 'MEAN_LATENCY', targetLatencyS: T },
    newtonSeed: 50,
    secantSeeds: [45, 55],
  });
  assert.equal(outsideRes.newton.converged, false);
  assert.equal(outsideRes.newton.failureReason, 'DOMAIN_ESCAPE');

  // Verify basin of convergence matches theoretical interval
  const basin = computeBasinOfConvergence({
    modelType: 'MM1',
    params: { mu },
    objective: { type: 'MEAN_LATENCY', targetLatencyS: T },
    samples: 20,
  });
  assert.equal(basin.theoreticalNewtonLowerBound, 60);
  for (const cell of basin.cells) {
    if (cell.seedValue > 60.5 && cell.seedValue < 99.5) {
      assert.equal(cell.newtonConverged, true);
    } else if (cell.seedValue < 59.5) {
      assert.equal(cell.newtonConverged, false);
      assert.equal(cell.newtonReason, 'DOMAIN_ESCAPE');
    }
  }
});

test('Sweep across mu, T, and objectives (percentile & timeout probability) converges accurately', () => {
  const cases = [
    { mu: 40, T: 0.1 },
    { mu: 120, T: 0.025 },
    { mu: 250, T: 0.015 },
  ];
  for (const { mu, T } of cases) {
    const meanRes = solveThresholdComparison({
      modelType: 'MM1',
      params: { mu },
      objective: { type: 'MEAN_LATENCY', targetLatencyS: T },
      newtonSeed: mu - 1.4 / T,
      secantSeeds: [mu - 1.6 / T, mu - 1.2 / T],
    });
    assert.equal(meanRes.newton.converged, true);
    assert.ok(Math.abs((meanRes.newton.root ?? 0) - (mu - 1 / T)) < 1e-8);
    assert.equal(meanRes.secant.converged, true);
    assert.ok(Math.abs((meanRes.secant.root ?? 0) - (mu - 1 / T)) < 1e-8);

    const eps = 0.05;
    const toutT = 0.25;
    const expectedTout = mu + Math.log(eps) / toutT;
    const toutRes = solveThresholdComparison({
      modelType: 'MM1',
      params: { mu },
      objective: { type: 'TIMEOUT_PROBABILITY', targetLatencyS: toutT, timeoutEpsilon: eps },
    });
    assert.equal(toutRes.newton.converged, true);
    assert.ok(Math.abs((toutRes.newton.root ?? 0) - expectedTout) < 1e-7);
    assert.equal(toutRes.secant.converged, true);
    assert.ok(Math.abs((toutRes.secant.root ?? 0) - expectedTout) < 1e-7);
  }
});

test('Solver edge cases report explicit failure reasons without silent clamping', () => {
  // ZERO_DERIVATIVE in Newton
  const zeroDf = newtonRaphson((x) => x * x - 1, () => 0, 0.5, [0, 5]);
  assert.equal(zeroDf.converged, false);
  assert.equal(zeroDf.failureReason, 'ZERO_DERIVATIVE');

  // ZERO_DENOMINATOR in Secant
  const zeroDenom = secantMethod(() => 5, 1, 2, [0, 10]);
  assert.equal(zeroDenom.converged, false);
  assert.equal(zeroDenom.failureReason, 'ZERO_DENOMINATOR');

  // INVALID_SEEDS in Secant (equal seeds)
  const eqSeeds = secantMethod((x) => x - 2, 1.5, 1.5, [0, 10]);
  assert.equal(eqSeeds.converged, false);
  assert.equal(eqSeeds.failureReason, 'INVALID_SEEDS');

  // NO_POSITIVE_ROOT when T <= 1/mu
  const noRoot = solveThresholdComparison({
    modelType: 'MM1',
    params: { mu: 100 },
    objective: { type: 'MEAN_LATENCY', targetLatencyS: 0.005 }, // 1/mu = 0.01 >= 0.005
  });
  assert.equal(noRoot.newton.converged, false);
  assert.equal(noRoot.newton.failureReason, 'NO_POSITIVE_ROOT');

  // Newton with finite differences on M/M/c accounts for dfEvals=0 and extra fEvals
  const mmcRes = solveThresholdComparison({
    modelType: 'MMC',
    params: { mu: 50, c: 2 },
    objective: { type: 'MEAN_LATENCY', targetLatencyS: 0.05 },
  });
  assert.equal(mmcRes.newton.usedFiniteDifference, true);
  assert.equal(mmcRes.newton.dfEvals, 0);
  assert.ok(mmcRes.newton.fEvals > mmcRes.newton.iterations.length);
  assert.equal(mmcRes.secant.converged, true);
  assert.ok(Math.abs((mmcRes.newton.root ?? 0) - (mmcRes.secant.root ?? 0)) < 1e-6);

  // Bisection baseline also converges
  const bisRes = bisectionMethod((x) => 1 / (100 - x) - 0.05, 10, 95, [0, 100]);
  assert.equal(bisRes.converged, true);
  assert.ok(Math.abs((bisRes.root ?? 0) - 80) < 1e-7);
});

test('Robust fitting, extrapolation detection, and preventive alert rules', () => {
  // Synthetic observations around true mu=120 with one outlier
  const windows = [10, 25, 40, 55, 70, 85].map((lam, i) => ({
    ts: new Date(1700000000000 + i * 5000).toISOString(),
    lambdaObs: lam,
    wMean: i === 2 ? 0.08 : 1 / (120 - lam), // outlier at i=2
    wP50: (1 / (120 - lam)) * 0.693,
    wP95: (1 / (120 - lam)) * 2.995,
    wP99: (1 / (120 - lam)) * 4.605,
    errorRate: 0,
  }));

  const fit = fitRobustMM1(windows);
  assert.ok(Math.abs(fit.muEstimated - 120) / 120 < 0.05, `Estimated mu=${fit.muEstimated} too far from 120`);
  assert.ok(fit.muCiLow <= fit.muEstimated && fit.muCiHigh >= fit.muEstimated);

  // If lambda* = 100 > maxObservedLambda = 85, extrapolated MUST be true
  const pred = predictWithConfidence({
    modelType: 'MM1',
    params: { mu: fit.muEstimated },
    objective: { type: 'MEAN_LATENCY', targetLatencyS: 0.05 }, // root ~ 100 > 85
    muCiLow: fit.muCiLow,
    muCiHigh: fit.muCiHigh,
    maxObservedLambda: fit.maxObservedLambda,
    rSquared: fit.rSquared,
    sampleCount: windows.length,
  });
  assert.equal(pred.extrapolated, true);
  assert.ok(pred.extrapolationWarning?.includes('EXTRAPOLACIÓN'));

  const alerts = evaluatePreventiveAlerts({
    currentLambda: 90,
    muTotal: 100,
    lambdaStar: 80,
    lambdaTrendPerMin: 5,
  });
  assert.ok(alerts.some((a) => a.severity === 'CRITICAL'));
});
