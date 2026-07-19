import type { Bindings } from './types';

/**
 * Delete expired ephemeral OAuth rows. Runs on the cron trigger; all four
 * tables key off a stored expiry (or, for used auth codes, the code's own
 * short TTL), so nothing here touches a live grant.
 */
export async function sweepExpired(env: Bindings): Promise<Record<string, number>> {
  const stmts = {
    // PAR requests: one-shot, 90s (or 10min for the direct-authorize path).
    par_requests: env.DB.prepare("DELETE FROM par_requests WHERE expires_at <= datetime('now')"),
    // Access tokens: refreshed hourly, so expired ones are pure dead weight.
    access_tokens: env.DB.prepare("DELETE FROM access_tokens WHERE expires_at <= datetime('now')"),
    // Auth codes: single-use with a 5min TTL; keep an hour of slack for
    // audit, then drop both expired and already-exchanged codes.
    auth_codes: env.DB.prepare(
      "DELETE FROM auth_codes WHERE expires_at <= datetime('now', '-1 hour') OR (used = 1 AND expires_at <= datetime('now'))",
    ),
    // Rotated/revoked refresh tokens the reuse-detector no longer needs: a
    // week's retention keeps recent reuse observable, then they go.
    refresh_tokens: env.DB.prepare(
      "DELETE FROM refresh_tokens WHERE status != 'active' AND created_at <= datetime('now', '-7 days')",
    ),
    // AAuth ephemera (epoch-seconds expiries): RFC 9421 replay guard, single-use
    // attestation jtis, and expired budgeted auth tokens.
    aauth_replay: env.DB.prepare("DELETE FROM aauth_replay WHERE expires_at <= unixepoch('now')"),
    aauth_attestations: env.DB.prepare(
      "DELETE FROM aauth_attestations WHERE expires_at <= unixepoch('now')",
    ),
    aauth_tokens: env.DB.prepare("DELETE FROM aauth_tokens WHERE expires_at <= unixepoch('now')"),
  };
  const results = await env.DB.batch(Object.values(stmts));
  const swept: Record<string, number> = {};
  Object.keys(stmts).forEach((name, i) => {
    swept[name] = results[i].meta.changes ?? 0;
  });
  console.log(JSON.stringify({ event: 'sweep_expired', ...swept }));
  return swept;
}
