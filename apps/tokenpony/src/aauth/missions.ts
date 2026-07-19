import type { Bindings } from '../types';
import { creditsToAmount } from '../pricing';
import type { BudgetEntry, MissionRef } from './jws';

/**
 * Mission-keyed metering (seam contract section 6). The meter is keyed by the
 * mission ref (approver, s256), cumulative across every auth token under it. The
 * budget value binds on the first token (first-token-wins); spend is reserved
 * before inference and committed after.
 */

export interface MissionRow {
  id: string;
  approver: string;
  s256: string;
  budget_json: string;
  resource: string;
  currency: string;
  models: string | null;
  budget_total: number;
  budget_used: number;
  reserved: number;
  agent_iss: string;
  agent_sub: string;
  user_id: string | null;
  status: string;
}

export async function getMission(db: D1Database, ref: MissionRef): Promise<MissionRow | null> {
  return db
    .prepare('SELECT * FROM aauth_missions WHERE approver = ? AND s256 = ?')
    .bind(ref.approver, ref.s256)
    .first<MissionRow>();
}

/**
 * First token binds the mission's budget; later tokens must present a
 * byte-identical budget. Returns the (existing or newly created) mission row.
 */
export async function bindOrCheckBudget(
  db: D1Database,
  opts: {
    ref: MissionRef;
    budget: BudgetEntry;
    budgetTotal: number;
    agentIss: string;
    agentSub: string;
  },
): Promise<{ mission: MissionRow } | { error: string }> {
  const budgetJson = JSON.stringify(opts.budget);
  const existing = await getMission(db, opts.ref);
  if (existing) {
    if (existing.budget_json !== budgetJson) return { error: 'budget_mismatch' };
    return { mission: existing };
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO aauth_missions
         (id, approver, s256, budget_json, resource, currency, models, budget_total, agent_iss, agent_sub, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(approver, s256) DO NOTHING`,
    )
    .bind(
      id,
      opts.ref.approver,
      opts.ref.s256,
      budgetJson,
      opts.budget.resource,
      opts.budget.currency,
      opts.budget.models ? JSON.stringify(opts.budget.models) : null,
      opts.budgetTotal,
      opts.agentIss,
      opts.agentSub,
      Date.now(),
    )
    .run();
  // Re-read (handles a concurrent insert winning the race).
  const mission = await getMission(db, opts.ref);
  if (!mission) return { error: 'mission_insert_failed' };
  if (mission.budget_json !== budgetJson) return { error: 'budget_mismatch' };
  return { mission };
}

export type MissionGate =
  | { ok: true; mission: MissionRow }
  | { ok: false; code: 'mission_revoked' | 'mission_completed' | 'mission_expired' | 'not_found' };

export async function requireActiveMission(db: D1Database, ref: MissionRef): Promise<MissionGate> {
  const mission = await getMission(db, ref);
  if (!mission) return { ok: false, code: 'not_found' };
  if (mission.status === 'revoked') return { ok: false, code: 'mission_revoked' };
  if (mission.status === 'completed') return { ok: false, code: 'mission_completed' };
  return { ok: true, mission };
}

/**
 * Reserve credits against the mission cap. Atomic conditional UPDATE (the same
 * guard style as maybeAutoTopup): only succeeds if used + reserved + amount
 * stays within budget_total and the mission is active. Returns true on success.
 */
export async function reserve(db: D1Database, missionId: string, credits: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE aauth_missions SET reserved = reserved + ?
       WHERE id = ? AND status = 'active' AND budget_used + reserved + ? <= budget_total`,
    )
    .bind(credits, missionId, credits)
    .run();
  return res.meta.changes > 0;
}

/** Commit the actual charge and release the rest of a prior reservation. */
export async function commit(
  db: D1Database,
  missionId: string,
  reserved: number,
  actual: number,
): Promise<void> {
  const charge = Math.min(actual, reserved);
  await db
    .prepare(
      'UPDATE aauth_missions SET reserved = reserved - ?, budget_used = budget_used + ? WHERE id = ?',
    )
    .bind(reserved, charge, missionId)
    .run();
}

/** Release a reservation without charging (inference failed before any spend). */
export async function release(db: D1Database, missionId: string, reserved: number): Promise<void> {
  await db
    .prepare('UPDATE aauth_missions SET reserved = reserved - ? WHERE id = ?')
    .bind(reserved, missionId)
    .run();
}

/** AAuth budget-state shape for GET /grant (seam contract section 6). */
export function budgetState(mission: MissionRow) {
  return {
    active: mission.status === 'active',
    budget: { amount: creditsToAmount(mission.budget_total), currency: mission.currency },
    spent: { amount: creditsToAmount(mission.budget_used), currency: mission.currency },
    credits: mission.budget_total,
    credits_used: mission.budget_used,
  };
}

export function missionModels(mission: MissionRow): string[] | null {
  return mission.models ? (JSON.parse(mission.models) as string[]) : null;
}
