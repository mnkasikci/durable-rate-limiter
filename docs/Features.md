# Features

Settled scope for the package. Written to be the basis of the
project README.

---

## Global rate limiting that actually holds

One token bucket in a Durable Object, shared by every isolate, every Workflow
instance, every cron tick, and every application bound to it. In-process
limiters give each isolate its own bucket — each politely correct, collectively
over quota by however many isolates are warm. This gives one bucket, full stop.

Worst-case throughput in any window is `capacity + fillPerWindow`. To stay under
an upstream limit `L`, size so that `capacity + fillPerWindow <= L`.

## Real concurrency limiting

A cap on calls actually in flight — not an approximation derived from rate.
Because the object awaits the callback, it knows when work *finishes*, which a
design handing out timestamps or permits cannot know. Measured holding at
exactly the configured value under variable production latency.

## Your code runs in your isolate

`call()` takes a function, not a request. Workers RPC passes a handle rather
than serialising, so the object decides *when* and your code runs *where it was
written*.

- multi-megabyte responses never transit the object
- no credentials cross the boundary
- the limiter is upstream-agnostic — it parses nothing
- callers cannot fire early; timing is enforced, not requested

## Cross-caller backpressure

A rate-limit response seen by one caller pauses the shared bucket for all of
them — including callers already queued, in other isolates, in other
applications. No reporting protocol, no cooperation required, nothing for a
consumer to forget to implement.

`Retry-After` is honoured in both documented forms (integer seconds and HTTP
date) and from both header shapes (`Headers` object and plain object). Where a
delay must be inferred instead, exponential backoff clamped to a maximum.

Concurrent penalties do not stack — the deadline is the maximum of existing and
new, so three simultaneous `5s / 60s / 5s` responses wait 60 seconds, not 5.

## Rate limits and errors hidden in response bodies

Not every API says 429. Two optional hooks handle the ones that don't:

| Hook | Non-null result means | Scope |
|---|---|---|
| `rateLimit` | treat exactly as an HTTP 429 with this delay | **global** — pauses every caller |
| `error` | the call failed; `retryable` decides whether to try again | **local** — retries this call only |

Both resolve in three chained layers — call site, then limiter default, then
built-in HTTP — each falling through on `null`. The HTTP layer is
unconditional, so overriding a hook for one odd endpoint never silently
disables genuine 429 handling there.

Defaults live on the limiter definition, so an API's convention is written once
and reused across every call site.

## Retries with correct 4xx handling

Client errors are not retried; 429 is. Exponential backoff with a configurable
floor, ceiling and factor, and partial options merged with defaults rather than
replacing them wholesale.

## Dropped callers are retried for you

The object's wait queue is memory-only — an RPC function handle cannot be
persisted — so a caller parked in it is dropped if the object is evicted, reset
or redeployed. Measured across four runs against a real deployment: **7 of 290
calls (2.4%, 95% CI 1.2–4.9%)**, every one of them dropped *while parked*, at
waits from 47 s to 8.8 min.

At that rate an application that does not retry loses calls in normal
operation, so the client retries by default — five times, so a call must be
dropped six separate times to fail — rather than asking every consumer to write
the same wrapper. No observed call has been dropped more than once. The decision is exact rather than heuristic: the
callback runs in *your* isolate, so the client knows whether it ever fired. It
never did → no request reached the upstream → retrying cannot duplicate
anything. It did → the call is left alone, because a connection lost after the
request went out is genuinely ambiguous and guessing could send a payment
twice.

That makes the retry safe even for non-idempotent work. It is bounded
(`dropRetries`, default 5), it takes a fresh handle because the old one is what
broke, and it adds no backoff of its own — a retry must re-acquire a token, so
the bucket's pacing is already the wait, which also spreads the attempts out in
time rather than firing them all into one bad window. Once the attempts are spent the call
rejects with `CallDroppedError`, carrying the attempt count and the original
transport message.

Every drop is reported to `onDrop`, retried or not, because a silent retry is
one nobody can size — and the rate is a property of *your* deployment's object
churn, not of this package's measurements:

```ts
export const apiLimiter = defineLimiter({
  binder,
  name: 'example-api',
  onDrop: ({ limiter, attempt, willRetry, error }) =>
    console.warn(`drop ${limiter} attempt=${attempt} retrying=${String(willRetry)}: ${error.message}`),
});
```

## Survives eviction without a burst

Bucket state is a persisted `{ tokens, lastRefillAt, forcedUntil }` triple,
refilled from wall-clock elapsed time when read. A Durable Object evicted after
70–140 seconds idle reconstructs at the *correct* token count — not at full
capacity, which is what an in-memory counter does, precisely when traffic
resumes.

## Idle limiters cost nothing

No timer exists unless a caller is waiting; one timer serves the whole queue,
sized to the exact deficit, cleared when the queue drains. An idle object
hibernates.

Held callers are cheap by the platform's own cost model: duration is shared
across all requests active on an object at once, so a hundred parked callers
cost what one costs, and a request awaiting I/O burns no CPU.

## Many limiters, one deployment

Instances are addressed by name, so `example-api`, `billing-api` and
`search-api` are independent buckets on one class and one binding. `defineBinder` is declared
once and reused.

## Typechecked bindings

`defineBinder` is constrained to keys of your generated `Env` that are actually
Durable Object namespaces. A typo fails to compile; so does pointing at a KV or
D1 binding. Zero runtime cost.

A runtime presence check at bind time covers consumers who haven't generated
types, naming the available bindings in the error.

## Testable without magic

Under `@cloudflare/vitest-pool-workers` the real binding exists and is backed by
a local Durable Object — most tests need no seam. For unit tests outside
workerd, `defineTestBinder` injects a namespace directly and returns the same
type, so the module under test is unchanged.

No allowlisted magic names. The injection point is explicit and discoverable.

## Safe at module scope

`defineBinder` and `defineLimiter` perform no I/O and start no timers, so a
configured limiter can be exported as a module-scope singleton. The predecessor
package could not be — its constructor started an interval, and Workers rejects
timers at module scope with a failure that appears only at deploy.

> Define at module scope. Bind and call inside a request handler.

## Observable

`stats()` returns live token count, penalty state, and the raw persisted triple.
A shared limiter nobody can inspect is a shared limiter nobody will trust.

---

## Known limits — stated, not buried

- **The wait queue is memory-only.** An RPC function handle cannot be persisted,
  so queued callbacks do not survive object eviction — measured at 2.4% of
  calls under load. The client retries this for you when the callback never
  ran (see above), but the retry is bounded: `call()` is still throwable, now
  with `CallDroppedError`, and a caller that must not lose work needs its own
  durable retry above this one. **No compounded failure probability is
  published**, because the drop rate is measured from a small sample and the
  events are not independent — a redeploy drops every parked caller at once.
  Measure yours with `onDrop`.
- **A drop after the callback started is never retried automatically.** It
  cannot be distinguished from a completed upstream request, so it is left to
  you. Make such calls idempotent, or reconcile them.
- **`fn` is re-invoked on retry** and must build a fresh request each time. A
  closure over an already-consumed body fails on the second attempt.
- **The limiter holds no work.** If a caller disconnects, its pending call goes
  with it. This is not a queue or a job runner.
- **Hooks are per-call, client-side.** They cannot be registered once on the
  object; sharing them across applications is what this package is for.
