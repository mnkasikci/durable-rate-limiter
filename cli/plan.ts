/**
 * Everything `init` decides or writes, as pure functions.
 *
 * The interactive shell in `init.ts` does I/O and nothing else; every string
 * that reaches disk, and every rule about what is a legal answer, is here so it
 * can be tested without a terminal or a filesystem.
 */

export type Topology = 'direct' | 'service';
export type ConfigFormat = 'jsonc' | 'toml';

export interface BucketPlan {
  capacity: number;
  fillPerWindow: number;
  windowInMs: number;
}

/**
 * Size a bucket against an upstream limit.
 *
 * Worst-case throughput is `capacity + fillPerWindow`, not `fillPerWindow` — so
 * the two must sum to the upstream limit, never each equal it. The burst share
 * is a fifth, which reads as "pace at the limit, never more than a fifth of it
 * at once", and is clamped so that both knobs stay at least 1.
 */
export function sizeBucket(
  upstreamLimit: number,
  windowInMs: number
): BucketPlan {
  const capacity = Math.min(
    Math.max(Math.floor(upstreamLimit / 5), 1),
    upstreamLimit - 1
  );
  return { capacity, fillPerWindow: upstreamLimit - capacity, windowInMs };
}

export function isValidUpstreamLimit(raw: string): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 2;
}

export function isValidWindow(raw: string): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0;
}

export function isValidConcurrency(raw: string): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1;
}

/** Worker names are lowercase, digits and dashes, and cannot lead with a dash. */
export function isValidWorkerName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

/** A binding name is a key of `env`, so it has to be a JS identifier. */
export function isValidBindingName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/**
 * The instance name is `idFromName`'s argument. Anything non-empty works, and
 * that is the danger — a typo is a second bucket, not an error — so the only
 * rule enforced is that it is visible and unambiguous.
 */
export function isValidInstanceName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** `example-api` → `exampleApi`, so the generated export is usable as written. */
export function toIdentifier(instanceName: string): string {
  const camel = instanceName
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) =>
      c ? c.toUpperCase() : ''
    )
    .replace(/^[0-9]+/, '');
  return camel === ''
    ? 'limiter'
    : camel.charAt(0).toLowerCase() + camel.slice(1);
}

// --- generated files -------------------------------------------------------

/**
 * The limiter Worker.
 *
 * Without the config route it re-exports the package and nothing else. With
 * it, the Worker also applies the limits declared beside it in `limits.ts` —
 * which is the only way `configure` can be reached at all. It is a method on a
 * Durable Object, so something deployed has to call it; there is no `wrangler`
 * command that can.
 */
export function limiterWorkerSource(options: { configRoute: boolean }): string {
  const header = `// The limiter Worker. The object must live in a Worker of its own: a Worker
// implementing a Durable Object gets no preview URLs, and a new DO migration
// cannot be uploaded as a version.
export { LimiterDO, LimiterEntrypoint } from '@bakidev/durable-rate-limiter/do';
`;

  if (!options.configRoute) {
    return `${header}
// A Worker exporting a WorkerEntrypoint still needs its own default export.
export default {
  fetch: () => new Response('limiter ok'),
};
`;
  }

  return `${header}
// \`configure\` is a method on the Durable Object, so only a deployed Worker can
// reach it. This is that Worker. The limits themselves live in \`limits.ts\`, as
// code: they are reviewed in a diff, versioned with everything else, and
// applied by hitting /configure once after a deploy.
//
//   npx @bakidev/durable-rate-limiter configure
//
// Both routes are guarded by the DRL_CONFIG_KEY secret and deny everything when it
// is unset. Rotate it with:
//
//   npx wrangler secret put DRL_CONFIG_KEY
import type {
  LimiterRpc,
  LimiterStats,
} from '@bakidev/durable-rate-limiter/do';

import { LIMITS } from './limits.js';

interface LimiterWorkerEnv {
  RATE_LIMITER: DurableObjectNamespace;
  DRL_CONFIG_KEY?: string;
}

// A Worker exporting a WorkerEntrypoint still needs its own default export.
export default {
  async fetch(request: Request, env: LimiterWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const configuring = url.pathname === '/configure';

    if (!configuring && url.pathname !== '/stats') {
      return new Response('limiter ok');
    }

    if (!authorized(url.searchParams.get('key'), env.DRL_CONFIG_KEY)) {
      return new Response('unauthorized', { status: 401 });
    }

    const result: Record<string, LimiterStats> = {};

    for (const [name, config] of Object.entries(LIMITS)) {
      const stub = stubFor(env, name);
      // \`configure\` is a setup call: it rebuilds the bucket and rejects anyone
      // currently queued, which is the honest signal that their wait will never
      // be satisfied under the limits they were waiting on. Do not call it on a
      // request path.
      if (configuring) await stub.configure(config);
      result[name] = await stub.stats();
    }

    return Response.json(result);
  },
};

function stubFor(env: LimiterWorkerEnv, name: string): LimiterRpc {
  // RPC erases generics: an undeclared stub has methods typed \`never\`, \`never\`
  // is assignable to everything, and a wrong call would still compile.
  return env.RATE_LIMITER.get(
    env.RATE_LIMITER.idFromName(name)
  ) as unknown as LimiterRpc;
}

/**
 * Constant-time comparison, and \`false\` whenever the secret is unset — an
 * unset secret must mean "denied", never "open to everyone".
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
`;
}

/**
 * The limits, as code. One entry per upstream limit — the buckets are
 * independent, so this is where the second and third ones go.
 */
export function limitsModuleSource(
  entries: { name: string; bucket: BucketPlan; concurrency: number }[]
): string {
  const body = entries
    .map(
      (entry) => `  '${entry.name}': {
    bucket: {
      capacity: ${String(entry.bucket.capacity)},
      fillPerWindow: ${String(entry.bucket.fillPerWindow)},
      windowInMs: ${String(entry.bucket.windowInMs)},
    },
    concurrency: ${String(entry.concurrency)},
    retry: { maxRetries: 3, maxDelayInMs: 30_000 },
  },`
    )
    .join('\n');

  return `// The limits for every named bucket, applied by /configure in index.ts.
//
// Worst-case throughput is capacity + fillPerWindow — NOT fillPerWindow. A full
// bucket drains instantly and then refills over the same window, so to stay
// under an upstream limit L, size these so that capacity + fillPerWindow <= L.
//
// One entry per upstream limit. Two endpoints with different quotas are two
// entries; endpoints sharing a quota share one.
//
// Edit, redeploy, then run \`npx @bakidev/durable-rate-limiter configure\`.
import type { LimiterConfig } from '@bakidev/durable-rate-limiter/do';

export const LIMITS: Record<string, Partial<LimiterConfig>> = {
${body}
};
`;
}

export function limiterWranglerConfig(options: {
  workerName: string;
  compatibilityDate: string;
}): string {
  return `{
  "name": "${options.workerName}",
  "main": "src/index.ts",
  "compatibility_date": "${options.compatibilityDate}",
  "durable_objects": {
    "bindings": [{ "name": "RATE_LIMITER", "class_name": "LimiterDO" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["LimiterDO"] }],
}
`;
}

/**
 * The block a consumer's config needs — the one step `init` cannot do blind,
 * because it names a Worker that must already be deployed.
 *
 * Deliberately no `migrations` entry on the direct topology: the consumer
 * *binds* the class, it does not *implement* it, which is also what keeps its
 * preview URLs.
 */
export function bindingFragment(options: {
  topology: Topology;
  format: ConfigFormat;
  bindingName: string;
  workerName: string;
}): string {
  const { topology, format, bindingName, workerName } = options;

  if (format === 'toml') {
    return topology === 'direct'
      ? `# Binds the limiter class cross-script. No [[migrations]] entry belongs
# here: this Worker binds the class, it does not implement it.
[[durable_objects.bindings]]
name = "${bindingName}"
class_name = "LimiterDO"
script_name = "${workerName}"
`
      : `# "entrypoint" is required: a service binding without it resolves to the
# default export, and the entrypoint is a NAMED export.
[[services]]
binding = "${bindingName}"
service = "${workerName}"
entrypoint = "LimiterEntrypoint"
`;
  }

  return topology === 'direct'
    ? `  // Binds the limiter class cross-script. No "migrations" entry belongs
  // here: this Worker binds the class, it does not implement it.
  "durable_objects": {
    "bindings": [
      {
        "name": "${bindingName}",
        "class_name": "LimiterDO",
        "script_name": "${workerName}",
      },
    ],
  },
`
    : `  // "entrypoint" is required: a service binding without it resolves to the
  // default export, and the entrypoint is a NAMED export.
  "services": [
    {
      "binding": "${bindingName}",
      "service": "${workerName}",
      "entrypoint": "LimiterEntrypoint",
    },
  ],
`;
}

export function limiterModuleSource(options: {
  topology: Topology;
  bindingName: string;
  instanceName: string;
}): string {
  const { topology, bindingName, instanceName } = options;
  const ident = toIdentifier(instanceName);

  if (topology === 'direct') {
    return `// Generated by \`durable-rate-limiter init\`.
//
// Define at module scope. Bind and call anywhere you have \`env\`:
// \`defineBinder\` and \`defineLimiter\` do no I/O and start no timers, so this
// module is safe to evaluate at startup. \`env\` does not exist here.
import {
  defineBinder,
  defineLimiter,
} from '@bakidev/durable-rate-limiter/client';

// WHICH binding — checked against your generated \`Env\`. Run \`wrangler types\`.
const binder = defineBinder('${bindingName}');

// WHICH bucket. This name is \`idFromName\`'s argument, and a typo does not
// error — it silently creates a second bucket pacing at the full rate against
// the same upstream quota. It is written here, exactly once, for that reason.
export const ${ident} = defineLimiter({ binder, name: '${instanceName}' });

// One limiter per upstream LIMIT, not per application. Endpoints with
// different quotas need different buckets — same binder, another name:
//
//   export const searchApi = defineLimiter({ binder, name: 'search-api' });
//
// Endpoints sharing one quota share one limiter, which is the whole point.

// Usage — anywhere \`env\` exists: a fetch or scheduled handler, a queue
// consumer, a Workflow step, a Durable Object method. Not at module scope,
// which is the one place \`env\` does not exist.
//
//   const limiter = ${ident}.for(env);
//   const file = await limiter.call(() => fetch(url, { headers }), {
//     read: (res) => res.json<{ id: string }>(),
//   });
`;
  }

  return `// Generated by \`durable-rate-limiter init\`.
//
// The service-binding topology. \`defineBinder\` only speaks Durable Object
// namespaces, which is correct — a service binding is not one — so the binder
// is built over the entrypoint with \`defineTestBinder\`, the package's named
// injection point. It is doing exactly what it says: supplying something
// namespace-shaped.
import {
  defineLimiter,
  defineTestBinder,
  type Binder,
  type BoundLimiter,
} from '@bakidev/durable-rate-limiter/client';
import type {
  CallReport,
  LimiterService,
} from '@bakidev/durable-rate-limiter/do';

// Type the binding as \`LimiterService\`: RPC erases generics silently, so a raw
// stub type at a call site typechecks a completely wrong call.
declare global {
  interface Env {
    ${bindingName}: LimiterService;
  }
}

export const LIMITER_NAME = '${instanceName}';

function binderFor(env: Env): Binder {
  return defineTestBinder<string>({
    idFromName: (name) => name,
    get: (name) => ({
      execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
        return env.${bindingName}.execute(name, fn);
      },
    }),
  });
}

// Built per request rather than at module scope, because the adapter needs
// \`env\`. Everything above it is still inert.
export function ${toIdentifier(instanceName)}For(env: Env): BoundLimiter {
  return defineLimiter({ binder: binderFor(env), name: LIMITER_NAME }).for(env);
}

// Usage — anywhere \`env\` exists: a fetch or scheduled handler, a queue
// consumer, a Workflow step, a Durable Object method. Not at module scope,
// which is the one place \`env\` does not exist.
//
//   const limiter = ${toIdentifier(instanceName)}For(env);
//   const file = await limiter.call(() => fetch(url, { headers }), {
//     read: (res) => res.json<{ id: string }>(),
//   });
`;
}

export function configureModuleSource(options: {
  topology: Topology;
  bindingName: string;
  instanceName: string;
  bucket: BucketPlan;
  concurrency: number;
}): string {
  const { topology, bindingName, instanceName, bucket } = options;
  const patch = `{
    bucket: {
      capacity: ${String(bucket.capacity)},
      fillPerWindow: ${String(bucket.fillPerWindow)},
      windowInMs: ${String(bucket.windowInMs)},
    },
    concurrency: ${String(options.concurrency)},
    retry: { maxRetries: 3, maxDelayInMs: 30_000 },
  }`;

  const header = `// Generated by \`durable-rate-limiter init\`.
//
// \`configure\` is a SETUP call, not a per-request one. It is persisted, and it
// rejects anyone currently queued — rebuilding the bucket is the honest signal
// that their wait will never be satisfied under the limits they were waiting
// on. Call this once: from a deploy script, an admin route, or a guarded
// first-run path.
//
// Worst case is capacity + fillPerWindow = ${String(bucket.capacity + bucket.fillPerWindow)} per ${String(bucket.windowInMs)} ms.
`;

  if (topology === 'direct') {
    return `${header}import type { LimiterRpc } from '@bakidev/durable-rate-limiter/do';

export async function configureLimiter(env: Env): Promise<void> {
  // \`LimiterRpc\` is the object's surface written out by hand, applied at the
  // one place the stub is obtained. Both halves of that matter: a cross-script
  // binding types as \`DurableObjectStub<undefined>\` because the class lives in
  // another Worker, and RPC erases generics anyway — so an undeclared stub has
  // methods typed \`never\`, \`never\` is assignable to everything, and a
  // completely wrong call still compiles.
  const namespace = env.${bindingName};
  const stub = namespace.get(
    namespace.idFromName('${instanceName}')
  ) as unknown as LimiterRpc;

  await stub.configure(${patch});

  console.log(await stub.stats());
}
`;
  }

  return `${header}
export async function configureLimiter(env: Env): Promise<void> {
  await env.${bindingName}.configure('${instanceName}', ${patch});

  console.log(await env.${bindingName}.stats('${instanceName}'));
}
`;
}

// --- editing the consumer's config -----------------------------------------

/**
 * Best-effort detection of an existing top-level key, used only to decide
 * between "insert it" and "print it for you to merge". Comment-blind and
 * nesting-blind on purpose: a false positive costs a paste, a false negative
 * would cost a clobbered binding, and the write is confirmed either way.
 */
export function hasTopLevelKey(source: string, key: string): boolean {
  const jsonc = new RegExp(`(^|[{,])\\s*"?${key}"?\\s*:`, 'm');
  const toml = new RegExp(`^\\s*\\[\\[?${key}[.\\]]`, 'm');
  return jsonc.test(source) || toml.test(source);
}

export type InsertResult =
  { ok: true; text: string } | { ok: false; reason: string };

/**
 * Splice a fragment into an existing config without touching a byte of what is
 * already there.
 *
 * JSONC goes in immediately after the opening brace, TOML on the end — both
 * positions are valid regardless of what surrounds them, which is what lets
 * this be a pure textual insertion. The config is never reserialised: a
 * round-trip through a JSON parser would silently delete every comment in a
 * file whose whole format exists to have them.
 */
export function insertFragment(
  source: string,
  fragment: string,
  format: ConfigFormat
): InsertResult {
  if (format === 'toml') {
    const separator = source.endsWith('\n\n')
      ? ''
      : source.endsWith('\n')
        ? '\n'
        : '\n\n';
    return { ok: true, text: `${source}${separator}${fragment}` };
  }

  const brace = source.indexOf('{');
  if (brace === -1) {
    return {
      ok: false,
      reason: 'no opening `{` found — is this a JSONC config?',
    };
  }

  const head = source.slice(0, brace + 1);
  const tail = source.slice(brace + 1);
  return { ok: true, text: `${head}\n${fragment}${tail.replace(/^\n/, '')}` };
}
