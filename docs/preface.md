# Preface
A shared rate limiter and concurrency gate for Cloudflare Workers, backed by a
Durable Object.

## The problem

Rate limiting is a per-process concern in most libraries: a token bucket lives
in memory, the code that calls the API asks it for permission, and everything
works as long as there is exactly one process.

On Workers there is never exactly one process. A Worker runs in many isolates
across many locations; a Workflow spawns instances that neither know nor can
reach each other; a cron tick and a user request can fire simultaneously. Each
of them constructs its own in-memory bucket, each politely paces itself to the
configured rate, and collectively they exceed the upstream quota by however many
isolates happen to be warm. The limiter is locally correct and globally useless.

The same problem appears one level up: several *applications* sharing one API
key have no way to coordinate at all.

## Why an in-process caller cannot be ported

The natural instinct is to take an existing in-process caller — a token bucket
plus a retry loop, driven by `setTimeout` — and run it on Workers. It does not
work, for two independent reasons.

**Timers are not allowed where the state would have to live.** Workers forbids
`setTimeout`/`setInterval` at module scope, which is the only place a shared
singleton could sit. An interval-driven bucket constructed there fails on
deploy — and only on deploy, never in local development. Even inside a request,
a pending timer prevents a Durable Object from hibernating, so a "quiet"
limiter accrues duration charges around the clock.

**In-memory window state is destroyed constantly.** An isolate is discarded
between requests; a Durable Object is evicted from memory after 70–140 seconds
of inactivity and its constructor re-runs on the next request. An in-memory
usage count therefore resets to an empty window on every cold start, handing out
a fresh full allowance against someone else's quota precisely when traffic has
just resumed. For a limiter enforcing a third-party limit that is not a
performance wobble; it is a correctness failure.

So the window has to be **state-driven rather than event-driven** — its usage
read from a persisted `{grants, forcedUntil}` log, one grant per take, pruned
against the wall clock at read time — and it has to live somewhere with
identity and durable storage. On Cloudflare that means a Durable Object: the
only primitive that guarantees a single instance serialising all callers
against one piece of state.

## The mechanism

The interesting decision is what a caller sends.

A conventional gateway would proxy: the caller hands over a URL, headers and a
body, the gateway performs the request when the limit allows, and returns the
response. That forces every byte through a single-threaded object, requires the
gateway to hold credentials, and makes it specific to each upstream's auth and
error conventions.

This package sends a **function** instead.

```ts
await limiter.call(() => fetch(url, init), { read: (res) => res.json() });
```

Workers RPC does not serialise functions. It leaves the function where it is and
passes a handle; when the recipient invokes that handle, the call travels *back*
to the originating isolate. The Durable Object therefore decides **when** the
work runs, while the work itself runs **in the caller**.

Everything else follows from that inversion:

- **Payloads never transit the object.** A multi-megabyte download happens in
  the caller's isolate. The object sees only a small summary.
- **No credentials cross.** The caller builds its own headers. The limiter is
  upstream-agnostic and holds no secrets.
- **It is enforcement, not cooperation.** The object controls the moment of
  execution, so a caller cannot fire early no matter what it intends.
- **Concurrency is genuinely measurable.** Because the object awaits the
  callback, it knows when work *finishes*, not merely when it started — which a
  design that hands out timestamps or permits can never know.
- **One caller's rate-limit response throttles all of them.** The return value
  passes back through the object, so a 429 is observed centrally and applies
  backpressure to every other caller and every queued caller automatically, with
  no reporting protocol for a client to forget to implement.

## What the caller is doing while it waits

Waiting. The call is a normal `await` that may take minutes.

This is cheaper than it sounds. Workers bills CPU time, and a request awaiting
I/O consumes none. Durable Object duration is billed per object, shared across
all requests active on it at once — so a hundred parked callers cost what one
costs. And there is no hard wall-clock limit on a request while the caller stays
connected.

A callback parked for **23 minutes** in production still fired, with no drops
across a hundred calls from ten independent Workflow instances. See the deployed
verification harness in `verify/`.

## What it is not

It is not a proxy, a queue, or a job scheduler. It holds no work of its own,
persists no requests, and cannot retry anything after its caller has gone away.
If the caller disconnects, its pending call disappears with it — by design, the
caller owns the work and the limiter owns only the timing.

It is also not durable across its own eviction in one specific respect: bucket
state is persisted, but the queue of waiting callbacks is memory-only and cannot
be otherwise, because an RPC function handle cannot be stored for later use.
Callers must treat a call as throwable and retry.
