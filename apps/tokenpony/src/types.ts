import type { SessionUser } from './auth';

/**
 * Tailnet identity, only on the self-hosted platform (proc-dev): a service
 * binding to the platform's `mf-tailnet` worker, declared in the `procdev`
 * wrangler environment and nowhere else. The platform's ingress proxy strips
 * Tailscale-* headers from any request that did not arrive through a tailscale
 * proxy pod, so what this returns is who is actually on the tailnet. On
 * Cloudflare the binding does not exist and the code path is off.
 */
export interface TailnetIdentity {
  login: string;
  name: string;
  profilePic: string | null;
  address: string | null;
}
export interface TailnetBinding {
  identity(request: Request): Promise<TailnetIdentity | null>;
}

/** Secrets are optional: billing and authz writes degrade gracefully until set. */
export type Bindings = Env & {
  TAILNET?: TailnetBinding;
  /** Comma-separated upstream-id prefixes this deployment serves (see models.ts catalog()). */
  MODEL_FILTER?: string;
  /** "off" keeps usage accounting but disables spend gates, debits, and Stripe (see billing.ts isMetered()). */
  METERING?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  AUTHGRAVITY_SERVICE_TOKEN?: string;
  // Wraps the AAuth Ed25519 signing key at rest. A fixed dev KEK is used when unset.
  AAUTH_KEK?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: SessionUser;
  };
};
