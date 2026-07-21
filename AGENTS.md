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

Scaffold only. `src/do/rate-limiter.ts` is a placeholder class carrying no
limiter logic — it exists so wrangler can resolve the binding and the test pool
can back it with a real local Durable Object. The bucket, the queue, the RPC
surface, the client and the hooks are all still to be written.
