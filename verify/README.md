# Deployed verification harness

The deploy and run commands live in the [root README](../README.md#deployed-verification).
This file is what the harness measures, and why it is shaped the way it is.

> **Local emulation does not reproduce the platform limits.** Miniflare does
> not appear to enforce invocation accounting, so a local run of `/cap-probe`
> reaches its maximum for reasons that have nothing to do with the ceiling it
> is looking for. Every number here means something only against a real
> deployment. Local tests are for logic; they are not for limits.

## Shape

Two Workers, deployed separately, because the platform requires it:

```
drl-verify-limiter     implements LimiterDO + LimiterEntrypoint
   ^                   (re-exports the package, contains no logic of its own)
   |
   |  service binding  env.LIMITER   → LimiterEntrypoint   two hops
   |  script_name      env.RATE_LIMITER → LimiterDO        one hop
   |
drl-verify-consumer    routes, the probe Workflow, the collector DO
```

The limiter gets a Worker of its own because a Worker implementing a Durable
Object gets no preview URLs, and because a new DO migration cannot be uploaded
as a version — only deployed, atomically. The consumer merely _binds_ the
class, so neither constraint reaches it.

Both topologies are exercised by every route via `&via=service|direct`. The
entrypoint is the package's default and the cross-script binding is its
documented escape hatch; a finding that only held for one of them would not be
a finding about the package.

## Why Workflows

`/start` creates N Workflow instances, each handed the **same** `startAtMs`,
each calling `step.sleepUntil` on it. `sleepUntil` hibernates, so lining up ten
instances costs nothing and they arrive at one instant — separate isolates,
separate execution contexts, separate machines.

That matters because a sequential script cannot distinguish a limiter that
works from one that does nothing at all. Contention is the entire subject.

Calls inside an instance are spread across several `step.do`s (`callsPerStep`)
so that if a per-request invocation ceiling is ever hit, it is hit by
`/cap-probe` deliberately rather than here, where it would masquerade as "the
long park failed". Those steps run with `retries: { limit: 0 }` and a 30 minute
timeout: a failure **is** the finding, and a silent retry would erase it.

## Why a Durable Object for results

Probe instances finish at unpredictable times and the report is read
immediately afterwards. Under KV's eventual consistency a write that has not
propagated yet is indistinguishable from an instance that died — and "N of N
reported" is the one number the harness must be able to state precisely. Each
instance writes its own key, so concurrent writers never read-modify-write over
each other. It also removes a setup step: no namespace id to create and paste.

## Routes

All require `?key=<PROBE_KEY>`; all accept `&via=service|direct`.

`/ping`, `/closure-check` and `/client-path` end in a `VERDICT: PASS|FAIL` line
and, where there is more than one assertion, mark each one — a route that makes
the reader work out whether it passed is a route whose result gets misreported.
`/cap-probe` deliberately has no verdict: it locates a ceiling, and not reaching
one at `&max=` is not a pass, it only raises the floor.

| Route            | Measures                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ping`          | Both halves deployed, and agreed on `ENVELOPE_VERSION`. The two deploy on independent schedules; skew otherwise shows up as silent mis-limiting.                           |
| `/closure-check` | That a function passed over RPC is not serialised but handed back as a handle — verified by mutating a variable that exists only in the caller's heap.                     |
| `/client-path`   | The shipped client stack end to end: `read()` extracting an id while a 4 KB body stays local, and a failure reported as envelope _data_ rejecting with its message intact. |
| `/cap-probe`     | Sequential `execute()` calls inside one request, `&max=` to raise the ceiling. "none" locates nothing — it only raises the floor.                                          |
| `/start`         | The load run. Returns a probe id.                                                                                                                                          |
| `/report/:id`    | The plain-text report.                                                                                                                                                     |

## The report

Plain text, fixed width, no markup — written to be pasted back verbatim,
because a report that has to be interpreted before it can be quoted gets
summarised instead, and the summary is where the interesting result goes
missing. It covers, in order:

1. **Longest park** — plus p95, median and shortest, over successful calls.
   Measured caller-side: `ranAt - requestedAt`, where `ranAt` is when the
   callback actually fired inside the caller's own isolate.
2. **Failures by kind** — grouped by `name: message`, commonest first, and
   within each kind split by where the call died: **parked** (the callback
   never fired, so the caller was dropped while waiting its turn) or **in
   flight**. That split is the point. A `Network connection lost` on a caller
   parked four minutes is the memory-only wait queue losing it — the design's
   one acknowledged failure mode, and the reason the client retries. The same
   message on a call that had already started is an unrelated blip. Dropped
   callers also report how long they had been waiting, and which instances were
   hit. This section now counts only drops the retry could **not** save; the
   ones it did are in COMPLETION.
3. **Achieved vs configured rate** — the peak number of calls started inside
   any rolling `windowInMs`, against both `fillPerWindow` and
   `capacity + fillPerWindow`. A sliding window rather than fixed buckets: a
   fixed boundary can split a burst in half and report a rate the upstream
   never saw.
4. **Peak concurrency** — maximum overlap of caller-side work, from a sweep
   over start/end events.
5. **Final limiter state** — tokens, penalty, active count, the raw persisted
   triple, and the config actually in effect.

COMPLETION additionally reports **drops the client absorbed** — total drops,
how many calls were hit, how many recovered, and the drop rate. Without that
the harness would have stopped measuring the thing it was built for the moment
the retry shipped: a recovered drop looks exactly like a plain success.

Plus a timeline of the first and last eight calls by run time.

Every timestamp is relative to the shared stampede instant, so records from
instances on different machines are comparable without trusting their clocks to
agree on an absolute epoch any better than they agree on elapsed time.

Reading `/report/:id` before the run finishes is fine and expected — it says
`INCOMPLETE` and names how many instances have reported.

### Two numbers that surprise people

**Peak rate exceeds `fillPerWindow`.** A bucket configured at 10 per 60 000 ms
with a burst of 5 delivers 15 calls in the first rolling minute. That is
correct token-bucket behaviour — the burst is spent immediately, then the
sustained rate refills on top of it — but it is not what the configuration
reads like. To stay under an upstream limit `L`, size so that
`capacity + fillPerWindow <= L`. The report prints both numbers next to each
other for exactly this reason.

**Backpressure compounds.** With `&simulate429OnCall=`, one caller's 429 pauses
the shared bucket for every other caller and everyone queued behind them, with
no participation from any of them. Ten such responses carrying
`Retry-After: 30` stretch a workload that drains in ~10 minutes out past 25 —
the recovery curve is steeper than the sum of the individual delays suggests,
because sequential penalties stack.

### What this harness changed in the package

Four runs of ten instances dropped 7 of 290 calls, 2.4% (95% CI 1.2–4.9%),
**all of them while parked** — the memory-only wait queue losing callers, at
waits from 47 s to 8.8 min with no clustering at the long end. That is frequent
enough that leaving the retry to consumers would mean every consumer writing
the same wrapper, and the ones who forgot silently losing calls.

So the client now retries a caller that was dropped before its callback ran
(`dropRetries`, `onDrop`, `CallDroppedError` — see the root README). The
parked-vs-in-flight split in section 2 of the report is what made that decision
safe to take: had drops been happening _after_ callbacks fired, an automatic
retry could have duplicated upstream requests, and the correct change would
have been a documented warning instead.

The run made after that change is what confirmed it under real object churn
rather than a test double: 2 drops, **both recovered**, zero failures, and the
longest park of any run so far — 8.90 min — belonging to one of the recovered
calls. The default is five retries, so a call must be dropped six separate
times to fail; no observed call has been dropped more than once.

The drop rate is also why this harness keeps its own accounting. With the retry
in place a recovered drop looks exactly like a plain success, so a run that
reported only `failed` would have shown the problem disappearing rather than
being handled — and there would have been no way to notice if the retry
silently stopped working.

The synthetic 429 fires on the **first attempt only** of the chosen call index.
A permanently-429 call would exhaust its retries and resolve with the 429
envelope, which measures the retry loop rather than the shared backpressure
this is here to provoke.

## Files

| File                             |                                                                           |
| -------------------------------- | ------------------------------------------------------------------------- |
| `limiter/src/index.ts`           | Re-exports the package. If this ever needs logic, the package has failed. |
| `consumer/src/index.ts`          | Routes, the shared-secret gate.                                           |
| `consumer/src/limiter-client.ts` | The two topologies behind one shape.                                      |
| `consumer/src/probe-workflow.ts` | The load generator.                                                       |
| `consumer/src/collector.ts`      | The results Durable Object.                                               |
| `consumer/src/report.ts`         | The plain-text report.                                                    |

Both Workers import from `../../../dist`, not from `src/`, so the harness
verifies the artifact that gets published rather than the sources it was built
from. `dist/` is gitignored; `npm run build` is step one.

`env.d.ts` in each Worker is hand-written rather than generated by
`wrangler types`, so there is no build step beyond that. The consumer's declares
a global `Env`, which is deliberate: `defineBinder` checks its argument against
the Durable Object bindings of the global `Env`, so `defineBinder('RATE_LIMITER')`
is itself part of what is being verified — misspell it and the harness fails to
compile.
