# @bakidev/durable-rate-limiter

A shared rate limiter and concurrency gate for Cloudflare Workers, backed by a
Durable Object.

```ts
const value = await limiter.for(env).call(() => fetch(url, init), {
  read: (res) => res.json(),
});
```

One token bucket, shared by every isolate, every Workflow instance, every cron
tick and every application bound to it. `call()` takes a **function**, not a
request — so the object decides _when_ your work runs while the work itself runs
_in your isolate_.

---

## The problem

Rate limiting is a per-process concern in most libraries: a token bucket lives
in memory, the code that calls the API asks it for permission, and everything
works as long as there is exactly one process.

**On Workers there is never exactly one process.** A Worker runs in many
isolates across many locations; a Workflow spawns instances that neither know
nor can reach each other; a cron tick and a user request fire simultaneously.
Each constructs its own in-memory bucket, each politely paces itself to the
configured rate, and collectively they exceed the upstream quota by however many
isolates happen to be warm. **The limiter is locally correct and globally
useless.**

The same problem appears one level up: several _applications_ sharing one API
key have no way to coordinate at all.

Porting an in-process limiter does not fix it, for two independent reasons:

- **Timers are not allowed where the state would have to live.** Workers forbids
  `setTimeout`/`setInterval` at module scope, which is the only place a shared
  singleton could sit — and the failure appears **only at deploy**, never
  locally.
- **In-memory token state is destroyed constantly.** An isolate is discarded
  between requests; a Durable Object is evicted after 70–140 seconds idle. An
  in-memory count resets to _full capacity_ on every cold start, handing out a
  maximum-size burst against someone else's quota precisely when traffic has
  just resumed.

So the bucket has to be **state-driven rather than event-driven** — tokens
derived from a persisted `{ tokens, lastRefillAt, forcedUntil }` triple and
wall-clock elapsed time at read time — and it has to live somewhere with
identity and durable storage. On Cloudflare that means a Durable Object: the
only primitive that guarantees a single instance serialising all callers against
one piece of state.

### Why a function and not a request

A conventional gateway proxies: you hand over a URL, headers and a body, it
performs the request when capacity allows. That forces every byte through a
single-threaded object, requires the gateway to hold your credentials, and makes
it specific to each upstream's auth and error conventions.

This package sends a function. Workers RPC does not serialise functions — it
passes a handle, and invoking that handle calls back into the isolate the
function came from. Everything else follows:

- **Payloads never transit the object.** A multi-megabyte download happens in
  your isolate. The object sees only a small summary.
- **No credentials cross.** You build your own headers; the limiter holds no
  secrets and parses nothing but `{ status, retryAfter }`.
- **It is enforcement, not cooperation.** The object controls the moment of
  execution, so a caller cannot fire early no matter what it intends.
- **Concurrency is genuinely measured.** The object awaits your callback, so it
  knows when work _finishes_ — which a design handing out permits or timestamps
  can never know.
- **One caller's 429 throttles all of them**, in every isolate and every
  application, with no reporting protocol for anyone to forget to implement.

---

## Install

```sh
npm install @bakidev/durable-rate-limiter
```

Two subpath exports:

| Import                                 | Who uses it                            |
| -------------------------------------- | -------------------------------------- |
| `@bakidev/durable-rate-limiter/do`     | the **limiter Worker** you deploy once |
| `@bakidev/durable-rate-limiter/client` | every **consuming application**        |

Both are built from one shared envelope definition, so the halves cannot drift.

---

## TL;DR — setup in five steps

Minimal configuration, start to first paced call. This uses the one-hop
cross-script binding, which is the shortest correct path; the service-binding
topology is described [below](#the-other-topology-a-service-binding).

> **Or let the CLI do it.** `npx @bakidev/durable-rate-limiter init`, run from
> your application's root, walks these five steps and writes every file below —
> including sizing the bucket against your upstream's real limit. It shows each
> file and command before it acts. [What it does, exactly.](#the-setup-cli)

### 1. Create the limiter Worker

The object **must live in a Worker of its own** — see
[anti-pattern 6](#6-dont-put-the-durable-object-in-your-application-worker). It
contains no logic; it re-exports the package.

```ts
// limiter/src/index.ts
export { LimiterDO, LimiterEntrypoint } from '@bakidev/durable-rate-limiter/do';

// A Worker exporting a WorkerEntrypoint still needs its own default export.
export default {
  fetch: () => new Response('limiter ok'),
};
```

```jsonc
// limiter/wrangler.jsonc
{
  "name": "my-limiter",
  "main": "src/index.ts",
  "compatibility_date": "2025-07-01",
  "durable_objects": {
    "bindings": [{ "name": "RATE_LIMITER", "class_name": "LimiterDO" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["LimiterDO"] }],
}
```

```sh
npx wrangler deploy --config limiter/wrangler.jsonc
```

Deploy this **first**. A consumer's binding names the Worker, and the binding
cannot be created before the Worker it names exists.

### 2. Bind it from your application

Your application binds the class cross-script. Note there is deliberately **no
`migrations` entry** here: this Worker _binds_ the class, it does not
_implement_ it — which is also what keeps your preview URLs.

```jsonc
// app/wrangler.jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "RATE_LIMITER",
        "class_name": "LimiterDO",
        "script_name": "my-limiter", // the Worker from step 1
      },
    ],
  },
}
```

```sh
npx wrangler types   # so defineBinder can typecheck the binding name
```

### 3. Define the limiter at module scope

```ts
// app/src/limiter.ts
import {
  defineBinder,
  defineLimiter,
} from '@bakidev/durable-rate-limiter/client';

const binder = defineBinder('RATE_LIMITER'); // WHICH binding — typechecked
export const api = defineLimiter({ binder, name: 'example-api' }); // WHICH bucket
```

> **Define at module scope. Bind and call wherever you have `env`.**

`defineBinder` and `defineLimiter` perform no I/O and start no timers, so a
configured limiter is safe as a module-scope singleton. Binding is a separate
step because it needs `env` — a fetch or scheduled handler, a queue consumer, a
Workflow step, a Durable Object method all qualify. Module scope is the one
place that does not, because `env` does not exist there.

`name` is the instance name (`idFromName`'s argument): `example-api`,
`billing-api` and `search-api` are independent buckets on the same class and the
same binding.

### 4. Call

```ts
// app/src/index.ts
import { api } from './limiter.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const limiter = api.for(env); // here, because `env` exists here

    const file = await limiter.call(
      () =>
        fetch('https://api.example.com/v1/files', {
          headers: { authorization: `Bearer ${env.TOKEN}` },
        }),
      { read: (res) => res.json<{ id: string }>() }
    );

    return Response.json(file);
  },
};
```

That call may `await` for minutes. That is the design, and it is cheap — see
[what waiting costs](#what-waiting-costs).

### 5. Set your limits (once)

Without this you get the defaults: `{ capacity: 10, fillPerWindow: 50, windowInMs: 60_000 }`
and `concurrency: 5` — a worst case of exactly 60 calls a minute. `configure` is
a **setup call, not a per-request one**; it is persisted, and it rejects anyone
currently queued.

```ts
// Run once — from a deploy script, an admin route, or a guarded first-run path.
const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('example-api'));

await stub.configure({
  bucket: { capacity: 5, fillPerWindow: 55, windowInMs: 60_000 },
  concurrency: 5,
  retry: { maxRetries: 3, maxDelayInMs: 30_000 },
});

console.log(await stub.stats()); // live tokens, penalty state, in-flight, config
```

---

## The setup CLI

Every step above is mechanical, and every one of them is a chance to get a name
wrong — a mistyped instance name does not error, it silently creates a second
bucket. The CLI asks instead.

```sh
cd my-application
npx @bakidev/durable-rate-limiter init
```

It walks the five steps in the order they must happen — the limiter Worker
first, because a consumer's binding names it — and for each one:

| Step           | What `init` does                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| limiter Worker | scaffolds `src/index.ts` and `wrangler.jsonc`                                                                        |
| binding        | asks which topology, then inserts the binding into your existing config                                              |
| types          | offers to run `wrangler types`, so `defineBinder` typechecks the binding name                                        |
| limiter module | writes `src/limiter.ts` with the binder and the instance name — the name written once                                |
| limits         | asks your upstream's real limit and sizes `capacity + fillPerWindow` to fit under it                                 |
| deploy         | deploys the limiter Worker, sets its guard secret, and applies those limits — the bucket is live before `init` exits |

It opens by telling you to commit first, and reports whether your working tree is
clean, because everything after that is easiest to read as a diff. Nothing is
written or run before it is shown, existing files are never overwritten without
asking, and your wrangler config is edited by insertion rather than reserialised
— a round-trip through a JSON parser would delete every comment in a file whose
format exists to have them. If the relevant key is already present, `init` prints
the fragment for you to merge instead of guessing.

Anything it could not do ends up in a "still to do" list with the exact command.
`--yes` takes every default without asking, and never deploys.

### Configuring without writing a deploy script

`configure` is a method on the Durable Object, so **only a deployed Worker can
call it** — no `wrangler` command reaches a DO method. `init` therefore offers to
give the limiter Worker a key-guarded route, and to put your limits beside it as
code:

```ts
// durable-rate-limiter/src/limits.ts — one entry per upstream limit
export const LIMITS: Record<string, Partial<LimiterConfig>> = {
  'read-api': {
    bucket: { capacity: 12, fillPerWindow: 48, windowInMs: 60_000 },
    concurrency: 5,
  },
  'write-api': {
    bucket: { capacity: 6, fillPerWindow: 24, windowInMs: 60_000 },
    concurrency: 2,
  },
};
```

The limits then live in version control, change in a reviewable diff, and are
applied by two commands:

```sh
npx @bakidev/durable-rate-limiter configure   # deploy the limiter Worker, then apply LIMITS
npx @bakidev/durable-rate-limiter stats       # read every bucket's live state back
```

Both routes are guarded by a `DRL_CONFIG_KEY` secret and **deny everything while it
is unset** — an unset secret means denied, never open. `init` generates a key,
sets it with `wrangler secret put`, and applies your limits before it exits, so
the bucket is configured by the time anything calls it. The Worker's secret and
the environment variable the CLI reads share that one name deliberately — seeing
`DRL_CONFIG_KEY` in the Cloudflare dashboard should tell you what it belongs to.
Export it to skip the prompt in CI.

A secret cannot be read back, so a key you have lost and a key you have typed
wrong have the same remedy: set a new one, which replaces it. Both commands say
so at the point it matters.

```sh
npx wrangler secret put DRL_CONFIG_KEY --config durable-rate-limiter/wrangler.jsonc
# or: Workers & Pages → your limiter Worker → Settings → Variables and Secrets
```

`init` leaves a `.durable-rate-limiter.jsonc` **inside the limiter's own folder**
— your project root gains one directory and nothing else. It records the Worker
name, its config, where the limits live and the deployed URL; no secrets, so
commit it. Every path in it is relative to that folder, and `configure`/`stats`
find it from anywhere in the project, so they work from a subdirectory too.

Decline the route and `init` writes a `configureLimiter(env)` module instead, for
you to call from a deploy script, an admin route, or a guarded first-run path.

> `configure` rebuilds each bucket and **rejects anyone currently queued** —
> their wait can never be satisfied under limits that no longer exist. It is a
> setup call, not a per-request one. Prefer a quiet moment.

---

## 🚨 The sizing rule

> ### Worst-case throughput is `capacity + fillPerWindow`.
>
> **Not `fillPerWindow`.** To stay under an upstream limit `L`, size so that
>
> ### `capacity + fillPerWindow <= L`

The burst allowance is spent immediately and then the sustained rate refills on
top of it, **within the same window**. This is correct token-bucket behaviour,
and it is not what the configuration reads like.

Measured against a real deployment: a bucket at `fillPerWindow: 10` per 60 000 ms
with `capacity: 5` delivered **15 calls in the first rolling 60-second window**.

| Upstream limit | Config                                                    | True worst case |
| -------------- | --------------------------------------------------------- | --------------- |
| 60 / minute    | `{ capacity: 10, fillPerWindow: 50, windowInMs: 60_000 }` | 60 / minute     |
| 60 / minute    | `{ capacity: 5, fillPerWindow: 45, windowInMs: 60_000 }`  | 50 / minute     |
| ❌ 60 / minute | `{ capacity: 10, fillPerWindow: 60, windowInMs: 60_000 }` | **70 / minute** |

`capacity` and `fillPerWindow` are independent knobs. `{ capacity: 10, fillPerWindow: 50 }`
reads as "50 a minute, never more than 10 at once" — the most useful shape for
pacing a real upstream.

---

## Anti-patterns

Each of these compiles, and several of them work in local development.

### 1. Don't hand it a request — hand it a function

```ts
// ❌ The fetch has already fired. The limiter paced nothing.
await limiter.call(fetch(url), { read });

// ❌ Same problem in disguise: `fetch` unbound, and no way to build a fresh
//    request per attempt.
await limiter.call(fetch, { read });

// ✅ A thunk. The object decides when this runs.
await limiter.call(() => fetch(url), { read });
```

The whole design rests on the limiter receiving something it can invoke _later_.
Anything already in flight is outside its control, and passing `fetch` itself
gives it nothing to send.

### 2. Don't close over a built `Request`

`fn` is re-invoked **from scratch** on every retry, so it must construct its own
request each time.

```ts
// ❌ Body already consumed on attempt two.
const req = new Request(url, { method: 'POST', body });
await limiter.call(() => fetch(req), { read });

// ✅ Fresh request per attempt.
await limiter.call(
  () => fetch(url, { method: 'POST', body: JSON.stringify(payload) }),
  { read }
);
```

The wrong form fails on retry with a "body already used" error that looks
nothing like a retry problem.

### 3. Don't throw on a non-2xx — report it

Workers RPC reconstructs a thrown error from `name`, `message` and `stack`
**only**. Every custom property is stripped crossing the boundary — a `status`,
a `code`, a `retryable` flag. Retryability therefore _cannot_ be signalled by
throwing: the object sees something indistinguishable from a network blip and
retries your 404 to exhaustion.

```ts
// ❌ `retryable` and `status` do not survive the hop.
await limiter.call(
  async () => {
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error('bad'), { status: res.status });
    return res;
  },
  { read }
);

// ✅ The failure travels as data, and the object honours the decision.
await limiter.call(() => fetch(url), {
  read: (res) => res.json(),
  error: (res) =>
    res.ok ? null : { message: 'bad', retryable: res.status >= 500 },
});
```

The plain HTTP status is carried for you automatically; the `error` hook is for
failures your upstream hides in a 200 body.

### 4. Don't return the response (or a big payload) from `read`

`read` exists to extract the small thing you actually need while the body stays
local. Returning something large drags it back through a single-threaded object
to reach the caller that already had it.

```ts
// ❌ Defeats the entire point.
{
  read: (res) => res.blob();
}

// ✅ Do the whole job caller-side, return an identifier.
{
  read: async (res) => (await uploadToStorage(res.body!, folderId)).id;
}
```

`read` also runs on **error** responses, so read defensively if your upstream
returns a different shape on failure — a throw from `read` propagates and is
retried as an unknown error.

### 5. Don't do work at module scope, and don't bind there

```ts
// ❌ `env` does not exist at module scope, and a timer there fails at DEPLOY —
//    never locally, never in tests.
const bound = api.for(env);

// ✅ Define at module scope; bind and call wherever `env` reaches you.
export const api = defineLimiter({ binder, name: 'example-api' });
```

This is exactly what sank the predecessor package: its constructor started an
interval, so a module-scope singleton could not be constructed at all.

### 6. Don't put the Durable Object in your application Worker

Two platform constraints, both verified:

- **A Worker implementing a Durable Object gets no preview URLs.** This applies
  to the whole Worker, not just the object.
- **A new Durable Object migration cannot be uploaded as a version.** A version
  containing both a migration and a binding referencing the new class is
  rejected with 403. Migrations apply only on deployment, and are atomic.

A Worker that merely _binds_ an object defined elsewhere (via `script_name`) does
not implement one, and is unaffected. Giving the limiter its own Worker is
required anyway for multi-application use.

### 7. Don't mistype the instance name

A mistyped `name` does not error. It silently creates a **second bucket**, and
each paces at the full configured rate against one upstream quota. The failure
surfaces later as unexplained 429s from an upstream nobody was over-calling.
This is why `name` lives on the limiter definition — written exactly once.

### 8. Don't export the entrypoint as `default`

```ts
// ❌ Typechecks, then fails at startup: "has no such named entrypoint".
export default class LimiterEntrypoint { ... }

// ✅ A service binding with "entrypoint" resolves against NAMED exports only.
export { LimiterEntrypoint } from '@bakidev/durable-rate-limiter/do';
```

### 9. Don't let a raw stub type reach a call site

RPC **erases generics — completely, and silently.**
`DurableObjectStub<LimiterDO>['execute']` resolves to `never`, including for
methods whose type parameter is inferred from an argument. `never` is assignable
to everything, so nothing errors; type checking simply stops at the stub
boundary and a completely wrong call still compiles.

Type a service binding as `LimiterService`, and assert a direct stub to
`LimiterRpc` exactly once, where the stub is obtained. `defineBinder` already
does this for you.

### 10. Don't use `rateLimit` for one endpoint's failure

The two hooks mean different things, and blurring them turns one endpoint's 500
into a stall for every other caller of the same upstream.

| Hook        | Non-null result means                        | Scope                              |
| ----------- | -------------------------------------------- | ---------------------------------- |
| `rateLimit` | treat exactly as an HTTP 429 with this delay | **global** — pauses every caller   |
| `error`     | the call failed; `retryable` decides         | **local** — retries this call only |

### 11. Don't block or throw inside `onDrop`

It runs on the caller's path between attempts. Anything slow there is added
directly to the latency of a call that has already been unlucky once.

---

## Features

### Global rate limiting that actually holds

One token bucket in a Durable Object, shared by every isolate, every Workflow
instance, every cron tick, and every application bound to it. Not a bucket per
isolate. Worst case is `capacity + fillPerWindow` — see
[the sizing rule](#-the-sizing-rule).

### Real concurrency limiting

A cap on calls actually in flight, not an approximation derived from rate.
Because the object awaits the callback, it knows when work _finishes_. Measured
holding at exactly the configured value under variable production latency.

### Cross-caller backpressure

A rate-limit response seen by one caller pauses the shared bucket for all of
them — including callers already queued, in other isolates, in other
applications. No reporting protocol, nothing for a consumer to forget to
implement.

`Retry-After` is honoured in both documented forms (integer seconds and HTTP
date) and from both header shapes (a `Headers` object and a plain object). Where
a delay must be inferred instead, exponential backoff clamped to a maximum.

Concurrent penalties do not stack: the deadline is the maximum of existing and
new, so three simultaneous `5s / 60s / 5s` responses wait 60 seconds, not 5. A
penalty does not resume at full capacity either — it restores
`penaltyRefillFraction` of it (default `0.5`), because a full burst aimed at an
API that just asked for backoff re-trips it immediately.

### Rate limits and errors hidden in response bodies

Not every API says 429. Two optional hooks handle the ones that don't
([their scopes differ](#10-dont-use-ratelimit-for-one-endpoints-failure)):

```ts
export const api = defineLimiter({
  binder,
  name: 'example-api',
  rateLimit: (res, body) =>
    (body as ApiError)?.error?.status === 'RATE_LIMIT_EXCEEDED'
      ? { retryAfterMs: 60_000 }
      : null,
  error: (res, body) =>
    (body as ApiError)?.error
      ? {
          message: (body as ApiError).error.message,
          retryable: res.status >= 500,
        }
      : null,
});
```

Both resolve in three chained layers — call site, then limiter default, then
built-in HTTP — each falling through on `null`. The HTTP layer is
**unconditional**, so overriding a hook for one odd endpoint never silently
disables genuine 429 handling there. An explicit `null` at a call site opts out
of both hook layers; the HTTP layer still applies.

Defaults live on the limiter definition, so an API's convention is written once
and reused across every call site.

### Retries with correct 4xx handling

Client errors are not retried; 429 is. Exponential backoff with a configurable
floor, ceiling and factor, and partial options **merged** with the defaults
rather than replacing them wholesale.

### Dropped callers are retried for you

A caller parked in the object's memory-only queue can be dropped — measured at
2.4% of calls under load. The client retries that automatically, and safely even
for non-idempotent work. [Full detail below.](#dropped-callers-and-why-the-package-retries-them)

### Survives eviction without a burst

Bucket state is a persisted `{ tokens, lastRefillAt, forcedUntil }` triple,
refilled from wall-clock elapsed time when read. An object evicted after 70–140
seconds idle reconstructs at the _correct_ token count — not at full capacity,
which is what an in-memory counter does, precisely when traffic resumes.

### Idle limiters cost nothing

No timer exists unless a caller is waiting; one timer serves the whole queue,
sized to the exact deficit, cleared when the queue drains. An idle object
hibernates.

### Many limiters, one deployment

Instances are addressed by name, so `example-api`, `billing-api` and `search-api` are
independent buckets on one class and one binding. `defineBinder` is declared once
and reused.

### Typechecked bindings

`defineBinder` is constrained to keys of your generated `Env` that are actually
Durable Object namespaces. A typo fails to compile; so does pointing at a KV or
D1 binding. Zero runtime cost. A runtime presence check at bind time covers
consumers who haven't run `wrangler types`, naming the bindings it _did_ find.

Without a generated `Env` there is nothing to match against and every argument is
rejected — that is what `defineBinder.unchecked('RATE_LIMITER')` is for.
Explicit, so the absence of checking is visible at the call site rather than
inferred from a mysteriously permissive signature.

### Testable without magic

Under `@cloudflare/vitest-pool-workers` the real binding exists and is backed by
a local Durable Object, so most tests need no seam at all. For unit tests outside
workerd, `defineTestBinder` injects a namespace directly and returns the same
`Binder` type, so the module under test is unchanged.

```ts
const binder = defineTestBinder({
  idFromName: (name) => name,
  get: () => ({ execute: async (fn) => (await fn()).value }),
});
```

No allowlisted magic names. The injection point is explicit and discoverable.

### Safe at module scope

`defineBinder` and `defineLimiter` perform no I/O and start no timers, so a
configured limiter can be exported as a module-scope singleton.

### Observable

`stats()` returns live token count, penalty state, in-flight count and the raw
persisted triple. A shared limiter nobody can inspect is a shared limiter nobody
will trust.

### Version skew is loud

`ping()` reports the limiter Worker's `ENVELOPE_VERSION`. The two halves deploy
on independent schedules, so a consumer can compare it against its own at startup
instead of discovering the mismatch as silent mis-limiting.

---

## Dropped callers, and why the package retries them

The object's wait queue is memory-only — an RPC function handle cannot be
persisted, so a queue of them cannot be written to storage. A caller parked in
that queue holds an open RPC connection, and if the object is evicted, reset or
redeployed while it waits, the connection breaks and the call rejects with a
transport error.

Measured against a real deployment across four runs of ten Workflow instances
stampeding one bucket: **7 of 290 calls, 2.4%** (95% CI 1.2–4.9%). Every one was
dropped _while parked_; none died once its callback had started. The waits at the
moment of the drop ran from 47 s to 8.8 min and did not cluster at the long end,
so this is not a duration ceiling — it reads as eviction or restart landing on
whoever happens to be queued.

At that rate, "callers must retry" is not a footnote. The client retries it, up
to five times by default, so a call has to be dropped **six separate times** to
fail. In the run made after this shipped, both drops recovered on their first
retry and the run finished with zero failures.

```ts
export const api = defineLimiter({
  binder,
  name: 'example-api',
  dropRetries: 5, // the default; 0 opts out
  onDrop: ({ limiter, attempt, willRetry, error }) =>
    metrics.increment('limiter.drop', { limiter, willRetry }),
});
```

**Why this is safe even for non-idempotent work.** The retry fires on exactly one
condition: the callback never ran. That is knowable rather than guessed, because
the callback runs in _your_ isolate — if it never fired, no request reached the
upstream and there is nothing to duplicate. A connection lost _after_ the
callback started is never retried for you; that case is genuinely ambiguous, and
deciding it on your behalf could send a payment twice. It propagates unchanged,
for you to make idempotent or reconcile.

The retry takes a fresh stub, because the handle whose connection just broke
would otherwise repeat the failure instantly. It adds no backoff — a retry must
re-acquire a token before it runs, so the bucket's own pacing is already the
wait, which also spreads the attempts out rather than firing them into one bad
window. When the attempts are spent, the call rejects with `CallDroppedError`,
carrying `attempts`, `limiter` and the original transport message as `cause`.
Unlike the errors thrown inside the object, this one never crosses an RPC
boundary, so its properties actually survive to be read.

`onDrop` fires on **every** drop, retried or not. The drop rate is a property of
_your_ deployment — object churn, redeploy cadence, how long your callers park —
not of the measurements above, so it has to be observable in production rather
than assumed.

### Why this page quotes no failure probability

Six attempts at a 2.4% drop rate multiplies out to roughly one in ten billion,
and that figure would be worth very little.

- **The base rate is uncertain.** 7 of 290 is a small sample. The real rate is
  somewhere in 1.2–4.9%, and compounding an uncertain number amplifies the
  uncertainty — across that interval the six-attempt result spans a factor of
  5 000. A single number would be false precision presented as a guarantee.
- **The events are not independent.** Drops come from eviction, reset and
  redeploy, and a redeploy drops _every_ parked caller at once — then their
  retries re-queue into the same window. No run has yet produced a call dropped
  twice, so the probability of a second drop given a first is unmeasured, and
  that is precisely the quantity the exponent assumes.

Beyond about five retries the residual risk is dominated by correlated failures
that more attempts cannot fix, while the costs stay real — every attempt consumes
a token before it runs, so a retry storm spends upstream quota doing nothing.
Measure your own rate with `onDrop`; that is the number that should inform your
`dropRetries`.

---

## Production numbers

Everything below was measured against a real Cloudflare deployment — two Workers,
Durable Objects, Workflows. Local emulation does not reproduce the platform
limits: Miniflare does not appear to enforce invocation accounting, so local
tests are for logic, not for limits.

### A parked callback survives 23 minutes

The platform documents that a passed function "only lasts until the end of the
Workers' execution contexts". In practice, while the caller remains awaiting,
this is not a practical constraint. Across 100 calls from 10 independent Workflow
instances, all synchronised to stampede at one instant:

```
longest successful park   23.25 min (1 395 136 ms)
median park                4.40 min
succeeded                  100 / 100
failed                     0
```

No drops, no timeouts, no partial results. Two further runs without induced
backpressure completed 100/100 with a longest park of 4.99 minutes — bounded by
the test's own batching, not by any platform limit. **"Hold the caller until its
turn" is viable for waits measured in tens of minutes.**

### Concurrency is enforced exactly

Configured concurrency 5; peak observed overlap of caller-side work was **exactly
5** across every production run, under genuinely variable network latency. This is
the condition under which an in-process cap is most likely to be silently broken.

### Backpressure works, and compounds

Ten rate-limit responses carrying `Retry-After: 30` stretched a workload that
drains in ~10 minutes out to **~28 minutes**. Every call still succeeded. The
recovery curve after repeated rate limiting is steeper than the sum of the
individual delays suggests.

### The two topologies are indistinguishable

| Path                       | Cold   | Warm  |
| -------------------------- | ------ | ----- |
| service binding (two hops) | 541 ms | 45 ms |
| direct DO (one hop)        | 412 ms | 43 ms |

Cold-start cost dominates and is unrelated to hop count. Choose the topology on
API-surface grounds, not performance.

### The 32-invocation limit did not manifest

Documented as "a single request has a maximum of 32 Worker invocations, and each
call to a Service binding counts towards this limit". Neither topology failed at
64 sequential calls in one request — 64 is where the probe stopped, not where
anything broke. Per-request call volume is not a practical design constraint at
realistic scale.

### What waiting costs

Workers bills CPU, and a request awaiting I/O consumes none. Durable Object
duration is billed per object and **shared across all requests active on it at
once**, so a hundred parked callers cost what one costs. There is no hard
wall-clock limit while the caller stays connected.

The one real cost: an object with a request in flight cannot hibernate, so a lone
caller waiting against an otherwise-idle object pays for that wall time. Under
bursty traffic the object is active regardless.

---

## The other topology: a service binding

The package also ships `LimiterEntrypoint`, a `WorkerEntrypoint` in front of the
object. It buys a declared interface that can evolve independently of the
object's class name, one place for the instance-name convention, and somewhere
for metrics, auth and per-consumer policy to live later. It costs ~2 ms warm,
which is noise. The cross-script binding in the quickstart remains fully
supported, but it couples every consumer to the object's class name.

```jsonc
// app/wrangler.jsonc — instead of the durable_objects binding
{
  "services": [
    {
      "binding": "LIMITER",
      "service": "my-limiter",
      "entrypoint": "LimiterEntrypoint", // NAMED export; omitting this
    }, //                                   resolves to the default export
  ],
}
```

```ts
import type { LimiterService } from '@bakidev/durable-rate-limiter/do';

// Type the binding as LimiterService — see anti-pattern 9.
declare global {
  interface Env {
    LIMITER: LimiterService;
  }
}

await env.LIMITER.configure('example-api', { concurrency: 5 });
const stats = await env.LIMITER.stats('example-api');
```

`defineBinder` only speaks Durable Object namespaces, which is correct — a
service binding is not one. To run the client stack over this topology, supply a
namespace-shaped adapter through `defineTestBinder`;
[`verify/consumer/src/limiter-client.ts`](verify/consumer/src/limiter-client.ts)
does exactly that.

---

## Known limits — stated, not buried

- **The wait queue is memory-only.** An RPC function handle cannot be persisted,
  so queued callbacks do not survive object eviction — measured at 2.4% of calls
  under load. The client retries this for you when the callback never ran, but
  the retry is bounded: `call()` is still throwable, now with `CallDroppedError`,
  and a caller that must not lose work needs its own durable retry above this
  one. **No compounded failure probability is published**, because the drop rate
  comes from a small sample and the events are not independent — one redeploy
  takes out every parked caller at once. Measure yours with `onDrop`.
- **A drop after the callback started is never retried automatically.** It cannot
  be distinguished from a completed upstream request, so it is left to you. Make
  such calls idempotent, or reconcile them.
- **`fn` is re-invoked on retry** and must build a fresh request each time. A
  closure over an already-consumed body fails on the second attempt.
- **The limiter holds no work.** If a caller disconnects, its pending call goes
  with it. This is not a proxy, a queue or a job runner — the caller owns the
  work and the limiter owns only the timing.
- **Hooks are per-call, client-side.** They cannot be registered once on the
  object; sharing an API's convention across call sites is what limiter-level
  defaults are for.
- **`configure` rejects anyone currently queued.** It is a setup call. Rebuilding
  the bucket is the honest signal that their wait will never be satisfied under
  the limits they were waiting on.

---

## API

### `@bakidev/durable-rate-limiter/client`

| Export                         | What it is                                                         |
| ------------------------------ | ------------------------------------------------------------------ |
| `defineBinder(name)`           | Names the DO binding, checked against your generated `Env`.        |
| `defineBinder.unchecked(name)` | The same, without the compile-time check.                          |
| `defineTestBinder(namespace)`  | Injects a namespace directly, for tests outside workerd.           |
| `defineLimiter(definition)`    | Captures binder, instance name, hook defaults and drop policy.     |
| `limiter.for(env)`             | Per-request bind. Where the binding's presence is checked.         |
| `bound.call(fn, options)`      | Runs `fn` under the shared limiter; returns what `read` extracted. |
| `CallDroppedError`             | Every drop retry spent and the callback never ran.                 |
| `DEFAULT_DROP_RETRIES`         | `5`.                                                               |

Types: `Binder`, `Limiter`, `BoundLimiter`, `LimiterDefinition`, `CallOptions`,
`DropEvent`, `DropHook`, `RateLimitHook`, `RateLimitSignal`, `ErrorHook`,
`FailureDescription`, `HookSlot`, `CallReport`, `LimiterStub`, `NamespaceLike`,
`DoBindings`, `ENVELOPE_VERSION`.

### `@bakidev/durable-rate-limiter/do`

| Export                   | What it is                                                                |
| ------------------------ | ------------------------------------------------------------------------- |
| `LimiterDO`              | The Durable Object. Re-export it from your limiter Worker.                |
| `LimiterEntrypoint`      | The named `WorkerEntrypoint` RPC surface.                                 |
| `DEFAULT_LIMITER_CONFIG` | `{ capacity: 10, fillPerWindow: 50, windowInMs: 60_000 }`, concurrency 5. |
| `CallFailedError`        | The rejection a reported failure becomes once it is final.                |
| `ENVELOPE_VERSION`       | Compare against `ping()` to catch skew.                                   |

Types: `LimiterConfig`, `LimiterStats`, `LimiterEnv`, `LimiterService`,
`LimiterRpc`, `LimiterPing`, `CallReport`.

`LimiterDO` methods: `execute(fn)`, `configure(patch)`, `stats()`.
`LimiterEntrypoint` takes the instance name first: `execute(name, fn)`,
`configure(name, patch)`, `stats(name)`, plus `ping()`.

---

## Deployed verification

The claims above are about production behaviour, and none of them can be
established locally. [`verify/`](verify/) is a reproducible harness: two Workers,
a Durable Object, and N Workflow instances that all sleep until one shared
timestamp and then stampede, so the load is genuinely concurrent across isolates
rather than sequential. It produces a plain-text report designed to be pasted
back verbatim.

**It costs money to run** — Workflows, Durable Object wall time, and a run that
parks callers for twenty minutes parks them for twenty minutes. Deploy it,
measure, `wrangler delete` both Workers.

```sh
# 1. Build. The harness imports from dist/, so it verifies the published artifact.
npm install && npm run build && npm run verify:typecheck

# 2. Limiter Worker first — the consumer's bindings name it.
npx wrangler deploy --config verify/limiter/wrangler.jsonc

# 3. Consumer, then the shared secret. The routes are internet-facing; an unset
#    PROBE_KEY denies everything.
npx wrangler deploy --config verify/consumer/wrangler.jsonc
npx wrangler secret put PROBE_KEY --config verify/consumer/wrangler.jsonc

# 4. Export the consumer's workers.dev URL from step 3, and the key.
export VERIFY_URL=https://drl-verify-consumer.<your-subdomain>.workers.dev
export PROBE_KEY=<the value you just set>
```

Each probe is independent; `&via=direct` swaps the two-hop service binding for
the one-hop cross-script Durable Object binding, and every route accepts it.

```sh
curl "$VERIFY_URL/ping?key=$PROBE_KEY"                        # both halves up, versions agree
curl "$VERIFY_URL/closure-check?key=$PROBE_KEY"               # the closure runs in the caller
curl "$VERIFY_URL/closure-check?key=$PROBE_KEY&via=direct"
curl "$VERIFY_URL/client-path?key=$PROBE_KEY"                 # read(), hooks, envelope, end to end
curl "$VERIFY_URL/cap-probe?key=$PROBE_KEY&max=64"            # per-request invocation ceiling
curl "$VERIFY_URL/cap-probe?key=$PROBE_KEY&max=64&via=direct"

# The load run: 10 Workflow instances x 10 calls, all stampeding 60s from now at
# 10/min with a burst of 5 — a ~10 minute drain, so the last caller parks well
# past the six-minute mark the design hinges on. Prints its probe id.
curl "$VERIFY_URL/start?key=$PROBE_KEY&instances=10&callsPerInstance=10&capacity=5&fillPerWindow=10&concurrency=5&holdMs=500&delaySeconds=60"

export PROBE_ID=<probe id from the response>
curl "$VERIFY_URL/report/$PROBE_ID?key=$PROBE_KEY"            # safe to read early
```

Backpressure needs its own run, because it is the one behaviour that only shows
up when a rate-limit response is actually observed:

```sh
curl "$VERIFY_URL/start?key=$PROBE_KEY&instances=10&callsPerInstance=10&simulate429OnCall=3&retryAfterSeconds=30"
```

Tear down when finished:

```sh
npx wrangler delete --config verify/consumer/wrangler.jsonc
npx wrangler delete --config verify/limiter/wrangler.jsonc
```

See [verify/README.md](verify/README.md) for what each route measures and why.

---

## Development

```sh
npm install
npm run check   # typecheck + lint + format + 100% coverage
npm run build
```

Contributor notes, invariants and repo layout: [AGENTS.md](AGENTS.md). Release
process: [PUBLISHING.md](PUBLISHING.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## License

MIT © Nurbaki Kasikci
