// The shared limiter Worker: drl-example-limiter. The object must live in a
// Worker of its own — a Worker implementing a Durable Object gets no preview
// URLs, and a new DO migration cannot be uploaded as a version.
//
// Imports come from `../../../dist`, not from `src/`, exactly as a published
// consumer would import them. `npm run build` at the repo root is step one.
export { LimiterDO, LimiterEntrypoint } from '../../../dist/do.js';

// `configure` is a method on the Durable Object, so only a deployed Worker can
// reach it. This is that Worker.
//
// NOTHING HERE HOLDS THE LIMITS. They are durable state inside the object; this
// Worker is only the door to them. The editable copy lives beside this file in
// `durable-rate-limiter.limits.jsonc`, is never deployed, and is uploaded by a
// POST to `/configure` (see example/README.md) — so changing a limit does not
// redeploy this Worker. Redeploy it only when THIS code changes: a package
// upgrade, an edit below.
//
// Both routes are guarded by the DRL_CONFIG_KEY secret and deny everything when
// it is unset. Set or rotate it with:
//
//   npx wrangler secret put DRL_CONFIG_KEY
import { REGISTRY_NAME } from '../../../dist/do.js';
import type {
  LimiterConfig,
  LimiterRpc,
  LimiterStats,
} from '../../../dist/do.js';

// A Worker exporting a WorkerEntrypoint still needs its own default export.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const configuring = url.pathname === '/configure';

    if (!configuring && url.pathname !== '/stats') {
      return new Response('drl-example-limiter ok');
    }

    if (!authorized(url.searchParams.get('key'), env.DRL_CONFIG_KEY)) {
      return new Response('unauthorized', { status: 401 });
    }

    // POST, and not merely by convention: a Worker deployed before the limits
    // moved out of the bundle answers GET /configure by applying its own
    // baked-in limits and returning 200. Refusing the method is what turns that
    // silent wrong answer into a visible one.
    if (configuring && request.method !== 'POST') {
      return new Response('POST required', { status: 405 });
    }

    const result: Record<string, LimiterStats> = {};

    if (configuring) {
      const limits = await request.json<Record<string, LimiterConfig>>();
      for (const [name, config] of Object.entries(limits)) {
        // `configure` rebuilds the bucket and rejects anyone currently queued,
        // which is the honest signal that their wait will never be satisfied
        // under the limits they were waiting on. Do not call it on a request
        // path. The config is complete, never a patch — there is no default to
        // merge a fragment onto.
        await stubFor(env, name).configure(name, config);
        result[name] = await stubFor(env, name).stats();
      }
      return Response.json(result);
    }

    // Every bucket, without being told which — a namespace cannot be listed and
    // `idFromName` does not run backwards, so the object keeps the list itself.
    const registry = stubFor(env, REGISTRY_NAME);

    for (const name of await registry.listNames()) {
      try {
        result[name] = await stubFor(env, name).stats();
      } catch {
        // A listed name with no bucket behind it: the surviving half of a
        // creation that failed after registering. Prune it while we are here —
        // repair-on-read fixes drift whatever caused it.
        await registry.unregisterName(name);
      }
    }

    return Response.json(result);
  },
};

function stubFor(env: Env, name: string): LimiterRpc {
  // The declared `LimiterRpc` return type is doing the work: the stub's generic
  // `execute` erases to `never` through RPC, and `never` is assignable to
  // everything, so widening the stub to the hand-written surface here is what
  // stops that `never` reaching a call site. No cast is needed precisely
  // because of that assignability — the namespace is typed to `LimiterDO`.
  return env.RATE_LIMITER.getByName(name);
}

/**
 * Constant-time comparison, and `false` whenever the secret is unset — an unset
 * secret must mean "denied", never "open to everyone".
 */
function authorized(provided: string | null, expected?: string): boolean {
  if (expected === undefined || expected === '' || provided === null) {
    return false;
  }
  if (provided.length !== expected.length) return false;

  let difference = 0;
  for (let index = 0; index < provided.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
