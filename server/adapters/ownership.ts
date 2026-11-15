import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import { validateTargetUrlSsrf } from './ssrfGuard';

export type VerificationMethod = 'WELL_KNOWN' | 'DNS_TXT' | 'HEADER' | 'PRIVATE_AUTH_ONLY';

export interface AuthorizationRecord {
  id: string;
  targetId: string;
  method: VerificationMethod;
  tokenHash: string;
  verifiedAt: string | null;
  expiresAt: string;
  declaredBy: string;
  evidenceNote: string;
}

export function generateVerificationToken(): { rawToken: string; tokenHash: string } {
  const rawToken = `umbral-verify=${randomBytes(16).toString('hex')}`;
  const tokenHash = hashVerificationToken(rawToken);
  return { rawToken, tokenHash };
}

export function hashVerificationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken.trim(), 'utf8').digest('hex');
}

export interface AuthorizationCheckInput {
  targetUrl: string;
  explicitCheckboxChecked: boolean;
  authorization: AuthorizationRecord | null;
  now?: Date;
}

export interface AuthorizationCheckResult {
  authorized: boolean;
  isPrivateOrLoopback: boolean;
  reason: string | null;
}

/**
 * Verifica las 3 condiciones obligatorias de la Regla 3:
 * (a) casilla explícita, (b) registro vigente no expirado, (c) verificación de propiedad
 * (con excepción documentada de (c) para localhost/redes privadas).
 */
export async function checkProbeAuthorization(
  input: AuthorizationCheckInput,
): Promise<AuthorizationCheckResult> {
  if (!input.explicitCheckboxChecked) {
    return {
      authorized: false,
      isPrivateOrLoopback: false,
      reason: 'Debe marcar la casilla de autorización explícita antes de sondear.',
    };
  }

  const ssrf = await validateTargetUrlSsrf(input.targetUrl, { allowPrivateOrLoopback: true });
  if (!ssrf.allowed) {
    return {
      authorized: false,
      isPrivateOrLoopback: ssrf.isPrivateOrLoopback,
      reason: ssrf.reason ?? 'Destino bloqueado por protección SSRF.',
    };
  }

  if (!input.authorization) {
    return {
      authorized: false,
      isPrivateOrLoopback: ssrf.isPrivateOrLoopback,
      reason: 'No existe registro de autorización para este objetivo.',
    };
  }

  const now = input.now ?? new Date();
  const expiresMs = Date.parse(input.authorization.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
    return {
      authorized: false,
      isPrivateOrLoopback: ssrf.isPrivateOrLoopback,
      reason: `La autorización expiró el ${input.authorization.expiresAt}.`,
    };
  }

  // Sitios públicos exigen verificación de propiedad verificada (c)
  if (!ssrf.isPrivateOrLoopback) {
    if (input.authorization.method === 'PRIVATE_AUTH_ONLY' || !input.authorization.verifiedAt) {
      return {
        authorized: false,
        isPrivateOrLoopback: false,
        reason:
          'Los sitios públicos exigen verificación de propiedad completada (/.well-known/umbral-verify.txt, registro DNS TXT o cabecera X-UmbralSim-Verify).',
      };
    }
  }

  return {
    authorized: true,
    isPrivateOrLoopback: ssrf.isPrivateOrLoopback,
    reason: null,
  };
}

/**
 * Ejecuta la verificación activa del token de propiedad para un objetivo público o local.
 */
export async function verifyOwnershipRemote(input: {
  targetUrl: string;
  method: VerificationMethod;
  expectedTokenHash: string;
}): Promise<{ verified: boolean; detail: string }> {
  const ssrf = await validateTargetUrlSsrf(input.targetUrl, { allowPrivateOrLoopback: true });
  if (!ssrf.allowed) {
    return { verified: false, detail: ssrf.reason ?? 'Destino bloqueado por SSRF.' };
  }

  if (input.method === 'PRIVATE_AUTH_ONLY') {
    if (!ssrf.isPrivateOrLoopback) {
      return {
        verified: false,
        detail: 'La exención de verificación de propiedad solo aplica a localhost y redes privadas.',
      };
    }
    return {
      verified: true,
      detail: 'Objetivo en loopback/red privada verificado bajo declaración explícita.',
    };
  }

  const url = new URL(input.targetUrl);
  if (input.method === 'WELL_KNOWN') {
    const verifyUrl = `${url.origin}/.well-known/umbral-verify.txt`;
    const res = await fetch(verifyUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'UmbralSim/1.0 (+mailto:seguridad@umbralsim.local)' },
    });
    if (!res.ok) {
      return { verified: false, detail: `HTTP ${res.status} al consultar ${verifyUrl}` };
    }
    const body = (await res.text()).trim();
    if (hashVerificationToken(body) === input.expectedTokenHash || body.split(/\s+/).some((tok) => hashVerificationToken(tok) === input.expectedTokenHash)) {
      return { verified: true, detail: `Token verificado en ${verifyUrl}` };
    }
    return { verified: false, detail: `El archivo ${verifyUrl} no contiene el token esperado.` };
  }

  if (input.method === 'HEADER') {
    const res = await fetch(input.targetUrl, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'UmbralSim/1.0 (+mailto:seguridad@umbralsim.local)' },
    });
    const hdr = res.headers.get('x-umbralsim-verify')?.trim() ?? '';
    if (hdr && hashVerificationToken(hdr) === input.expectedTokenHash) {
      return { verified: true, detail: 'Cabecera X-UmbralSim-Verify verificada.' };
    }
    return { verified: false, detail: 'Cabecera X-UmbralSim-Verify ausente o no coincide.' };
  }

  // DNS_TXT
  try {
    const records = await dns.resolveTxt(`_umbralsim.${url.hostname}`);
    const flat = records.flat().map((s) => s.trim());
    if (flat.some((tok) => hashVerificationToken(tok) === input.expectedTokenHash)) {
      return { verified: true, detail: `Registro TXT _umbralsim.${url.hostname} verificado.` };
    }
    return { verified: false, detail: `Registro TXT en _umbralsim.${url.hostname} no coincide.` };
  } catch (err) {
    return {
      verified: false,
      detail: `No se pudo consultar TXT _umbralsim.${url.hostname}: ${(err as Error).message}`,
    };
  }
}
