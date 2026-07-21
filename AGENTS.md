# AGENTS.md

Working notes for anyone — human or agent — touching this repository.

`@bakidev/durable-rate-limiter` is a shared rate limiter and concurrency gate
for Cloudflare Workers, backed by a Durable Object. Read [docs/preface.md](docs/preface.md)
for why the design is what it is, and [docs/Features.md](docs/Features.md) for
the settled scope. Neither is aspirational — scope is closed. If a change does
not serve something in Features.md, it does not belong here.

---

## Repo layout

```
src/core/     pure logic — token bucket maths, backoff, Retry-After parsing,
              the envelope types. No I/O, no timers, no ambient clock: time is
              passed in. Everything here is testable outside workerd.
src/do/       the limiter Worker: the Durable Object class and its entrypoint.
              The only place storage, alarms and in-object timers may appear.
src/client/   what consuming apps import: defineBinder, defineTestBinder,
              defineLimiter, call(). Hooks and retries live here.
test/         Vitest suites, run under @cloudflare/vitest-pool-workers.
docs/         preface.md and Features.md — the basis of the README.
```

Dependency direction is one-way: `core` imports nothing of ours; `do` and
`client` both import `core` and never each other.

Published subpaths are `./do` and `./client` only. `core` is bundled into both
and is not a public entrypoint — do not add one.

---

## Invariants

These are not preferences. Each one exists because violating it produced a
failure that ordinary testing did not catch.

### 1. Module scope stays inert

No I/O, no `setTimeout`, no `setInterval`, no `Date.now()`-driven setup at
module scope — anywhere in `src`, in either entrypoint.

Workers **rejects timers at module scope**, and the failure appears only at
deploy. Local development and the test suite both pass. This is exactly what
sank the predecessor package: its constructor started an interval, so a
module-scope singleton could not be constructed at all.

`defineBinder` and `defineLimiter` must therefore be pure config-capture
functions returning inert objects. The rule consumers are given is:

> Define at module scope. Bind and call inside a request handler.

That promise only holds if every code path reachable from module evaluation is
free of side effects. When adding a top-level `const`, ask what its initialiser
does.

### 2. Hooks run client-side; the object never sees a `Response`

`rateLimit` and `error` hooks are per-call and execute in the caller's isolate.
The Durable Object receives a small summary — never a `Response`, never a body,
never headers it must parse.

This is what keeps the limiter upstream-agnostic, keeps credentials out of the
object, and keeps multi-megabyte payloads from transiting a single-threaded
object. Any change that has the object inspect a response is a design
regression, not an optimisation.

Hooks cannot be registered on the object. Sharing behaviour across applications
is what limiter-level defaults are for; the three-layer resolution (call site →
limiter default → built-in HTTP) must keep the HTTP layer **unconditional**, so
overriding a hook for one odd endpoint never silently disables genuine 429
handling.

### 3. The wait queue is memory-only and cannot be persisted

An RPC function handle cannot be stored. There is no clever way around this —
do not add one, do not fake it with an ID table.

Consequences to preserve:

- bucket state (`{ tokens, lastRefillAt, forcedUntil }`) **is** persisted and is
  refilled from wall-clock elapsed time at read time, so eviction after 70–140
  seconds idle reconstructs the _correct_ token count rather than a full bucket;
- the queue of waiting callbacks is not, so `call()` is throwable and callers
  must retry;
- this is documented, not hidden. Keep it in the README's known-limits section.

### 4. Worst-case throughput is `capacity + fillPerWindow`

Not `fillPerWindow`. A full bucket can drain instantly and then refill over the
same window. To stay under an upstream limit `L`, sizing must satisfy
`capacity + fillPerWindow <= L`.

Any doc, default, or example that implies the rate alone bounds throughput is a
bug. Tests asserting the bound must assert the burst case, not the steady state.

### 5. 100% test coverage on everything

Lines, branches, functions, statements — thresholds are enforced in
[vitest.config.ts](vitest.config.ts) and `npm run check` fails below them.

Coverage uses **istanbul**, not V8. Native V8 coverage does not work inside
workerd; do not "fix" the config by switching provider.

New code lands with its tests. If a branch is genuinely unreachable, delete the
branch rather than adding an ignore comment.

### 6. The envelope is one definition, shared

[src/core/envelope.ts](src/core/envelope.ts) is the sole definition of what
crosses the RPC boundary, imported by both halves.

The limiter Worker and its consumers deploy on independent schedules, so version
skew between `./do` and `./client` is the live failure mode. Within a major
version: additive changes only, new fields optional with a default on the
receiving side. A breaking shape change bumps `ENVELOPE_VERSION`, which both
halves check so skew fails loudly at the first call instead of silently
mis-limiting.

### 7. Concurrency is measured, not inferred

The object `await`s the callback, which is the only reason it knows when work
_finishes_. Do not replace this with permits, leases, or handed-out timestamps —
that trades a real measurement for an approximation and loses cross-caller
backpressure with it.

### 8. Idle limiters cost nothing

No timer exists unless a caller is waiting. One timer serves the whole queue,
sized to the exact deficit, cleared when the queue drains. A pending timer
prevents hibernation, so a stray `setTimeout` bills duration around the clock on
an otherwise quiet object.

---

## Commands

| Command                               | What it does                                                         |
| ------------------------------------- | -------------------------------------------------------------------- |
| `npm run check`                       | typecheck + lint + format check + coverage. Run before every commit. |
| `npm test`                            | Vitest under workerd                                                 |
| `npm run coverage`                    | Vitest with istanbul coverage and 100% thresholds                    |
| `npm run build`                       | tsup → `dist/do.*`, `dist/client.*`                                  |
| `npm run lint:fix` / `npm run format` | autofix                                                              |

`wrangler.jsonc` exists for tests and local dev only. Consumers deploy their own
limiter Worker and declare the binding in their own config.

---

## Current state

`src/core/`, `src/do/` and `src/client/` are written and at 100% coverage.

[test/integration.test.ts](test/integration.test.ts) runs the two halves
together inside workerd — the real client resolving the real binding — and pins
the properties neither half can demonstrate alone: the closure running in the
caller's isolate, a megabyte staying caller-side, peak overlap under the
concurrency cap, one caller's 429 delaying another that never saw it, a
body-encoded rate limit pausing the shared bucket where a body-encoded error
does not, and a lost wait queue rejecting rather than hanging. The unit suites
stay where they are; this one is about the pair. Timing note: `maxDelayInMs`
clamps a `Retry-After` as well as the backoff, so a low ceiling makes penalties
expire before an assertion can see them.

The failure contract is closed in both halves. The layering it settled is worth
keeping: **`src/core/scheduler.ts` knows nothing about `CallReport`**. The core
speaks `ResultVerdict` — `{ isRateLimited, failed, retryable, message }` — and
`createEnvelopeClassifier` in `src/do/limiter-do.ts` is the one place
`report.failure` is read and mapped onto it. A non-retryable failure rejects
with `CallFailedError`; a retryable one retries and then rejects. A rate limit
outranks both, because a 429 is a rate limit first. `envelopeRetryDelay` prefers
`retryAfterMs` over the raw `Retry-After`, and stays pure — backpressure lives
on the rate-limited branch of the scheduler and nowhere else.

The following two were measured during the DO work and both contradict what the
design notes assumed. They shaped the client half and must survive any change
to it:

### RPC erases generics even when inferred from an argument

`DurableObjectStub<LimiterDO>['execute']` resolves to **`never`**, not to
`Promise<T>`, and the same happens through a service binding. `never` is
assignable to everything, so nothing errors at the call site — type checking
just silently stops.

`src/do/entrypoint.ts` declares `LimiterRpc` and `LimiterService` for this, and
`src/client/binder.ts` declares `LimiterStub`: the generic surface written out
by hand, applied once where a stub is obtained — `stubFrom` on the client side
is the single assertion. Consumers type their service binding as
`LimiterService`. Do not let a raw stub type reach a call site.

### A thrown error loses its properties crossing RPC

Workers RPC reconstructs a thrown error from name/message/stack only. A `status`
a caller attaches to an `Error` does **not** arrive, so `dontRetry`
classification on the error path can never fire over RPC and every throw looks
transient to the object.

The envelope is therefore the whole contract: a failure a caller wants treated
as final has to be _reported_ as `{ value, status }`, not thrown. The client
half must convert responses into envelopes rather than throwing on non-2xx, and
the README must say so.

### Test-pool note

`isolatedStorage` is off in [vitest.config.ts](vitest.config.ts). Write-through
persistence is deliberately fire-and-forget, so a storage write can still be in
flight when a test ends, and the pool then fails popping its storage stack.
Tests take a distinct limiter name each instead, which is the isolation
`idFromName` already provides. One consequence: global timer spies also see the
runner's own timers, so assert on a synchronous window and unspy before
awaiting.
