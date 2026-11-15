import type { WindowedMeasurement } from '../math/fitting';
import type { Provenance } from '../math/types';

export interface ParsedLogRecord {
  tsMs: number;
  latencyS: number;
  status: number;
}

export interface LogParseSummary {
  formatDetected: 'NGINX_COMBINED' | 'JSONL' | 'CSV';
  totalLines: number;
  validLines: number;
  invalidLines: number;
  invalidSamples: Array<{ lineNumber: number; reason: string }>;
  windowS: number;
  windows: Array<WindowedMeasurement & { count: number; provenance: Provenance }>;
}

const NGINX_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function parseNginxDate(raw: string): number | null {
  // Format: 12/Nov/2026:15:00:01 +0000
  const m = raw.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = NGINX_MONTHS[m[2]];
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const min = Number(m[5]);
  const sec = Number(m[6]);
  if (month === undefined) return null;
  const tzSign = m[7][0] === '-' ? -1 : 1;
  const tzHours = Number(m[7].slice(1, 3));
  const tzMins = Number(m[7].slice(3, 5));
  const utc = Date.UTC(year, month, day, hour, min, sec) - tzSign * (tzHours * 60 + tzMins) * 60_000;
  return Number.isFinite(utc) ? utc : null;
}

function parseTimestampAny(raw: string | number): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return raw > 1e12 ? raw : raw * 1000;
  }
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return num > 1e12 ? num : num * 1000;
  }
  const nginx = parseNginxDate(trimmed);
  if (nginx !== null) return nginx;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLine(line: string): { record?: ParsedLogRecord; format?: 'NGINX_COMBINED' | 'JSONL' | 'CSV'; error?: string } {
  const trimmed = line.trim();
  if (!trimmed) return { error: 'Línea vacía' };

  // 1. JSON Lines
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const rawTs = obj.ts ?? obj.timestamp ?? obj.time;
      if (rawTs === undefined || (typeof rawTs !== 'string' && typeof rawTs !== 'number')) {
        return { error: 'JSON sin campo timestamp/ts válido' };
      }
      const tsMs = parseTimestampAny(rawTs);
      if (tsMs === null) return { error: 'Timestamp JSON no parseable' };

      let latencyS = Number.NaN;
      if (typeof obj.response_time_s === 'number') latencyS = obj.response_time_s;
      else if (typeof obj.request_time === 'number') latencyS = obj.request_time;
      else if (typeof obj.latency_s === 'number') latencyS = obj.latency_s;
      else if (typeof obj.latency_ms === 'number') latencyS = obj.latency_ms / 1000;
      else if (typeof obj.rt === 'number') latencyS = obj.rt;

      if (!Number.isFinite(latencyS) || latencyS <= 0 || latencyS > 3600) {
        return { error: 'Latencia JSON fuera de rango o ausente' };
      }
      const status = typeof obj.status === 'number' ? obj.status : 200;
      return { record: { tsMs, latencyS, status }, format: 'JSONL' };
    } catch {
      return { error: 'JSON malformado o truncado' };
    }
  }

  // 2. Nginx / Apache combinado extendido con request_time o rt=... al final
  const nginxMatch = trimmed.match(
    /\[([^\]]+)\]\s+"[A-Z]+\s+[^"]+"\s+(\d{3})\s+\d+(?:\s+"[^"]*"\s+"[^"]*")?(?:.*?\b(?:rt|request_time)=([0-9]+(?:\.[0-9]+)?)|\s+([0-9]+(?:\.[0-9]+)?))?/,
  );
  if (nginxMatch) {
    const tsMs = parseNginxDate(nginxMatch[1]);
    const status = Number(nginxMatch[2]);
    const rtRaw = nginxMatch[3] ?? nginxMatch[4];
    if (tsMs === null) return { error: 'Fecha Nginx inválida' };
    if (!rtRaw) return { error: 'Registro Nginx sin tiempo de respuesta (rt / request_time)' };
    const latencyS = Number(rtRaw);
    if (!Number.isFinite(latencyS) || latencyS <= 0 || latencyS > 3600) {
      return { error: 'Tiempo de respuesta Nginx inválido' };
    }
    return { record: { tsMs, latencyS, status }, format: 'NGINX_COMBINED' };
  }

  // 3. CSV: timestamp,latency_s[,status] (ignora cabecera)
  const parts = trimmed.split(',').map((p) => p.trim());
  if (parts.length >= 2) {
    if (/^(ts|timestamp|time|fecha)/i.test(parts[0])) {
      return { error: 'HEADER_SKIP' };
    }
    const tsMs = parseTimestampAny(parts[0]);
    const lat = Number(parts[1]);
    if (tsMs === null) return { error: 'Timestamp CSV inválido' };
    if (!Number.isFinite(lat) || lat <= 0 || lat > 3600) {
      return { error: 'Latencia CSV inválida o negativa' };
    }
    const status = parts[2] && /^\d{3}$/.test(parts[2]) ? Number(parts[2]) : 200;
    return { record: { tsMs, latencyS: lat, status }, format: 'CSV' };
  }

  return { error: 'Formato de línea no reconocido o truncado' };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Parser en streaming lógico por iterador de líneas para archivos de logs grandes.
 * Valida estrictamente cada línea, reporta inválidas y agrega por ventana temporal.
 */
export function parseLogsAndAggregate(
  rawText: string,
  windowS: number = 5,
): LogParseSummary {
  const safeWindowS = [1, 5, 60].includes(windowS) ? windowS : Math.max(1, Math.min(300, windowS));
  const lines = rawText.split(/\r?\n/);

  const buckets = new Map<
    number,
    { latencies: number[]; errors: number; total: number }
  >();

  let totalLines = 0;
  let validLines = 0;
  let invalidLines = 0;
  const invalidSamples: Array<{ lineNumber: number; reason: string }> = [];
  let formatDetected: 'NGINX_COMBINED' | 'JSONL' | 'CSV' = 'CSV';

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (!raw.trim()) continue;
    totalLines++;

    const parsed = parseLine(raw);
    if (parsed.error === 'HEADER_SKIP') {
      totalLines--;
      continue;
    }
    if (!parsed.record) {
      invalidLines++;
      if (invalidSamples.length < 15) {
        invalidSamples.push({ lineNumber: idx + 1, reason: parsed.error ?? 'Error de formato' });
      }
      continue;
    }

    validLines++;
    if (parsed.format) formatDetected = parsed.format;

    const bucketKey = Math.floor(parsed.record.tsMs / (safeWindowS * 1000)) * (safeWindowS * 1000);
    let b = buckets.get(bucketKey);
    if (!b) {
      b = { latencies: [], errors: 0, total: 0 };
      buckets.set(bucketKey, b);
    }
    b.total++;
    b.latencies.push(parsed.record.latencyS);
    if (parsed.record.status >= 500 || parsed.record.status === 429) {
      b.errors++;
    }
  }

  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  const windows = sortedKeys.map((k) => {
    const b = buckets.get(k)!;
    const sortedLat = [...b.latencies].sort((x, y) => x - y);
    const mean = sortedLat.reduce((acc, v) => acc + v, 0) / sortedLat.length;
    return {
      ts: new Date(k).toISOString(),
      lambdaObs: Number((b.total / safeWindowS).toFixed(4)),
      wMean: Number(mean.toFixed(6)),
      wP50: Number(quantile(sortedLat, 0.5).toFixed(6)),
      wP95: Number(quantile(sortedLat, 0.95).toFixed(6)),
      wP99: Number(quantile(sortedLat, 0.99).toFixed(6)),
      errorRate: Number((b.errors / b.total).toFixed(4)),
      count: b.total,
      provenance: 'MEASURED' as Provenance,
    };
  });

  return {
    formatDetected,
    totalLines,
    validLines,
    invalidLines,
    invalidSamples,
    windowS: safeWindowS,
    windows,
  };
}
