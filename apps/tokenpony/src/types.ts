import type { SessionUser } from './auth';

/** Secrets are optional: billing and authz writes degrade gracefully until set. */
export type Bindings = Env & {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  AUTHGRAVITY_SERVICE_TOKEN?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: SessionUser;
  };
};
