import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { WindowedMeasurement } from '../math/fitting';
import type { Provenance } from '../math/types';
import { validateTargetUrlSsrf } from './ssrfGuard';

// Clave efímera en memoria por proceso o derivada de variable de entorno opcional (nunca hardcoded)
const PROCESS_SECRET_KEY = createHash('sha256')
  .update(process.env.DATA_ENCRYPTION_KEY || randomBytes(32))
  .digest();

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', PROCESS_SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptToken(payload: string): string {
  const [ivB64, tagB64, encB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('Token cifrado inválido.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    PROCESS_SECRET_KEY,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8');
}

export interface PrometheusQueryInput {
  baseUrl: string;
  rateQuery: string; // ej. rate(http_requests_total[1m])
  latencyQuery: string; // ej. http_request_duration_seconds_sum / http_request_duration_seconds_count
  startIso: string;
  endIso: string;
  stepS: number;
  bearerToken?: string;
  allowPrivate?: boolean;
}

export async function fetchPrometheusRange(
  input: PrometheusQueryInput,
): Promise<{ windows: Array<WindowedMeasurement & { provenance: Provenance }> }> {
  const ssrf = await validateTargetUrlSsrf(input.baseUrl, {
    allowPrivateOrLoopback: input.allowPrivate ?? false,
  });
  if (!ssrf.allowed) {
    throw new Error(ssrf.reason ?? 'URL de Prometheus bloqueada por SSRF.');
  }

  const encrypted = input.bearerToken ? encryptToken(input.bearerToken) : null;
  const authHeader = encrypted ? `Bearer ${decryptToken(encrypted)}` : undefined;

  const queryOne = async (promql: string): Promise<Map<number, number>> => {
    const url = new URL('/api/v1/query_range', input.baseUrl);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', String(Math.floor(Date.parse(input.startIso) / 1000)));
    url.searchParams.set('end', String(Math.floor(Date.parse(input.endIso) / 1000)));
    url.searchParams.set('step', `${Math.max(1, Math.round(input.stepS))}s`);

    const res = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'UmbralSim/1.0 (+mailto:seguridad@umbralsim.local)',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Prometheus respondió HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      status: string;
      data?: { result?: Array<{ values?: Array<[number, string]> }> };
    };
    const map = new Map<number, number>();
    const values = json.data?.result?.[0]?.values ?? [];
    for (const [tsSec, valStr] of values) {
      const num = Number(valStr);
      if (Number.isFinite(num)) {
        map.set(tsSec, num);
      }
    }
    return map;
  };

  const [rateMap, latMap] = await Promise.all([
    queryOne(input.rateQuery),
    queryOne(input.latencyQuery),
  ]);

  const windows: Array<WindowedMeasurement & { provenance: Provenance }> = [];
  for (const [tsSec, lambdaObs] of Array.from(rateMap.entries()).sort((a, b) => a[0] - b[0])) {
    const wMean = latMap.get(tsSec);
    if (wMean !== undefined && wMean > 0 && lambdaObs >= 0) {
      windows.push({
        ts: new Date(tsSec * 1000).toISOString(),
        lambdaObs: Number(lambdaObs.toFixed(4)),
        wMean: Number(wMean.toFixed(6)),
        wP50: Number((wMean * 0.7).toFixed(6)),
        wP95: Number((wMean * 2.95).toFixed(6)),
        wP99: Number((wMean * 4.5).toFixed(6)),
        errorRate: 0,
        provenance: 'MEASURED',
      });
    }
  }

  return { windows };
}
