import type { SessionUser } from './auth';

/** Secrets are optional: billing and authz writes degrade gracefully until set. */
export type Bindings = Env & {
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
