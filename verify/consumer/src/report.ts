/**
 * The plain-text report.
 *
 * Written to be pasted back verbatim: fixed-width, no colour, no markup, every
 * number carrying its unit and its configured counterpart next to it. A report
 * that has to be interpreted before it can be quoted is a report that gets
 * summarised instead, and the summary is where the interesting result goes
 * missing.
 */

import type {
  ProbeCallRecord,
  ProbeConfig,
  ProbeInstanceResult,
} from './collector.js';
import { describeVia } from './limiter-client.js';
import type { LimiterStats } from '../../../dist/do.js';

function fmt(ms: number): string {
  return ms >= 60_000
    ? `${(ms / 60_000).toFixed(2)} min (${String(ms)} ms)`
    : `${String(ms)} ms`;
}

function pad(label: string): string {
  return label.padEnd(26);
}

function groupBy<T>(items: T[], key: (item: T) => string): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list === undefined) out.set(k, [item]);
    else list.push(item);
  }
  return [...out.entries()].sort((a, b) => b[1].length - a[1].length);
}

/**
 * The most calls that *started* inside any window of `windowMs`.
 *
 * Anchored on `ranAt` — when the callback actually fired — not on when the
 * caller asked. What the limiter controls is the former; the latter is just
 * the stampede.
 *
 * A sliding window over sorted starts rather than fixed buckets: a fixed
 * minute boundary can split a burst in half and report a rate the upstream
 * never saw. The rolling maximum is the number the upstream's own limiter
 * would have applied.
 */
function peakRolling(records: ProbeCallRecord[], windowMs: number): number {
  const times = records
    .map((r) => r.ranAt)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  let peak = 0;
  let left = 0;
  for (let right = 0; right < times.length; right++) {
    while ((times[right] ?? 0) - (times[left] ?? 0) >= windowMs) left++;
    peak = Math.max(peak, right - left + 1);
  }
  return peak;
}

/**
 * Maximum overlap of caller-side work: a sweep over start/end events.
 *
 * Ends are processed before starts at an identical timestamp (the `-1` sorts
 * first), so a call that finishes exactly as another begins is not counted as
 * an overlap it never had.
 */
function peakConcurrency(records: ProbeCallRecord[]): number {
  const events: [number, number][] = [];
  for (const r of records) {
    if (r.ranAt === null) continue;
    events.push([r.ranAt, 1], [r.settledAt, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function timeline(records: ProbeCallRecord[]): string[] {
  const byRun = [...records].sort((a, b) => (a.ranAt ?? 0) - (b.ranAt ?? 0));
  const line = (r: ProbeCallRecord): string =>
    `  ${r.label}#${String(r.index).padStart(3)}` +
    `  requested ${String(r.requestedAt).padStart(8)} ms` +
    `  ran ${String(r.ranAt ?? -1).padStart(8)} ms` +
    `  parked ${fmt(r.waitedMs ?? 0)}` +
    (r.attempts > 1 ? `  (${String(r.attempts)} attempts)` : '') +
    ((r.drops ?? 0) > 0 ? `  (${String(r.drops)} dropped, recovered)` : '');
  if (byRun.length <= 16) return byRun.map(line);
  return [
    ...byRun.slice(0, 8).map(line),
    `  ... ${String(byRun.length - 16)} more ...`,
    ...byRun.slice(-8).map(line),
  ];
}

/**
 * Failures, grouped by message and then split by *where* they died.
 *
 * The split is the whole value of this section. A call that parked for four
 * minutes and was then dropped indicts the long park itself — it is the
 * memory-only wait queue losing a caller, which is the design's one
 * acknowledged failure mode. A call that had already started and then failed is
 * an unrelated blip in the caller's own work. Both arrive here as the same
 * message, and reporting only the message would let the first be read as the
 * second.
 */
function describeFailures(failed: ProbeCallRecord[]): string[] {
  return groupBy(failed, (r) => r.error ?? 'unknown').flatMap(
    ([message, list]) => {
      // `ranAt === null` means the callback never fired: the caller was still
      // parked, waiting for its turn, when the call died.
      const parked = list.filter((r) => r.ranAt === null);
      const inFlight = list.filter((r) => r.ranAt !== null);
      // How long each dropped caller had been waiting when it died — the
      // number that says whether long parks are what breaks.
      const heldFor = parked
        .map((r) => r.settledAt - r.requestedAt)
        .sort((a, b) => a - b);

      return [
        `  ${String(list.length)}x  ${message}`,
        ...(parked.length > 0
          ? [
              `        ${String(parked.length)} died while PARKED (callback never fired)`,
              `          longest wait before dropping   ${fmt(heldFor[heldFor.length - 1] ?? 0)}`,
              `          shortest                       ${fmt(heldFor[0] ?? 0)}`,
              `          instances affected             ${[
                ...new Set(parked.map((r) => r.label)),
              ]
                .sort((a, b) => a.localeCompare(b))
                .join(', ')}`,
            ]
          : []),
        ...(inFlight.length > 0
          ? [
              `        ${String(inFlight.length)} died IN FLIGHT (callback had already started)`,
            ]
          : []),
      ];
    }
  );
}

export function buildReport(
  config: ProbeConfig,
  results: ProbeInstanceResult[],
  stats: LimiterStats
): string {
  const records = results
    .flatMap((r) => r.records)
    .sort((a, b) => a.requestedAt - b.requestedAt);
  const expected = config.instances * config.callsPerInstance;
  const ok = records.filter((r) => r.ok);
  const failed = records.filter((r) => !r.ok);
  const waits = ok.map((r) => r.waitedMs ?? 0).sort((a, b) => a - b);
  const retried = ok.filter((r) => r.attempts > 1).length;
  // Drops the client absorbed. Counted separately from `failed` because a
  // recovered drop is invisible in the success count, and the drop RATE is the
  // number this harness exists to produce.
  const droppedCalls = records.filter((r) => (r.drops ?? 0) > 0);
  const totalDrops = records.reduce((sum, r) => sum + (r.drops ?? 0), 0);
  const recovered = droppedCalls.filter((r) => r.ok).length;
  const allReported = results.length === config.instances;
  const unrecorded = expected - records.length;

  const perWindow = peakRolling(ok, config.windowInMs);
  // Finding: a rested caller may spend the whole `limitPerWindow` at once, and
  // the sliding log holds no rolling window above it — the allowance is bounded
  // continuously. So the peak achieved rate is bounded by the configured limit
  // itself, and that is exactly what this section checks.
  const windowLabel = `${String(config.windowInMs)} ms`;

  return [
    `DURABLE-RATE-LIMITER — DEPLOYED VERIFICATION — ${config.probeId}`,
    `================================================================`,
    `generated  ${new Date().toISOString()}`,
    `via        ${config.via}  (${describeVia(config.via)})`,
    ``,
    `CONFIG`,
    `  ${pad('instances')}${String(config.instances)}`,
    `  ${pad('calls per instance')}${String(config.callsPerInstance)} in steps of ${String(config.callsPerStep)}`,
    `  ${pad('total calls')}${String(expected)}`,
    `  ${pad('bucket')}limitPerWindow ${String(config.limitPerWindow)} per ${windowLabel}`,
    `  ${pad('concurrency')}${String(config.concurrency)}`,
    `  ${pad('hold per call')}${String(config.holdMs)} ms`,
    `  ${pad('synthetic 429')}${
      config.simulate429OnCall > 0
        ? `call #${String(config.simulate429OnCall)} of each instance, Retry-After ${String(config.retryAfterSeconds)}s`
        : 'off'
    }`,
    `  ${pad('stampede at')}${new Date(config.startAtMs).toISOString()}`,
    ``,
    `COMPLETION`,
    `  ${pad('instances reported')}${String(results.length)} / ${String(config.instances)}${
      results.length < config.instances ? '   <-- still running, or lost' : ''
    }`,
    `  ${pad('calls recorded')}${String(records.length)} / ${String(expected)}`,
    `  ${pad('succeeded')}${String(ok.length)}`,
    `  ${pad('failed')}${String(failed.length)}`,
    `  ${pad('retried at least once')}${String(retried)}`,
    `  ${pad('dropped while parked')}${String(totalDrops)} drop${totalDrops === 1 ? '' : 's'} across ${String(droppedCalls.length)} call${droppedCalls.length === 1 ? '' : 's'}`,
    `  ${pad('  of those, recovered')}${String(recovered)} by the client's own retry`,
    ...(records.length > 0
      ? [
          `  ${pad('  drop rate')}${((droppedCalls.length / records.length) * 100).toFixed(1)}% of calls were dropped at least once`,
        ]
      : []),
    ...results
      .filter((r) => r.fatalError !== undefined)
      .map((r) => `  FATAL ${r.label}: ${r.fatalError ?? ''}`),
    ...(allReported
      ? // Every instance has had its say. Missing calls are therefore not
        // "not yet" — they are calls that died with an instance before it
        // could record them, which is a finished state and a different
        // finding. Labelling this INCOMPLETE invites one more pointless read.
        unrecorded === 0
        ? []
        : [
            ``,
            `  ${String(unrecorded)} call${unrecorded === 1 ? '' : 's'} unaccounted for — every instance reported, so`,
            `  these died with an instance before it could record them. See the`,
            `  FATAL line(s) above; a fatal is the harness's own step retries`,
            `  being off, which is deliberate.`,
          ]
      : [
          ``,
          `  INCOMPLETE — every number below describes only what has been`,
          `  recorded so far. Re-read this route once the count settles.`,
        ]),
    ``,
    `1 — LONGEST PARK  (does a parked callback survive?)`,
    ...(waits.length === 0
      ? [`  no successful calls`]
      : [
          `  ${pad('longest successful park')}${fmt(waits[waits.length - 1] ?? 0)}`,
          `  ${pad('p95 park')}${fmt(waits[Math.floor(waits.length * 0.95)] ?? 0)}`,
          `  ${pad('median park')}${fmt(waits[Math.floor(waits.length / 2)] ?? 0)}`,
          `  ${pad('shortest park')}${fmt(waits[0] ?? 0)}`,
          ``,
          `  ${
            failed.length === 0
              ? `VERDICT: PASS — all ${String(ok.length)} callbacks fired; the longest`
              : `VERDICT: see failures below (${String(failed.length)})`
          }`,
          ...(failed.length === 0
            ? [
                `  caller was held ${fmt(waits[waits.length - 1] ?? 0)} and still ran.`,
              ]
            : []),
        ]),
    ``,
    `2 — FAILURES BY KIND`,
    ...(failed.length === 0 ? [`  none`] : describeFailures(failed)),
    ``,
    `3 — ACHIEVED vs CONFIGURED RATE`,
    `  ${pad('rolling window')}${windowLabel}`,
    `  ${pad('peak achieved')}${String(perWindow)} calls in any rolling window`,
    `  ${pad('configured limit')}${String(config.limitPerWindow)} per window`,
    `  ${
      perWindow <= config.limitPerWindow
        ? `VERDICT: within the limit — no rolling window exceeded it.`
        : `VERDICT: OVER the limit by ${String(perWindow - config.limitPerWindow)}.`
    }`,
    ...(perWindow > config.limitPerWindow
      ? [
          `  ${String(perWindow)} > the configured limit of ${String(config.limitPerWindow)}. The sliding log`,
          `  guarantees no rolling window exceeds the limit, so a genuine excess`,
          `  here is a real regression in the pacing guarantee.`,
        ]
      : []),
    ``,
    `4 — PEAK CONCURRENCY`,
    `  ${pad('peak observed overlap')}${String(peakConcurrency(ok))}`,
    `  ${pad('configured')}${String(config.concurrency)}`,
    `  Measured caller-side, from when each callback fired to when it`,
    `  settled — the object awaits the callback, so in-flight count is real`,
    `  information rather than an approximation of it.`,
    // The opening window is where this is actually tested: the whole allowance
    // of `limitPerWindow` is released at once, so up to that many callbacks
    // start together. If the allowance is below the concurrency cap, the cap
    // can never be reached in one window. Saying so stops a low number being
    // read as a broken cap when it only means the run never asked the question.
    ...(peakConcurrency(ok) < config.concurrency
      ? [
          ``,
          `  Peak is BELOW the cap, which on its own proves nothing: a window`,
          `  releases its whole allowance of ${String(config.limitPerWindow)} at once, and each call`,
          `  holds ${String(config.holdMs)} ms, so those overlap. The cap`,
          `  ${
            config.limitPerWindow >= config.concurrency && config.holdMs > 0
              ? 'should be reached in the opening window — a low peak is worth explaining.'
              : 'cannot be reached: the window allowance is below it. Raise'
          }`,
          ...(config.limitPerWindow >= config.concurrency && config.holdMs > 0
            ? []
            : [
                `  limitPerWindow above the concurrency cap to make this section test`,
                `  anything.`,
              ]),
        ]
      : []),
    ``,
    `5 — FINAL LIMITER STATE`,
    `  ${pad('remaining')}${stats.remaining.toFixed(3)}`,
    `  ${pad('resetAt')}${new Date(stats.resetAt).toISOString()}`,
    `  ${pad('penalised')}${String(stats.penalised)}`,
    `  ${pad('forcedUntil')}${
      stats.forcedUntil === 0
        ? '0 (no penalty)'
        : new Date(stats.forcedUntil).toISOString()
    }`,
    `  ${pad('active')}${String(stats.active)}`,
    `  ${pad('persisted state')}${String(stats.state.grants.length)} grant${stats.state.grants.length === 1 ? '' : 's'} summing ${stats.state.grants.reduce((sum, grant) => sum + grant.amount, 0).toFixed(3)}, forcedUntil ${String(stats.state.forcedUntil)}`,
    `  ${pad('effective config')}limitPerWindow ${String(stats.config.bucket.limitPerWindow)} per ${String(stats.config.bucket.windowInMs)} ms, concurrency ${String(stats.config.concurrency)}`,
    // A slot is released in a `finally`, so a callback that rejects frees it.
    // A callback that never settles does not — and a caller whose connection
    // died is exactly the case where that could happen. If this persists after
    // every instance has finished, the cap has been permanently lowered for
    // this bucket, and it would compound across runs on a shared limiter.
    ...(allReported && stats.active > 0
      ? [
          ``,
          `  ⚠ ${String(stats.active)} call${stats.active === 1 ? '' : 's'} still ACTIVE though all ${String(config.instances)} instances have finished.`,
          `  Re-read this route in a few minutes. If it does not fall to 0, the`,
          `  object is awaiting a callback that will never return and the slot`,
          `  is leaked — effective concurrency is now ${String(Math.max(0, config.concurrency - stats.active))}, not ${String(config.concurrency)}.`,
          `  Correlate with the drops in section 2: this is the same event seen`,
          `  from the object's side rather than the caller's.`,
        ]
      : []),
    ``,
    `TIMELINE  (by run time, ms after the stampede instant)`,
    ...timeline(ok),
    ``,
  ].join('\n');
}
