import dns from 'node:dns/promises';
import net from 'node:net';
import { SAFETY_LIMITS } from '../core/safetyLimits';

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface SsrfValidationResult {
  allowed: boolean;
  resolvedIps: string[];
  isPrivateOrLoopback: boolean;
  reason: string | null;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr4(ip: string, base: string, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

export function classifyIpAddress(rawIp: string): {
  isCloudMetadata: boolean;
  isLoopback: boolean;
  isPrivate: boolean;
  isDisallowedAlways: boolean;
} {
  const ip = rawIp.trim().toLowerCase();

  // IPv4 mapeada en IPv6 (::ffff:169.254.169.254)
  if (ip.startsWith('::ffff:')) {
    return classifyIpAddress(ip.slice(7));
  }

  if ((SAFETY_LIMITS.BLOCKED_METADATA_IPS as readonly string[]).includes(ip)) {
    return { isCloudMetadata: true, isLoopback: false, isPrivate: false, isDisallowedAlways: true };
  }

  if (net.isIPv4(ip)) {
    const isLinkLocal = inCidr4(ip, '169.254.0.0', 16);
    const isLoopback = inCidr4(ip, '127.0.0.0', 8);
    const isPrivate =
      inCidr4(ip, '10.0.0.0', 8) ||
      inCidr4(ip, '172.16.0.0', 12) ||
      inCidr4(ip, '192.168.0.0', 16) ||
      inCidr4(ip, '100.64.0.0', 10); // CGNAT
    const isUnspecified = inCidr4(ip, '0.0.0.0', 8);
    const isMulticast = inCidr4(ip, '224.0.0.0', 4);
    const isBroadcast = ip === '255.255.255.255';
    return {
      isCloudMetadata: isLinkLocal,
      isLoopback,
      isPrivate,
      isDisallowedAlways: isLinkLocal || isUnspecified || isMulticast || isBroadcast,
    };
  }

  if (net.isIPv6(ip)) {
    const isLoopback = ip === '::1';
    const isUnspecified = ip === '::';
    const isLinkLocal = ip.startsWith('fe80:') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
    const isPrivate = ip.startsWith('fc') || ip.startsWith('fd');
    const isMulticast = ip.startsWith('ff');
    return {
      isCloudMetadata: isLinkLocal || ip.startsWith('fd00:ec2::254'),
      isLoopback,
      isPrivate,
      isDisallowedAlways: isLinkLocal || isUnspecified || isMulticast,
    };
  }

  return { isCloudMetadata: false, isLoopback: false, isPrivate: false, isDisallowedAlways: true };
}

/**
 * Resuelve DNS y valida la IP antes de cualquier petición HTTP.
 * Bloquea metadatos cloud en todos los modos, y loopback/privadas salvo excepción autorizada explícita.
 */
export async function validateTargetUrlSsrf(
  rawUrl: string,
  options: {
    allowPrivateOrLoopback?: boolean;
    resolver?: DnsResolver;
    expectedHost?: string;
  } = {},
): Promise<SsrfValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, resolvedIps: [], isPrivateOrLoopback: false, reason: 'URL inválida.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      resolvedIps: [],
      isPrivateOrLoopback: false,
      reason: `Esquema '${parsed.protocol}' prohibido. Solo http/https.`,
    };
  }

  if (options.expectedHost && parsed.hostname.toLowerCase() !== options.expectedHost.toLowerCase()) {
    return {
      allowed: false,
      resolvedIps: [],
      isPrivateOrLoopback: false,
      reason: `Redirección entre hosts bloqueada (${options.expectedHost} -> ${parsed.hostname}).`,
    };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[] = [];

  if (net.isIP(host)) {
    addresses = [host];
  } else {
    const resolver = options.resolver ?? ((h: string) => dns.lookup(h, { all: true }));
    try {
      const records = await resolver(host);
      addresses = records.map((r) => r.address);
    } catch {
      return {
        allowed: false,
        resolvedIps: [],
        isPrivateOrLoopback: false,
        reason: `No se pudo resolver DNS para '${host}'.`,
      };
    }
  }

  if (addresses.length === 0) {
    return {
      allowed: false,
      resolvedIps: [],
      isPrivateOrLoopback: false,
      reason: `Sin registros IP para '${host}'.`,
    };
  }

  let anyPrivateOrLoopback = false;
  for (const ip of addresses) {
    const cls = classifyIpAddress(ip);
    if (cls.isCloudMetadata || cls.isDisallowedAlways) {
      return {
        allowed: false,
        resolvedIps: addresses,
        isPrivateOrLoopback: anyPrivateOrLoopback,
        reason: `IP bloqueada por protección SSRF (metadatos cloud / enlace local / reservada): ${ip}`,
      };
    }
    if (cls.isLoopback || cls.isPrivate) {
      anyPrivateOrLoopback = true;
      if (!options.allowPrivateOrLoopback) {
        return {
          allowed: false,
          resolvedIps: addresses,
          isPrivateOrLoopback: true,
          reason: `IP privada o loopback bloqueada fuera de autorización local/laboratorio: ${ip}`,
        };
      }
    }
  }

  return {
    allowed: true,
    resolvedIps: addresses,
    isPrivateOrLoopback: anyPrivateOrLoopback,
    reason: null,
  };
}
