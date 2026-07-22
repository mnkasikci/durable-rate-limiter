# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`ENVELOPE_VERSION` is versioned separately from the package: it is the wire
contract between `./do` and `./client`, which deploy on independent schedules.
A change to it is always a breaking change and is called out explicitly below.

## [Unreleased]

### Added

- **`listNames()`** on `LimiterDO` and `LimiterEntrypoint` — every bucket in the
  namespace, which is the one question that cannot be put to a bucket, since
  addressing one means already knowing its name. A Durable Object namespace
  cannot be enumerated: there is no `list()`, and `idFromName` does not run
  backwards, so even the REST API that lists objects returns IDs nobody can turn
  back into names. One reserved instance (`REGISTRY_NAME`) keeps the list
  instead — no second class, no second binding, no migration. A name gets into
  it on `configure`, and the changes below are what make the list trustworthy
  rather than best-effort.
- **CLI** — `stats --save` writes the live limits back over the limits file, and
  `sample` writes an example one offline. `--save` needs no existing file and no
  bucket names, because the registry supplies them: it is how you get an
  accurate limits file for a limiter you inherited, or recover one you lost. The
  sample marks itself with `"source": "sample"`, and `configure` asks before
  applying a file that still carries it — refusing outright under `--yes`, since
  nobody is there to notice invented numbers reaching a live limiter.
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
  it in `durable-rate-limiter.limits.jsonc`: they live in version control,
  change in a diff, and are uploaded by `configure`. That file is **never
  deployed and never imported** — the limits are durable state inside the
  object, and the file is the copy you keep — so retuning a limit costs one
  command and no deploy. It is JSONC rather than TypeScript precisely because a
  TypeScript file would have to be imported by the Worker, which is what made a
  limit change a code change. `init` sets the guarding secret and
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

### Changed

- **BREAKING — `configure` splits into `configure` and `reconfigure`.**
  `configure(name, config)` creates a bucket and takes a **complete** config;
  `reconfigure(patch)` adjusts one that already exists and throws if there is
  nothing to adjust. Only `configure` carries the name — a Durable Object cannot
  recover the name it was addressed by, since `ctx.id.name` is `undefined`
  inside one, and it needs one to enter the registry. A modification has nothing
  to register, so it needs none. The split puts the rule in the type system:
  an incomplete initial configuration is now unrepresentable.
- **BREAKING — `DEFAULT_LIMITER_CONFIG` is gone.** A rate limit is never
  assumed. It was not a safe default but a plausible-looking guess, and there is
  no correct value for an upstream nobody has asked about.
- **BREAKING — a bucket that was never configured does not exist.** `execute`,
  `stats` and `reconfigure` throw `LimiterNotConfiguredError`; nothing writes
  storage before `configure`, so such an object holds zero bytes and is
  indistinguishable from one that was never addressed. A limiter nobody
  configured is almost always a mistyped instance name, and the old fallback
  turned that into a second bucket pacing at an invented rate against the same
  upstream quota — invisible, and exactly the failure this package exists to
  prevent. It is also what makes `listNames()` trustworthy.
- **Creation is all-or-nothing.** Registering and configuring are writes to two
  different objects, so there is no transaction to hold them together — only a
  saga. Registration goes first, so the survivable failure is a name with no
  bucket (cosmetic) rather than a live bucket nobody can see. If the config
  write then fails on a bucket that did not previously exist, the registration
  is compensated and the object erases itself; a failed _restatement_ of an
  existing bucket changes nothing, since wiping live token state would hand out
  a full burst. Any name that slips through regardless is pruned the next time
  `stats` walks the list, and a bucket missing from the list re-adds itself from
  its own persisted name — so the registry converges from both directions.
- `stats()` now reports the `name` it was configured under, read from storage
  because the object's own ID carries none.
- **`NoSuchLimiterError`** on `./client`, thrown by `call()` when the bucket
  does not exist. It used to surface as a `CallDroppedError` after six pointless
  retries, because the client treats any rejection that arrives before the
  callback fired as a caller dropped in transit — true of a broken connection,
  and wrong for a limiter that will never exist however many times you ask. The
  six phantom `onDrop` events were the worse half: that hook exists so an
  operator can size their _real_ drop rate, and a single mistyped instance name
  was poisoning the only number available for it.
- **`NO_SUCH_LIMITER` and `isNoSuchLimiter`** on the shared envelope contract,
  which is how the client tells those two apart. Measured, not assumed: an error
  thrown inside a Durable Object reaches the caller as a plain `Error` with
  `name === 'Error'` and every custom property stripped — `instanceof` and
  `.name` are both useless across the hop, so the marker is written into the
  message explicitly. It lives beside `ENVELOPE_VERSION` because it is a wire
  contract, and it does not lean on the runtime folding the class name into the
  message, which is undocumented behaviour. Skew degrades safely in both
  directions.
- **CLI** — `configure` no longer offers to deploy. It never needed to; the
  offer existed only because the limits used to be compiled into the Worker. If
  a Worker deployed before this change ignores an upload, `configure` says so
  and asks for one redeploy rather than reporting a success that did not happen.

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
