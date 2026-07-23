// drl-example-dashboard — the local-friendly UI Worker.
//
// Its only job is serving the dashboard page and proxying the page's polls and
// commands to the four DEPLOYED Workers. It holds NO state of its own.
//
// All four connections are service bindings with "remote": true, so the SAME
// code runs under `wrangler dev` (the bindings resolve to the deployed Workers)
// and would run deployed too. This is why Workers 1–4 are always deployed: it
// removes every local-Durable-Object problem, and this page can be iterated on
// locally against real state. Run it with:  cd example/dashboard && npx wrangler dev
//
// When fetching through a binding the hostname is a DUMMY (https://internal/...):
// the binding, not the hostname, decides where the request goes. Only the path
// and query matter.
//
// Server routes:
//   GET  /                 the page
//   GET  /poll             ONE aggregated poll — fans out to all four Workers
//   POST /limiter/configure  { limitPerWindow, windowInMs, concurrency }
//   POST /upstream/configure { limitPerWindow?, windowSeconds?, processingMs? }
//   POST /upstream/reset
//   POST /trigger/alpha?n=  /  POST /trigger/bravo?n=
//   POST /reset/alpha       /  POST /reset/bravo
import type { LimiterConfig, LimiterStats } from '../../../dist/do.js';

import {
  BUCKET_NAME,
  type RateLimitResponse,
  type StatusSnapshot,
} from '../../shared/protocol.js';
import { DASHBOARD_HTML } from './dashboard.js';

/** The demo's default retry, restated when the current one cannot be read. */
const DEMO_RETRY = { maxRetries: 3, maxDelayInMs: 30_000 };

/**
 * A dummy origin for binding fetches. The binding decides the destination Worker;
 * the hostname is never resolved, so any absolute URL works — only path + query
 * are meaningful.
 */
const INTERNAL = 'https://internal';

/** The limiter's key-guarded route, with the key attached server-side. */
function limiterUrl(env: Env, route: string): string {
  const url = new URL(route, INTERNAL);
  url.searchParams.set('key', env.DRL_CONFIG_KEY ?? '');
  return url.toString();
}

/**
 * Run one poll leg, turning any failure into a per-section `{ error }` so a
 * single dead Worker degrades one panel rather than breaking the whole page.
 */
async function section<T>(
  fn: () => Promise<T>
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read one app's live request-state snapshot over its service binding. */
async function appStatus(svc: Fetcher): Promise<StatusSnapshot> {
  const res = await svc.fetch(`${INTERNAL}/status`);
  if (!res.ok) throw new Error(`/status -> ${String(res.status)}`);
  return res.json<StatusSnapshot>();
}

/** Read the shared bucket's stats, one of the record the limiter returns. */
async function limiterStats(env: Env): Promise<LimiterStats> {
  const res = await env.LIMITER_SVC.fetch(limiterUrl(env, '/stats'));
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? '/stats -> 401 (is DRL_CONFIG_KEY set in .dev.vars?)'
        : `/stats -> ${String(res.status)}`
    );
  }
  const all = await res.json<Record<string, LimiterStats>>();
  const stats = all[BUCKET_NAME];
  if (stats === undefined) {
    throw new Error(`bucket "${BUCKET_NAME}" is not configured`);
  }
  return stats;
}

/** The one blob the page polls. Every leg runs in parallel; each fails alone. */
interface PollResult {
  limiter: LimiterStats | { error: string };
  upstream: RateLimitResponse | { error: string };
  alpha: StatusSnapshot | { error: string };
  bravo: StatusSnapshot | { error: string };
}

async function poll(env: Env): Promise<PollResult> {
  const [limiter, upstream, alpha, bravo] = await Promise.all([
    section(() => limiterStats(env)),
    section(async () => {
      const res = await env.UPSTREAM_SVC.fetch(`${INTERNAL}/rate-limit`);
      if (!res.ok) throw new Error(`/rate-limit -> ${String(res.status)}`);
      return res.json<RateLimitResponse>();
    }),
    section(() => appStatus(env.ALPHA_SVC)),
    section(() => appStatus(env.BRAVO_SVC)),
  ]);
  return { limiter, upstream, alpha, bravo };
}

/**
 * Copy a proxied response back to the page, status and text intact. The body is
 * read as text and re-wrapped rather than the Response being passed through,
 * which avoids content-encoding passthrough surprises.
 */
async function relay(res: Response): Promise<Response> {
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'text/plain',
    },
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Rebuild the shared bucket from the form. configure is COMPLETE, never a patch,
 * so the retry currently in force is carried over (falling back to the demo
 * default) rather than dropped. Rebuilding rejects anyone queued — in the demo,
 * a feature you can watch.
 */
async function configureLimiter(request: Request, env: Env): Promise<Response> {
  const form = await request.json<{
    limitPerWindow: number;
    windowInMs: number;
    concurrency: number;
  }>();

  let retry: LimiterConfig['retry'] = DEMO_RETRY;
  try {
    retry = (await limiterStats(env)).config.retry ?? DEMO_RETRY;
  } catch {
    // Keep the demo default if the current config cannot be read.
  }

  const config: LimiterConfig = {
    bucket: {
      limitPerWindow: form.limitPerWindow,
      windowInMs: form.windowInMs,
    },
    concurrency: form.concurrency,
    retry,
  };

  const res = await env.LIMITER_SVC.fetch(limiterUrl(env, '/configure'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [BUCKET_NAME]: config }),
  });
  return relay(res);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === '/') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/poll') {
      return json(await poll(env));
    }

    if (url.pathname === '/limiter/configure' && method === 'POST') {
      return configureLimiter(request, env);
    }

    if (url.pathname === '/upstream/configure' && method === 'POST') {
      // The mock validates the fields itself; relay the body untouched.
      const res = await env.UPSTREAM_SVC.fetch(`${INTERNAL}/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: await request.text(),
      });
      return relay(res);
    }

    if (url.pathname === '/upstream/reset' && method === 'POST') {
      const res = await env.UPSTREAM_SVC.fetch(`${INTERNAL}/reset`, {
        method: 'POST',
      });
      return relay(res);
    }

    // Per-app trigger and reset. The URL names the app; the matching binding
    // carries the request to the deployed Worker.
    const appFor = (name: string): Fetcher | null =>
      name === 'alpha'
        ? env.ALPHA_SVC
        : name === 'bravo'
          ? env.BRAVO_SVC
          : null;

    if (url.pathname.startsWith('/trigger/') && method === 'POST') {
      const svc = appFor(url.pathname.slice('/trigger/'.length));
      if (svc === null) return json({ error: 'unknown app' }, 404);
      const n = url.searchParams.get('n') ?? '8';
      const res = await svc.fetch(
        `${INTERNAL}/burst?n=${encodeURIComponent(n)}`
      );
      return relay(res);
    }

    if (url.pathname.startsWith('/reset/') && method === 'POST') {
      const svc = appFor(url.pathname.slice('/reset/'.length));
      if (svc === null) return json({ error: 'unknown app' }, 404);
      const res = await svc.fetch(`${INTERNAL}/reset`, { method: 'POST' });
      return relay(res);
    }

    return new Response('not found', { status: 404 });
  },
};
