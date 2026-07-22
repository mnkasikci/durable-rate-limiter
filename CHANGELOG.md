# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`ENVELOPE_VERSION` is versioned separately from the package: it is the wire
contract between `./do` and `./client`, which deploy on independent schedules.
A change to it is always a breaking change and is called out explicitly below.

## [Unreleased]

### Added

- **CLI** — `npx @bakidev/durable-rate-limiter init` walks the README's five
  setup steps interactively: scaffolds the limiter Worker and offers to deploy
  it, inserts the binding into an existing wrangler config (by textual
  insertion, so comments survive), writes the limiter module with the instance
  name in exactly one place, and sizes the bucket so that
  `capacity + fillPerWindow` fits under the upstream limit rather than
  `fillPerWindow` alone. Both topologies are supported. `--yes` takes every
  default and never deploys. No runtime dependencies.
- **CLI** — `configure` and `stats`. `configure` is a method on the Durable
  Object, so only a deployed Worker can call it and no `wrangler` command
  reaches one. `init` therefore offers to scaffold the limiter Worker with a
  key-guarded `/configure` and `/stats` route, and to declare the limits beside
  it in `limits.ts`: they live in version control, change in a diff, and are
  applied by `configure` after a deploy. `init` sets the guarding secret and
  applies them itself, so the bucket is live before it exits. Both routes deny
  everything while `DRL_CONFIG_KEY` is unset — one name for the Worker secret
  and the environment variable the CLI reads, so the two are recognisably the
  same thing wherever they are seen. Both `init` and `configure` say how to
  replace a key you no longer have, since a secret cannot be read back.
  Declining the route falls back to a generated `configureLimiter(env)` module. `init` records what it built in
  `.durable-rate-limiter.jsonc` **inside the limiter's own folder**, so a
  consuming project gains one directory and no root dotfile; the file carries a
  comment saying what deleting it breaks, holds no secrets, and stores every
  path relative to itself. `configure` and `stats` find it from anywhere in the
  project and never climb past a repository root.

## [0.1.0] — 2026-07-21

First public release. `ENVELOPE_VERSION` 1.

### Added

- **`./do`** — `LimiterDO`, a Durable Object holding one token bucket, a
  concurrency gate and a retry loop for one named upstream. Addressed by
  `idFromName`, so many independent limiters share one class and one binding.
  Bucket state is the persisted `{ tokens, lastRefillAt, forcedUntil }` triple,
  refilled from wall-clock elapsed time at read time, so eviction does not
  reconstruct a full burst.
- **`./do`** — `LimiterEntrypoint`, a named `WorkerEntrypoint` giving consumers
  a declared RPC interface (`execute`, `configure`, `stats`, `ping`) rather than
  a direct dependency on the object's class name.
- **`./client`** — `defineBinder`, `defineLimiter`, and `.for(env)` returning a
  bound `call(fn, options)`. `call()` takes a function, not a request: Workers
  RPC passes a handle, so the object decides _when_ the work runs while the work
  itself runs in the caller's isolate. Payloads and credentials never cross.
- **`./client`** — the `rateLimit` and `error` hooks, resolved in three chained
  layers (call site → limiter default → built-in HTTP), with the HTTP layer
  unconditional so a per-endpoint override cannot silently disable genuine 429
  handling.
- **Cross-caller backpressure.** A rate-limit response observed by any caller
  pauses the shared bucket for every other caller and every queued caller.
  `Retry-After` is honoured as integer seconds and as an HTTP date, from both a
  `Headers` object and a plain object. Concurrent penalties take the maximum
  deadline rather than the first.
- **Automatic retry of dropped callers.** The object's wait queue is memory-only
  and a parked caller can be dropped — measured at 2.4% of calls under
  production load. The client retries when the callback never ran (five times by
  default, `dropRetries`), which is safe even for non-idempotent work because a
  callback that never fired made no upstream request. Exhausted attempts reject
  with `CallDroppedError`; every drop is reported to `onDrop`, retried or not.
- **`defineTestBinder`** — an explicit, typed injection point for unit tests
  outside workerd. No allowlisted magic binding names.
- **`stats()`** — live token count, penalty state, in-flight count and the raw
  persisted triple.
- **`ping()` / `ENVELOPE_VERSION`** — so skew between the independently deployed
  halves fails loudly instead of mis-limiting silently.

### Notes

- Worst-case throughput is `capacity + fillPerWindow`, not `fillPerWindow`. Size
  so that `capacity + fillPerWindow <= L` for an upstream limit `L`.
- The default config (`capacity: 10`, `fillPerWindow: 50`, `windowInMs: 60_000`,
  `concurrency: 5`) has a true worst case of exactly 60 calls a minute.
- `defineBinder` and `defineLimiter` are inert, so a configured limiter is safe
  as a module-scope singleton.

[unreleased]: https://github.com/mnkasikci/durable-rate-limiter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mnkasikci/durable-rate-limiter/releases/tag/v0.1.0
