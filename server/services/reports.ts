import PDFDocument from 'pdfkit';
import type { UmbralDatabase } from '../db/database';

export interface ExperimentDetailPayload {
  experiment: {
    id: string;
    targetId: string;
    targetName: string;
    targetUrl: string;
    environment: string;
    sourceId: string | null;
    sourceKind: string;
    objective: string;
    model: string;
    params: Record<string, unknown>;
    status: string;
    createdBy: string;
    createdAt: string;
  };
  measurements: Array<{
    ts: string;
    windowS: number;
    lambdaObs: number;
    wMean: number;
    wP50: number;
    wP95: number;
    wP99: number;
    errorRate: number;
    provenance: string;
  }>;
  solverRuns: Array<{
    id: string;
    method: string;
    seeds: number[];
    tol: number;
    converged: boolean;
    root: number | null;
    failureReason: string;
    failureMessage: string | null;
    stoppingCriterion: string;
    fEvals: number;
    dfEvals: number;
    elapsedNs: number;
    estimatedOrder: number | null;
    efficiencyIndex: number | null;
    usedFiniteDifference: boolean;
    absError: number | null;
    relError: number | null;
    iterations: Array<{
      n: number;
      x: number;
      fx: number;
      dfx: number | null;
      step: number | null;
      errAbs: number | null;
      errTrue: number | null;
    }>;
  }>;
  prediction: {
    lambdaStar: number | null;
    ciLow: number | null;
    ciHigh: number | null;
    confidenceLevel: string;
    extrapolated: boolean;
    extrapolationWarning: string | null;
    provenance: string;
  } | null;
  alerts: Array<{
    id: string;
    severity: string;
    rule: string;
    message: string;
    ts: string;
  }>;
}

export function getExperimentDetail(db: UmbralDatabase, experimentId: string): ExperimentDetailPayload | null {
  const expRow = db.db
    .prepare(
      `SELECT e.*, t.name as target_name, t.base_url as target_url, t.environment as target_env, ds.kind as source_kind
       FROM experiments e
       JOIN targets t ON t.id = e.target_id
       LEFT JOIN data_sources ds ON ds.id = e.source_id
       WHERE e.id = ?`,
    )
    .get(experimentId) as Record<string, unknown> | undefined;

  if (!expRow) return null;

  const measurements = expRow.source_id
    ? (db.db
        .prepare('SELECT * FROM measurements WHERE source_id = ? ORDER BY ts ASC')
        .all(String(expRow.source_id)) as Array<Record<string, unknown>>)
    : [];

  const runRows = db.db
    .prepare('SELECT * FROM solver_runs WHERE experiment_id = ? ORDER BY rowid ASC')
    .all(experimentId) as Array<Record<string, unknown>>;

  const solverRuns = runRows.map((r) => {
    const iters = db.db
      .prepare('SELECT * FROM solver_iterations WHERE run_id = ? ORDER BY n ASC')
      .all(String(r.id)) as Array<Record<string, unknown>>;
    return {
      id: String(r.id),
      method: String(r.method),
      seeds: JSON.parse(String(r.seeds_json)) as number[],
      tol: Number(r.tol),
      converged: Boolean(r.converged),
      root: r.root !== null ? Number(r.root) : null,
      failureReason: String(r.failure_reason),
      failureMessage: r.failure_message ? String(r.failure_message) : null,
      stoppingCriterion: String(r.stopping_criterion),
      fEvals: Number(r.f_evals),
      dfEvals: Number(r.df_evals),
      elapsedNs: Number(r.elapsed_ns),
      estimatedOrder: r.estimated_order !== null ? Number(r.estimated_order) : null,
      efficiencyIndex: r.efficiency_index !== null ? Number(r.efficiency_index) : null,
      usedFiniteDifference: Boolean(r.used_finite_difference),
      absError: r.abs_error !== null ? Number(r.abs_error) : null,
      relError: r.rel_error !== null ? Number(r.rel_error) : null,
      iterations: iters.map((it) => ({
        n: Number(it.n),
        x: Number(it.x),
        fx: Number(it.fx),
        dfx: it.dfx !== null ? Number(it.dfx) : null,
        step: it.step !== null ? Number(it.step) : null,
        errAbs: it.err_abs !== null ? Number(it.err_abs) : null,
        errTrue: it.err_true !== null ? Number(it.err_true) : null,
      })),
    };
  });

  const predRow = db.db
    .prepare('SELECT * FROM predictions WHERE experiment_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(experimentId) as Record<string, unknown> | undefined;

  const alertRows = db.db
    .prepare('SELECT * FROM alerts WHERE experiment_id = ? ORDER BY ts DESC')
    .all(experimentId) as Array<Record<string, unknown>>;

  return {
    experiment: {
      id: String(expRow.id),
      targetId: String(expRow.target_id),
      targetName: String(expRow.target_name),
      targetUrl: String(expRow.target_url),
      environment: String(expRow.target_env),
      sourceId: expRow.source_id ? String(expRow.source_id) : null,
      sourceKind: expRow.source_kind ? String(expRow.source_kind) : 'THEORETICAL',
      objective: String(expRow.objective),
      model: String(expRow.model),
      params: JSON.parse(String(expRow.params_json)) as Record<string, unknown>,
      status: String(expRow.status),
      createdBy: String(expRow.created_by),
      createdAt: String(expRow.created_at),
    },
    measurements: measurements.map((m) => ({
      ts: String(m.ts),
      windowS: Number(m.window_s),
      lambdaObs: Number(m.lambda_obs),
      wMean: Number(m.w_mean),
      wP50: Number(m.w_p50),
      wP95: Number(m.w_p95),
      wP99: Number(m.w_p99),
      errorRate: Number(m.error_rate),
      provenance: String(m.provenance),
    })),
    solverRuns,
    prediction: predRow
      ? {
          lambdaStar: predRow.lambda_star !== null ? Number(predRow.lambda_star) : null,
          ciLow: predRow.ci_low !== null ? Number(predRow.ci_low) : null,
          ciHigh: predRow.ci_high !== null ? Number(predRow.ci_high) : null,
          confidenceLevel: String(predRow.confidence_level),
          extrapolated: Boolean(predRow.extrapolated),
          extrapolationWarning: predRow.extrapolation_warning ? String(predRow.extrapolation_warning) : null,
          provenance: String(predRow.provenance),
        }
      : null,
    alerts: alertRows.map((a) => ({
      id: String(a.id),
      severity: String(a.severity),
      rule: String(a.rule),
      message: String(a.message),
      ts: String(a.ts),
    })),
  };
}

export function generateCsvReport(detail: ExperimentDetailPayload): string {
  const lines: string[] = [];
  lines.push('# UmbralSim — Reporte Técnico de Predicción de Umbrales');
  lines.push(`# Experimento,${detail.experiment.id}`);
  lines.push(`# Objetivo,${detail.experiment.targetName} (${detail.experiment.targetUrl})`);
  lines.push(`# Modelo,${detail.experiment.model},Objetivo,${detail.experiment.objective}`);
  if (detail.prediction) {
    lines.push(
      `# Predicción [PREDICTED],lambda*=${detail.prediction.lambdaStar ?? 'N/A'},IC_95=[${detail.prediction.ciLow ?? 'N/A'};${detail.prediction.ciHigh ?? 'N/A'}],Confianza=${detail.prediction.confidenceLevel},Extrapolado=${detail.prediction.extrapolated}`,
    );
  }
  lines.push('');
  lines.push('SECCION,METODO_O_TS,PROVENANCE,CONVERGIDO_O_LAMBDA,RAIZ_O_W_MEAN,P95_S,ERROR_RATE,EVALS_F,EVALS_DF,ORDEN,TIEMPO_NS');

  for (const run of detail.solverRuns) {
    lines.push(
      [
        'SOLVER',
        run.method,
        'PREDICTED',
        run.converged ? 'SI' : `NO (${run.failureReason})`,
        run.root ?? '',
        '',
        run.absError ?? '',
        run.fEvals,
        run.dfEvals,
        run.estimatedOrder ?? '',
        run.elapsedNs,
      ].join(','),
    );
  }

  for (const m of detail.measurements) {
    lines.push(
      [
        'MEDICION',
        m.ts,
        m.provenance,
        m.lambdaObs,
        m.wMean,
        m.wP95,
        m.errorRate,
        '',
        '',
        '',
        '',
      ].join(','),
    );
  }

  return lines.join('\n');
}

export async function generatePdfReportBuffer(detail: ExperimentDetailPayload): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).font('Helvetica-Bold').text('UmbralSim — Informe Técnico de Umbral Crítico');
    doc.moveDown(0.3);
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#475569')
      .text(`Uso exclusivo sobre infraestructuras autorizadas · ID Experimento: ${detail.experiment.id}`);
    doc.text(`Generado: ${new Date().toISOString()} · Fuente de datos: ${detail.experiment.sourceKind}`);
    doc.moveDown(1);

    doc.fillColor('#0F172A').fontSize(12).font('Helvetica-Bold').text('1. Perfil del Objetivo y Configuración');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Infraestructura: ${detail.experiment.targetName} (${detail.experiment.environment})`);
    doc.text(`URL / Host: ${detail.experiment.targetUrl}`);
    doc.text(`Modelo de Cola: ${detail.experiment.model} · Función Objetivo: ${detail.experiment.objective}`);
    doc.text(`Parámetros: ${JSON.stringify(detail.experiment.params.params ?? detail.experiment.params)}`);
    doc.moveDown(0.8);

    doc.fontSize(12).font('Helvetica-Bold').text('2. Predicción de Tasa Crítica λ* [PREDICHO]');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');
    if (detail.prediction) {
      doc.text(
        `λ* estimada: ${detail.prediction.lambdaStar !== null ? `${detail.prediction.lambdaStar.toFixed(4)} req/s` : 'Sin raíz positiva'}`,
      );
      doc.text(
        `Intervalo de Confianza (Bootstrap 95%): [${detail.prediction.ciLow?.toFixed(4) ?? '—'}, ${detail.prediction.ciHigh?.toFixed(4) ?? '—'}] req/s`,
      );
      doc.text(`Nivel de confianza: ${detail.prediction.confidenceLevel}`);
      if (detail.prediction.extrapolated && detail.prediction.extrapolationWarning) {
        doc.fillColor('#B45309').text(`AVISO: ${detail.prediction.extrapolationWarning}`);
        doc.fillColor('#0F172A');
      }
    }
    doc.moveDown(0.8);

    doc.fontSize(12).font('Helvetica-Bold').text('3. Comparación Numérica: Newton-Raphson vs. Secante');
    doc.moveDown(0.3);
    doc.fontSize(9).font('Courier');
    for (const run of detail.solverRuns) {
      doc.text(
        `${run.method.padEnd(10)} | Conv=${run.converged ? 'SI' : 'NO'} | λ*=${run.root?.toFixed(6) ?? run.failureReason} | Iter=${run.iterations.length} | f=${run.fEvals} | f'=${run.dfEvals} | p=${run.estimatedOrder ?? '—'} | ${run.elapsedNs} ns`,
      );
    }
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').fontSize(12).text('4. Alertas Preventivas y Resumen de Ventanas');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    if (detail.alerts.length === 0) {
      doc.text('Sin alertas activas para el régimen evaluado.');
    } else {
      for (const a of detail.alerts) {
        doc.text(`[${a.severity}] (${a.rule}): ${a.message}`);
      }
    }
    doc.moveDown(0.5);
    doc.fontSize(9).text(`Total de ventanas observadas/simuladas: ${detail.measurements.length}`);
    for (const m of detail.measurements.slice(0, 12)) {
      doc.text(
        `  [${m.provenance}] ${m.ts} -> λ=${m.lambdaObs.toFixed(2)} req/s | W_mean=${(m.wMean * 1000).toFixed(2)} ms | p95=${(m.wP95 * 1000).toFixed(2)} ms | err=${(m.errorRate * 100).toFixed(2)}%`,
      );
    }

    doc.moveDown(1);
    doc
      .fontSize(8)
      .fillColor('#64748B')
      .text(
        'Nota metodológica: Un sondeo de ≤5 req/s no identifica μ en producción por sí solo; μ requiere logs con carga variada, métricas Prometheus o perfil declarado (μ = c/S).',
      );
    doc.end();
  });
}
