import { Hono } from 'hono';
import { api } from './api';
import { oauth, authorizationServerMetadata, protectedResourceMetadata } from './oauth';
import { dashboard } from './dashboard';
import { authPages } from './login';
import { billing } from './billing';
import { sweepExpired } from './sweeper';
import { aauth, aauthResourceMetadata } from './aauth/routes';
import { jsonError } from './util';
import type { AppEnv, Bindings } from './types';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.log(JSON.stringify({ event: 'unhandled_error', path: c.req.path, error: String(err) }));
  return jsonError(500, 'internal_error', 'Something went wrong');
});

// CORS for the API and OAuth endpoints so browser apps can call them directly.
const CORS_PATHS = /^\/(v1|models|chat|token|par|register|introspect|revoke|grant|fund|\.well-known)(\/|$)/;
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers':
        'authorization, content-type, dpop, signature, signature-input, signature-key, aauth-mission',
      'access-control-max-age': '86400',
    });
  }
  await next();
  if (CORS_PATHS.test(new URL(c.req.url).pathname)) {
    c.res.headers.set('access-control-allow-origin', '*');
    c.res.headers.set('access-control-expose-headers', 'www-authenticate, dpop-nonce, aauth-requirement');
  }
});

app.get('/', (c) => c.redirect('/dashboard'));
app.get('/llms.txt', (c) => c.redirect('https://tokenpony.dev/llms.txt', 302));
app.get('/.well-known/oauth-protected-resource', (c) =>
  c.json(protectedResourceMetadata(c.env.ISSUER)),
);
app.get('/.well-known/oauth-authorization-server', (c) =>
  c.json(authorizationServerMetadata(c.env.ISSUER)),
);
app.get('/.well-known/aauth-resource.json', async (c) =>
  c.json(await aauthResourceMetadata(c.env), 200, { 'cache-control': 'no-store' }),
);
// Spec Section 8.2: API endpoints are relative to the resource identifier.
// /v1 stays as the OpenAI-SDK-compatible alias.
app.route('/v1', api);
app.route('/', api);
app.route('/', oauth);
app.route('/', aauth);
app.route('/', authPages);
app.route('/dashboard', dashboard);
app.route('/billing', billing);

app.notFound((c) => jsonError(404, 'not_found', `No route for ${c.req.method} ${c.req.path}`));

export default {
  fetch: app.fetch,
  // Cron-triggered sweep of expired PAR requests, access tokens, spent auth
  // codes, and long-dead rotated refresh tokens.
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(sweepExpired(env));
  },
} satisfies ExportedHandler<Bindings>;
