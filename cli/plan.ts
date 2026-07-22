/**
 * Everything `init` decides or writes, as pure functions.
 *
 * The interactive shell in `init.ts` does I/O and nothing else; every string
 * that reaches disk, and every rule about what is a legal answer, is here so it
 * can be tested without a terminal or a filesystem.
 */

export type Topology = 'direct' | 'service';
export type ConfigFormat = 'jsonc' | 'toml';

/** The file the limits live in, beside the state file in the limiter's folder. */
export const LIMITS_FILE = 'durable-rate-limiter.limits.jsonc';

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
 * Without the config route it re-exports the package and nothing else. With it,
 * the Worker also carries the door to `configure` — which is the only way that
 * method can be reached at all. It is a method on a Durable Object, so something
 * deployed has to call it; there is no `wrangler` command that can.
 *
 * The route holds no limits. It applies whatever it is POSTed, which is what
 * keeps a limit change out of the build.
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
// reach it. This is that Worker.
//
// NOTHING HERE HOLDS YOUR LIMITS. They are durable state inside the object, and
// this Worker is only the door to them. Your editable copy lives in
// \`${LIMITS_FILE}\` beside this project, is never deployed, and is
// uploaded by:
//
//   npx @bakidev/durable-rate-limiter configure
//
// So changing a limit does not require redeploying this Worker. Redeploy it
// when THIS code changes — a package upgrade, an edit below — and not otherwise.
//
// Both routes are guarded by the DRL_CONFIG_KEY secret and deny everything when it
// is unset. Rotate it with:
//
//   npx wrangler secret put DRL_CONFIG_KEY
import { REGISTRY_NAME } from '@bakidev/durable-rate-limiter/do';
import type {
  LimiterConfig,
  LimiterRpc,
  LimiterStats,
} from '@bakidev/durable-rate-limiter/do';
// Imported rather than relied on as a global: the Workers runtime types are
// ambient only once \`@cloudflare/workers-types\` (or a \`wrangler types\` output)
// is listed in this project's tsconfig \`types\`, and this Worker is generated
// into a directory with no tsconfig of its own. \`import type\` because the
// package ships types only — a value import would survive into the bundle.
import type { DurableObjectNamespace } from '@cloudflare/workers-types';

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

    // POST, and not merely by convention: a Worker deployed before the limits
    // moved out of the bundle answers GET /configure by applying its own baked-in
    // limits and returning 200. Refusing the method is what turns that silent
    // wrong answer into a visible one.
    if (configuring && request.method !== 'POST') {
      return new Response('POST required', { status: 405 });
    }

    const result: Record<string, LimiterStats> = {};

    if (configuring) {
      const limits = (await request.json()) as Record<string, LimiterConfig>;
      for (const [name, config] of Object.entries(limits)) {
        // \`configure\` is a setup call: it rebuilds the bucket and rejects anyone
        // currently queued, which is the honest signal that their wait will never
        // be satisfied under the limits they were waiting on. Do not call it on a
        // request path.
        //
        // The config is complete, never a patch — there is no default to merge a
        // fragment onto. Use \`reconfigure\` to adjust one field of a bucket that
        // already exists.
        await stubFor(env, name).configure(name, config);
        result[name] = await stubFor(env, name).stats();
      }
      return Response.json(result);
    }

    // Every bucket, without being told which — a namespace cannot be listed and
    // \`idFromName\` does not run backwards, so the object keeps the list itself.
    // A name gets into it on \`configure\`, and a bucket that was never configured
    // cannot run, so nothing live is missing from this.
    const registry = stubFor(env, REGISTRY_NAME);

    for (const name of await registry.listNames()) {
      try {
        result[name] = await stubFor(env, name).stats();
      } catch {
        // A listed name with no bucket behind it: the surviving half of a
        // creation that failed after registering. Prune it while we are here —
        // repair-on-read fixes drift whatever caused it, where a compensating
        // delete only fixes the failure that ran it.
        await registry.unregisterName(name);
      }
    }

    return Response.json(result);
  },
};

function stubFor(env: LimiterWorkerEnv, name: string): LimiterRpc {
  // RPC erases generics: an undeclared stub has methods typed \`never\`, \`never\`
  // is assignable to everything, and a wrong call would still compile.
  return env.RATE_LIMITER.getByName(name) as unknown as LimiterRpc;
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

/** One bucket's limits, as they appear in the limits file. */
export interface LimitsEntry {
  name: string;
  bucket: BucketPlan;
  concurrency: number;
  retry?: { maxRetries: number; maxDelayInMs: number };
}

/** What a limits file says, once parsed. */
export interface LimitsFile {
  entries: LimitsEntry[];
  /** Present only on the file `sample` writes. See {@link sampleLimitsFile}. */
  source?: 'sample';
}

const DEFAULT_RETRY = { maxRetries: 3, maxDelayInMs: 30_000 };

/** The shared explanation of what these numbers mean and how to get them wrong. */
const SIZING_NOTE = `// Worst-case throughput is capacity + fillPerWindow — NOT fillPerWindow. A full
// bucket drains instantly and then refills over the same window, so to stay
// under an upstream limit L, size these so that capacity + fillPerWindow <= L.
//
// One entry per upstream limit. Two endpoints with different quotas are two
// entries; endpoints sharing a quota share one.`;

function limitsBody(entries: LimitsEntry[], extra: string[] = []): string {
  const buckets = entries
    .map((entry) => {
      const retry = entry.retry ?? DEFAULT_RETRY;
      return `    "${entry.name}": {
      "bucket": {
        "capacity": ${String(entry.bucket.capacity)},
        "fillPerWindow": ${String(entry.bucket.fillPerWindow)},
        "windowInMs": ${String(entry.bucket.windowInMs)}
      },
      "concurrency": ${String(entry.concurrency)},
      "retry": { "maxRetries": ${String(retry.maxRetries)}, "maxDelayInMs": ${String(retry.maxDelayInMs)} }
    }`;
    })
    .join(',\n');

  return `{
${[...extra, `  "limits": {\n${buckets}\n  }`].join(',\n')}
}
`;
}

/**
 * The limits file: yours to edit, never deployed, never read at runtime.
 *
 * That separation is the whole point. The limits are durable state inside the
 * Durable Object; this file is the copy you keep in version control, and
 * `configure` is what carries one to the other. It is JSONC rather than
 * TypeScript for exactly one reason — a TypeScript file would have to be
 * imported by the limiter Worker, which would make every limit change a code
 * change and every code change a deploy.
 */
export function limitsFileSource(entries: LimitsEntry[]): string {
  return `// Your limits. NOT read at runtime — this file is never deployed, and the
// limiter Worker never imports it.
//
//   1. edit a limit here
//   2. npx @bakidev/durable-rate-limiter configure
//
// No redeploy in between. The limits live in the Durable Object's own storage,
// and \`configure\` writes them there over the key-guarded route.
//
${SIZING_NOTE}
//
// Read the live ones back, overwriting this file, with:
//
//   npx @bakidev/durable-rate-limiter stats --save
${limitsBody(entries)}`;
}

/** The one worked entry `sample` writes, so the shape is visible before it is real. */
export const SAMPLE_ENTRIES: LimitsEntry[] = [
  {
    name: 'example-api',
    bucket: { capacity: 12, fillPerWindow: 48, windowInMs: 60_000 },
    concurrency: 5,
  },
  {
    name: 'example-search-api',
    bucket: { capacity: 6, fillPerWindow: 24, windowInMs: 60_000 },
    concurrency: 2,
  },
];

/**
 * An example limits file, written offline.
 *
 * The `"source": "sample"` line is not decoration: `configure` reads it and
 * asks before applying, because a header comment saying "these numbers are
 * invented" cannot stop anything, and applying invented numbers to a live
 * limiter is a real outage.
 */
export function sampleLimitsFileSource(): string {
  return `// An EXAMPLE written by \`durable-rate-limiter sample\`. These numbers are made
// up: they are NOT your limits, and writing this file applied nothing.
//
//   real limits, read back from the limiter, replacing this file:
//     npx @bakidev/durable-rate-limiter stats --save
//
//   apply what is in this file, once you have made it true:
//     npx @bakidev/durable-rate-limiter configure
//
// Delete the "source" line below once these are your real numbers. While it is
// there, \`configure\` asks before applying them.
//
${SIZING_NOTE}
${limitsBody(SAMPLE_ENTRIES, ['  "source": "sample"'])}`;
}

/**
 * A limits file, read.
 *
 * Every problem is collected rather than the first thrown, because a
 * hand-edited file usually has more than one and reporting them one run at a
 * time is a bad way to spend an afternoon. Validation is real work here: this
 * used to be TypeScript, so the compiler did it.
 */
export type ParseResult =
  { ok: true; file: LimitsFile } | { ok: false; problems: string[] };

export function parseLimits(source: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(source));
  } catch (error: unknown) {
    return {
      ok: false,
      problems: [`not valid JSONC — ${(error as Error).message}`],
    };
  }

  const root = asRecord(parsed);
  if (root === null) return { ok: false, problems: ['not a JSON object'] };

  const limits = asRecord(root.limits);
  if (limits === null) {
    return { ok: false, problems: ['no "limits" object at the top level'] };
  }

  const problems: string[] = [];
  const entries: LimitsEntry[] = [];

  for (const [name, raw] of Object.entries(limits)) {
    const at = (what: string): string => `${name}: ${what}`;

    if (!isValidInstanceName(name)) {
      problems.push(
        at(
          'not a usable bucket name — letters, digits, dots, dashes, underscores'
        )
      );
    }

    const entry = asRecord(raw);
    if (entry === null) {
      problems.push(at('not an object'));
      continue;
    }

    const bucket = asRecord(entry.bucket);
    if (bucket === null) {
      problems.push(at('no "bucket"'));
      continue;
    }

    const capacity = whole(bucket.capacity, 1);
    const fillPerWindow = whole(bucket.fillPerWindow, 1);
    const windowInMs = whole(bucket.windowInMs, 1);
    const concurrency = whole(entry.concurrency, 1);

    if (capacity === null)
      problems.push(at('bucket.capacity must be a whole number >= 1'));
    if (fillPerWindow === null) {
      problems.push(at('bucket.fillPerWindow must be a whole number >= 1'));
    }
    if (windowInMs === null) {
      problems.push(at('bucket.windowInMs must be a whole number >= 1'));
    }
    if (concurrency === null) {
      problems.push(at('concurrency must be a whole number >= 1'));
    }

    const retry = entry.retry === undefined ? null : asRecord(entry.retry);
    if (entry.retry !== undefined && retry === null) {
      problems.push(at('"retry" must be an object'));
    }

    if (
      capacity === null ||
      fillPerWindow === null ||
      windowInMs === null ||
      concurrency === null
    ) {
      continue;
    }

    entries.push({
      name,
      bucket: { capacity, fillPerWindow, windowInMs },
      concurrency,
      ...(retry === null
        ? {}
        : {
            retry: {
              maxRetries:
                whole(retry.maxRetries, 0) ?? DEFAULT_RETRY.maxRetries,
              maxDelayInMs:
                whole(retry.maxDelayInMs, 1) ?? DEFAULT_RETRY.maxDelayInMs,
            },
          }),
    });
  }

  if (entries.length === 0 && problems.length === 0) {
    problems.push('"limits" is empty — there is nothing to apply');
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    file: {
      entries,
      ...(root.source === 'sample' ? { source: 'sample' as const } : {}),
    },
  };
}

/** What `configure` uploads: the entries, as the Durable Object wants them. */
export function limitsPayload(
  entries: LimitsEntry[]
): Record<
  string,
  { bucket: BucketPlan; concurrency: number; retry?: unknown }
> {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.name,
      {
        bucket: entry.bucket,
        concurrency: entry.concurrency,
        retry: entry.retry ?? DEFAULT_RETRY,
      },
    ])
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function whole(value: unknown, least: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= least
    ? value
    : null;
}

/**
 * Comments out of JSONC, so a config file can explain itself and still parse.
 *
 * String-aware, because a `//` inside a URL is not a comment and neither is one
 * inside an escaped quote — the two cases that make the naive regex version
 * silently corrupt a config.
 */
export function stripJsonComments(source: string): string {
  let output = '';
  let index = 0;
  let inString = false;

  while (index < source.length) {
    // Indexing past the end is impossible inside the loop condition, but the
    // types do not know that and the `?? ''` costs nothing.
    const char = source[index] ?? '';
    const next = source[index + 1];

    if (inString) {
      output += char;
      if (char === '\\') {
        output += next ?? '';
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
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

  // The name is passed as well as used to address the stub: a Durable Object
  // cannot recover the name it was reached by, and it needs one to enter the
  // registry that makes \`stats\` able to list every bucket. The config is
  // complete, because there is no default for a fragment to merge onto.
  await stub.configure('${instanceName}', ${patch});

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
