import { createHash } from 'node:crypto';

export interface AuditEntryInput {
  id: string;
  ts: string;
  actor: string;
  action: string;
  targetId: string | null;
  detailJson: string;
  prevHash: string;
}

export interface AuditEntryRecord extends AuditEntryInput {
  hash: string;
}

export const GENESIS_AUDIT_HASH = '0'.repeat(64);

/**
 * Calcula el hash SHA-256 encadenado de un registro de auditoría.
 */
export function computeAuditHash(entry: AuditEntryInput): string {
  const canonical = [
    entry.id,
    entry.ts,
    entry.actor,
    entry.action,
    entry.targetId ?? '',
    entry.detailJson,
    entry.prevHash,
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verifica la integridad completa de la cadena de hashes del log de auditoría.
 * Si algún registro fue alterado o reordenado, reporta el índice y el ID afectado.
 */
export function verifyAuditChain(entries: AuditEntryRecord[]): {
  valid: boolean;
  checkedCount: number;
  brokenAtIndex: number | null;
  brokenEntryId: string | null;
  reason: string | null;
} {
  let expectedPrev = GENESIS_AUDIT_HASH;
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    if (item.prevHash !== expectedPrev) {
      return {
        valid: false,
        checkedCount: i,
        brokenAtIndex: i,
        brokenEntryId: item.id,
        reason: `prevHash inconsistente en índice ${i}: esperado ${expectedPrev.slice(0, 12)}..., recibido ${item.prevHash.slice(0, 12)}...`,
      };
    }
    const recomputed = computeAuditHash({
      id: item.id,
      ts: item.ts,
      actor: item.actor,
      action: item.action,
      targetId: item.targetId,
      detailJson: item.detailJson,
      prevHash: item.prevHash,
    });
    if (recomputed !== item.hash) {
      return {
        valid: false,
        checkedCount: i,
        brokenAtIndex: i,
        brokenEntryId: item.id,
        reason: `Hash SHA-256 manipulado en registro ${item.id} (índice ${i}).`,
      };
    }
    expectedPrev = item.hash;
  }

  return {
    valid: true,
    checkedCount: entries.length,
    brokenAtIndex: null,
    brokenEntryId: null,
    reason: null,
  };
}
