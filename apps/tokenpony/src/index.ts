import { Hono } from 'hono';
import { api } from './api';
import { tpx, discoveryDoc } from './tpx';
import { dashboard } from './dashboard';
import { billing } from './billing';
import { jsonError } from './util';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.log(JSON.stringify({ event: 'unhandled_error', path: c.req.path, error: String(err) }));
  return jsonError(500, 'internal_error', 'Something went wrong');
});

// CORS for the API + TPX endpoints so browser apps can call them directly.
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    });
  }
  await next();
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/v1') || path.startsWith('/tpx/token') || path === '/.well-known/tpx') {
    c.res.headers.set('access-control-allow-origin', '*');
  }
});

app.get('/', (c) => c.redirect('/dashboard'));
app.get('/.well-known/tpx', (c) => c.json(discoveryDoc(c.env.ISSUER)));
app.route('/v1', api);
app.route('/tpx', tpx);
app.route('/dashboard', dashboard);
app.route('/billing', billing);

app.notFound((c) => jsonError(404, 'not_found', `No route for ${c.req.method} ${c.req.path}`));

export default app;
