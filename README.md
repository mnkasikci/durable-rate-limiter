# @bakidev/durable-rate-limiter

A shared rate limiter and concurrency gate for Cloudflare Workers, backed by a
Durable Object.

One token bucket, shared by every isolate, every Workflow instance, every cron
tick and every application bound to it. `call()` takes a function rather than a
request, so the object decides _when_ the work runs while the work itself runs
in the caller's isolate — payloads never transit the object and no credentials
cross the boundary.

> **Status: implemented, unpublished.** `src/` and `test/` are complete; nothing
> is published to npm yet, and the production claims below still want a
> [deployed verification run](#deployed-verification).

## Documentation

- [docs/preface.md](docs/preface.md) — what this is, and why a Durable Object is
  required rather than an in-process limiter.
- [docs/Features.md](docs/Features.md) — the settled feature scope, including
  the known limits.
- [AGENTS.md](AGENTS.md) — invariants and repo layout for contributors.

## Install

```sh
npm install @bakidev/durable-rate-limiter
```

Two subpath exports:

```ts
import { LimiterDO, LimiterEntrypoint } from '@bakidev/durable-rate-limiter/do';
import {
  defineBinder,
  defineLimiter,
} from '@bakidev/durable-rate-limiter/client';
```

`./do` is re-exported by the limiter Worker you deploy. `./client` is what
consuming applications import. Both are built from one shared envelope
definition so the halves cannot drift.

## Dropped callers, and why the package retries them

The object's wait queue is memory-only — an RPC function handle cannot be
persisted, so a queue of them cannot be written to storage. A caller parked in
that queue holds an open RPC connection, and if the object is evicted, reset or
redeployed while it waits, the connection breaks and the call rejects with a
transport error.

Measured against a real deployment with the harness below, across four runs of
ten Workflow instances stampeding one bucket: **7 of 290 calls, 2.4%** (95% CI
1.2–4.9%). Every one was dropped _while parked_; none died once its callback had
started. The waits at the moment of the drop ran from 47 s to 8.8 min and did
not cluster at the long end, so this is not a duration ceiling — it reads as
eviction or restart landing on whoever happens to be queued.

At that rate, "callers must retry" is not a footnote. The client retries it, up
to five times, so a call has to be dropped **six separate times** to fail. In
the run made after this shipped, both drops recovered on their first retry and
the run finished with zero failures:

```
succeeded                 95
failed                    0
dropped while parked      2 drops across 2 calls
  of those, recovered     2 by the client's own retry
  drop rate               2.1% of calls were dropped at least once
```

```ts
const limiter = defineLimiter({
  binder,
  name: 'google-docs',
  dropRetries: 5, // the default; 0 opts out
  onDrop: ({ limiter, attempt, willRetry, error }) =>
    metrics.increment('limiter.drop', { limiter, willRetry }),
});
```

**Why this is safe even for non-idempotent work.** The retry fires on exactly
one condition: the callback never ran. That is knowable rather than guessed,
because the callback runs in your isolate — if it never fired, no request
reached the upstream and there is nothing to duplicate. A connection lost
_after_ the callback started is never retried for you; that case is genuinely
ambiguous, and deciding it on your behalf could send a payment twice. It
propagates unchanged, for you to make idempotent or reconcile.

The retry takes a fresh stub, because the handle whose connection just broke
would otherwise repeat the failure instantly. It adds no backoff — a retry must
re-acquire a token before it runs, so the bucket's own pacing is already the
wait. When the attempts are spent the call rejects with `CallDroppedError`,
which carries `attempts`, `limiter` and the original transport message as
`cause`. Unlike the errors thrown inside the object, this one never crosses an
RPC boundary, so its properties actually survive to be read.

`onDrop` fires on **every** drop, retried or not. The drop rate is a property
of your deployment — object churn, redeploy cadence, how long your callers park
— not of the measurements above, so it has to be observable in production
rather than assumed.

### Why this page quotes no failure probability

Six attempts at a 2.4% drop rate multiplies out to something around one in ten
billion, and that figure would be worth very little. Two things break it:

- **The base rate is uncertain.** 7 of 290 is a small sample. The real rate is
  somewhere in 1.2–4.9%, and compounding an uncertain number amplifies the
  uncertainty — across that interval the six-attempt result spans a factor of
  5 000. A single number would be false precision presented as a guarantee.
- **The events are not independent.** Drops come from eviction, reset and
  redeploy, and a redeploy drops _every_ parked caller at once — then their
  retries re-queue into the same window. No run has yet produced a call dropped
  twice, so the probability of a second drop given a first is unmeasured, and
  that is precisely the quantity the exponent assumes.

What is safe to say: a call must be dropped six times to fail, no observed call
was dropped more than once, and the retries are naturally spread out under load
because each one has to re-acquire a token before it runs. Beyond about five
retries the residual risk is dominated by correlated failures that more
attempts cannot fix, while the costs stay real — every attempt consumes a token
before it runs, so a retry storm spends upstream quota doing nothing. Measure
your own rate with `onDrop`; that is the number that should inform your
`dropRetries`.

## Deployed verification

The claims this package makes are about production behaviour — that a parked
callback survives tens of minutes, that concurrency is enforced exactly, that a
429 seen by one caller throttles every other one. None of that can be
established locally: Miniflare does not enforce invocation accounting or quota
behaviour, so a local run proves the logic and nothing about the limits.

[`verify/`](verify/) is a reproducible harness for measuring it against a real
deployment: two Workers, a Durable Object, and N Workflow instances that all
sleep until one shared timestamp and then stampede, so the load is genuinely
concurrent across isolates rather than sequential. It produces a plain-text
report designed to be pasted back verbatim. See
[verify/README.md](verify/README.md) for what each route measures.

**It costs money to run** — Workflows, Durable Object wall time, and a run that
parks callers for twenty minutes parks them for twenty minutes. Deploy it,
measure, `wrangler delete` both Workers.

In order, from the repository root:

```sh
# 1. Build. The harness imports from dist/, not src/ — it verifies the
#    artifact that gets published, and dist/ is gitignored.
npm install
npm run build
npm run verify:typecheck

# 2. Deploy the limiter Worker FIRST. The consumer binds it by name, both as a
#    service and cross-script, and neither binding can be created before the
#    Worker it names exists.
npx wrangler deploy --config verify/limiter/wrangler.jsonc

# 3. Deploy the consumer, then set the shared secret. The routes spawn
#    Workflows and are internet-facing; an unset PROBE_KEY denies everything.
npx wrangler deploy --config verify/consumer/wrangler.jsonc
npx wrangler secret put PROBE_KEY --config verify/consumer/wrangler.jsonc

# 4. Note the consumer's workers.dev URL from step 3, and export both:
export VERIFY_URL=https://drl-verify-consumer.<your-subdomain>.workers.dev
export PROBE_KEY=<the value you just set>
```

Then run the probes. Each is independent; `&via=direct` swaps the two-hop
service binding for the one-hop cross-script Durable Object binding, and every
route accepts it.

```sh
# Both halves up, and agreed on the envelope version.
curl "$VERIFY_URL/ping?key=$PROBE_KEY"

# A closure crosses the RPC boundary and runs in the calling isolate.
curl "$VERIFY_URL/closure-check?key=$PROBE_KEY"
curl "$VERIFY_URL/closure-check?key=$PROBE_KEY&via=direct"

# The shipped client stack end to end: read(), the hooks, the envelope.
curl "$VERIFY_URL/client-path?key=$PROBE_KEY"

# Where the per-request invocation ceiling bites, on each topology.
curl "$VERIFY_URL/cap-probe?key=$PROBE_KEY&max=64"
curl "$VERIFY_URL/cap-probe?key=$PROBE_KEY&max=64&via=direct"

# The load run: 10 Workflow instances x 10 calls, all stampeding 60s from now
# at 10/min with a burst of 5 — a ~10 minute drain, so the last caller parks
# well past the six-minute mark the design hinges on. Prints its probe id.
curl "$VERIFY_URL/start?key=$PROBE_KEY&instances=10&callsPerInstance=10&capacity=5&fillPerWindow=10&concurrency=5&holdMs=500&delaySeconds=60"


# Record the probe id from the first line of the response(probe started <probeid>)
export PROBE_ID=<probe id from the response>

# Read the report — safe to read early, it says so when it is incomplete.
curl "$VERIFY_URL/report/$PROBE_ID?key=$PROBE_KEY"
```

Backpressure needs its own run, because it is the one behaviour that only shows
up when a rate-limit response is actually observed:

```sh
# Every instance answers 429 once, with Retry-After: 30. Ten such responses
# stretch a ~10 minute workload well past 25 minutes without losing a call.
curl "$VERIFY_URL/start?key=$PROBE_KEY&instances=10&callsPerInstance=10&simulate429OnCall=3&retryAfterSeconds=30"
```

Tear down when finished:

```sh
npx wrangler delete --config verify/consumer/wrangler.jsonc
npx wrangler delete --config verify/limiter/wrangler.jsonc
```

## Development

```sh
npm install
npm run check   # typecheck + lint + format + 100% coverage
npm run build
```

## License

MIT © Nurbaki Kasikci
