import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import { defineLimiter } from '../../../dist/client.js';

import type { ProbeCallRecord, ProbeInstanceResult, Via } from './collector.js';
import { binderFor } from './limiter-client.js';

/**
 * The load generator.
 *
 * Every instance is handed the SAME `startAtMs` and sleeps until it, so N
 * independent Workflow instances — separate isolates, separate execution
 * contexts, separate machines — arrive at the limiter at one instant. That is
 * the shape production actually has (overlapping dispatch ticks, restarted
 * instances, several applications sharing one upstream quota), and it is the
 * thing neither a unit test nor a sequential loop reproduces: a sequential
 * script cannot tell a limiter that works from one that does nothing at all.
 *
 * `callsPerStep` spreads the calls across several `step.do`s. That exists so
 * that if a per-request invocation ceiling is ever hit it is hit by the
 * dedicated `/cap-probe` route as a deliberate experiment, rather than here,
 * where it would masquerade as "the long park failed".
 *
 * Each call goes through the shipped client — `limiter.for(env).call(fn, {
 * read })` — not a hand-built envelope. The envelope is then the package's
 * work, which is the part under test.
 */

export interface LimiterProbeParams {
  probeId: string;
  via: Via;
  label: string;
  startAtMs: number;
  callsPerInstance: number;
  callsPerStep: number;
  holdMs: number;
  simulate429OnCall: number;
  retryAfterSeconds: number;
}

export class LimiterProbeWorkflow extends WorkflowEntrypoint<
  Env,
  LimiterProbeParams
> {
  override async run(
    event: WorkflowEvent<LimiterProbeParams>,
    step: WorkflowStep
  ): Promise<void> {
    const p = event.payload;

    // `sleepUntil` hibernates the instance, so lining up N of them costs
    // nothing and the stampede is genuinely simultaneous rather than
    // "whenever each instance happened to spin up".
    await step.sleepUntil('wait for common start', new Date(p.startAtMs));

    const batches = Math.ceil(p.callsPerInstance / p.callsPerStep);
    const all: ProbeCallRecord[] = [];
    let fatalError: string | undefined;

    for (let batch = 0; batch < batches; batch++) {
      const from = batch * p.callsPerStep + 1;
      const to = Math.min((batch + 1) * p.callsPerStep, p.callsPerInstance);

      try {
        const records = await step.do(
          `hammer ${String(from)}-${String(to)}`,
          {
            // The whole point is to sit parked far longer than any default
            // allows. Retries off: a failure here IS the finding, and a
            // silent retry would erase it.
            timeout: '30 minutes',
            retries: { limit: 0, delay: '1 second', backoff: 'constant' },
          },
          async (): Promise<ProbeCallRecord[]> => this.#runBatch(p, from, to)
        );
        all.push(...records);
      } catch (error) {
        fatalError =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        break;
      }
    }

    // Recorded in its own step so a batch that died still reports what it had.
    await step.do('record result', async () => {
      const collector = this.env.COLLECTOR.get(
        this.env.COLLECTOR.idFromName(p.probeId)
      );
      const result: ProbeInstanceResult = {
        label: p.label,
        startAtMs: p.startAtMs,
        records: all,
        ...(fatalError === undefined ? {} : { fatalError }),
      };
      await collector.record(p.probeId, result);
    });
  }

  async #runBatch(
    p: LimiterProbeParams,
    from: number,
    to: number
  ): Promise<ProbeCallRecord[]> {
    // Every timestamp in the report is relative to the shared stampede
    // instant, so records from instances on different machines are directly
    // comparable without trusting their clocks to agree on an absolute epoch
    // any better than they agree on elapsed time.
    const t0 = p.startAtMs;
    const binder = binderFor(this.env, p.via);
    const records: ProbeCallRecord[] = [];

    await Promise.all(
      Array.from({ length: to - from + 1 }, async (_unused, offset) => {
        const index = from + offset;
        const requestedAt = Date.now() - t0;
        let ranAt: number | null = null;
        let attempts = 0;
        let drops = 0;

        // One limiter per call, purely so `onDrop` can close over this call's
        // counter. In an application the definition belongs at module scope;
        // here the per-call attribution is the measurement.
        const bound = defineLimiter({
          binder,
          name: p.probeId,
          onDrop: () => {
            drops += 1;
          },
        }).for(this.env);

        const record = (ok: boolean, error?: string): void => {
          records.push({
            label: p.label,
            index,
            requestedAt,
            ranAt,
            settledAt: Date.now() - t0,
            waitedMs: ranAt === null ? null : ranAt - requestedAt,
            ok,
            attempts,
            drops,
            ...(error === undefined ? {} : { error }),
          });
        };

        try {
          await bound.call(
            () => {
              // This runs in THIS isolate whichever `via` is in use — the
              // closure hops back to wherever it originated. Everything
              // measured here is caller-side truth, which is the only kind
              // that answers "was the caller actually held?".
              attempts++;
              ranAt = Date.now() - t0;

              // 429 on the FIRST attempt only. A permanently-429 call would
              // exhaust its retries and resolve with the 429 envelope, which
              // measures the retry loop rather than the shared backpressure
              // this is here to provoke: one caller's 429 pausing the bucket
              // for every other caller and everyone queued behind it.
              const is429 =
                p.simulate429OnCall > 0 &&
                index === p.simulate429OnCall &&
                attempts === 1;

              return is429
                ? new Response('synthetic-429', {
                    status: 429,
                    headers: { 'Retry-After': String(p.retryAfterSeconds) },
                  })
                : this.#hold(p.holdMs);
            },
            {
              // The callback holds the slot for `holdMs` so concurrency has
              // something to actually overlap. `read` keeps the value tiny —
              // the body never leaves this isolate, which is the design.
              read: (res) => (res.status === 429 ? 'rate-limited' : 'ok'),
            }
          );
          record(true);
        } catch (error) {
          record(
            false,
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error)
          );
        }
      })
    );

    return records;
  }

  /** Stands in for an upstream call that takes time. */
  async #hold(ms: number): Promise<Response> {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    return new Response('ok', { status: 200 });
  }
}
