import type { SessionUser } from './auth';

/** Secrets are optional: billing degrades gracefully until they're set. */
export type Bindings = Env & {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: SessionUser;
  };
};
