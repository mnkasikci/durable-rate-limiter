/**
 * The consumer Worker: an application that uses the limiter, plus the routes
 * that drive the experiment.
 *
 * Throwaway by design — `wrangler delete` both Workers when done.
 *
 * Routes, each answering one question:
 *   /ping           are the two halves deployed and agreed on the envelope?
 *   /closure-check  does a closure survive two hops (service binding → DO)?
 *   /client-path    does the shipped client stack work end to end?
 *   /cap-probe      where does the per-request invocation ceiling bite?
 *   /start          stampede N Workflow instances at one shared instant
 *   /report/:id     the plain-text report
 *
 * Every route takes `?key=` and most take `&via=service|direct`.
 */

import { ENVELOPE_VERSION, defineLimiter } from '../../../dist/client.js';

import { ProbeCollectorDO, type ProbeConfig, type Via } from './collector.js';
import {
  binderFor,
  describeVia,
  limiterFor,
  parseVia,
} from './limiter-client.js';
import {
  LimiterProbeWorkflow,
  type LimiterProbeParams,
} from './probe-workflow.js';
import { buildReport } from './report.js';
import type { CallReport } from '../../../dist/do.js';

// The Workflow class and the collector must be exported from the Worker's
// entrypoint module for wrangler to find them.
export { ProbeCollectorDO, LimiterProbeWorkflow };

function num(value: string | null, fallback: number): number {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(body: string[], status = 200): Response {
  return new Response(body.join('\n'), {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Constant-time-ish comparison. These routes spawn Workflows and are on the
 * open internet; the shared secret is the minimum bar, and an early-exit
 * compare would leak its length for free.
 */
function secretMatches(expected: string, given: string | null): boolean {
  if (given?.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const q = url.searchParams;

    // Set with: wrangler secret put PROBE_KEY
    // An unset key denies everything rather than allowing it — a harness that
    // fails open on a missing secret is worse than no gate at all.
    if (
      typeof env.PROBE_KEY !== 'string' ||
      env.PROBE_KEY === '' ||
      !secretMatches(env.PROBE_KEY, q.get('key'))
    ) {
      return text(['unauthorized — append ?key=<PROBE_KEY>', ''], 401);
    }

    const via: Via = parseVia(q.get('via'));
    const collector = (probeId: string) =>
      env.COLLECTOR.get(env.COLLECTOR.idFromName(probeId));

    // ── Are both halves up, and do they agree on the wire? ───────────────
    if (url.pathname === '/ping') {
      const started = Date.now();
      const pong = await env.LIMITER.ping();
      // The whole reason to print both: the consumer's ENVELOPE_VERSION comes
      // from the client bundle it deployed with, the limiter's from whatever
      // is deployed over there. Comparing them here is the check.
      // `ok` is typed as the literal `true`, so it asserts nothing — reaching
      // this line at all is what proves the entrypoint answered.
      const agreed = pong.envelopeVersion === ENVELOPE_VERSION;
      return text([
        `LIMITER PING`,
        `  ok                        ${String(pong.ok)}`,
        `  limiter envelopeVersion   ${String(pong.envelopeVersion)}`,
        `  consumer ENVELOPE_VERSION ${String(ENVELOPE_VERSION)}`,
        `  elapsed                   ${String(Date.now() - started)} ms`,
        ``,
        `  VERDICT: ${
          agreed
            ? 'PASS — both halves up and agreed on the wire format'
            : 'FAIL — version skew; redeploy the older half before believing anything else here'
        }`,
        ``,
        `  The two halves deploy on independent schedules. Skew shows up`,
        `  otherwise as silent mis-limiting, not as an error.`,
        ``,
      ]);
    }

    // ── Does a closure survive the hops? ─────────────────────────────────
    if (url.pathname === '/closure-check') {
      const marker = `local-${crypto.randomUUID()}`;
      let observed: string | null = null;
      const started = Date.now();

      const returned = await limiterFor(env, via, 'closure-check').execute(
        (): Promise<CallReport<string>> => {
          // If this ran anywhere but the originating isolate it could not
          // touch `observed` — that variable exists only in this heap.
          observed = marker;
          return Promise.resolve({ value: marker, status: 200 });
        }
      );

      const mutated = (observed as string | null) === marker;
      const ok = mutated && returned === marker;
      return text([
        `CLOSURE CHECK`,
        `  via=${via}  ${describeVia(via)}`,
        ``,
        `  local variable mutated   ${String(mutated)}`,
        `  value round-tripped      ${String(returned === marker)}`,
        `  elapsed                  ${String(Date.now() - started)} ms`,
        ``,
        `  VERDICT: ${
          ok
            ? 'PASS — the callback ran in the calling isolate'
            : 'FAIL — this topology is not viable'
        }`,
        ``,
      ]);
    }

    // ── Does the shipped client stack work end to end? ───────────────────
    if (url.pathname === '/client-path') {
      const name = `client-path-${Date.now().toString(36)}`;
      const limiter = defineLimiter({
        binder: binderFor(env, via),
        name,
        // The upstream convention lives on the limiter, not the call site.
        rateLimit: (res) => (res.status === 503 ? { retryAfterMs: 250 } : null),
        error: (res) =>
          res.status === 418 ? { message: 'teapot', retryable: false } : null,
      });
      const bound = limiter.for(env);

      const body = JSON.stringify({ id: 'abc', big: 'x'.repeat(4096) });
      const value = await bound.call(
        () => new Response(body),
        // `read` extracts the small thing; the body never leaves this isolate,
        // which is the point of the envelope.
        { read: async (res) => (await res.json<{ id: string }>()).id }
      );

      // Counted, because it is the only observable proof that `retryable:
      // false` survived the hop. A non-retryable failure must run the callback
      // EXACTLY once; had the flag been lost, the object would have treated it
      // as transient and this would read 4 — the default maxRetries + 1.
      let attempts = 0;
      let rejection: Error | null = null;
      try {
        await bound.call(
          () => {
            attempts++;
            return new Response('nope', { status: 418 });
          },
          { read: () => null }
        );
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
      }

      // Each assertion states what it is, so a failure names itself rather
      // than leaving the reader to work out which line was the wrong one.
      const checks: [string, boolean, string][] = [
        ['read() extracted the id', value === 'abc', `"${value}"`],
        [
          'body stayed caller-side',
          value.length < body.length,
          `${String(body.length)} B built, ${String(value.length)} B crossed`,
        ],
        [
          'the failure rejected',
          rejection !== null,
          rejection === null ? 'RESOLVED — it should not have' : 'rejected',
        ],
        [
          'the message survived',
          rejection?.message.includes('teapot') ?? false,
          rejection === null
            ? 'no rejection'
            : `${rejection.name}: ${rejection.message}`,
        ],
        [
          'it was not retried',
          attempts === 1,
          `${String(attempts)} attempt${attempts === 1 ? '' : 's'}`,
        ],
      ];
      const passed = checks.every(([, ok]) => ok);

      return text([
        `CLIENT STACK — via=${via}`,
        ``,
        ...checks.map(
          ([label, ok, detail]) =>
            `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)}${detail}`
        ),
        ``,
        `  VERDICT: ${
          passed
            ? 'PASS — read(), the hooks and the envelope all work end to end'
            : 'FAIL — see the lines above'
        }`,
        ``,
        `  A failure reported as envelope DATA rejects with its message intact`,
        `  and is not retried. Thrown instead, the retryable flag would have`,
        `  been stripped by RPC and this would have been retried to exhaustion.`,
        `  Note the rejection's name: RPC rebuilds it as a plain Error and`,
        `  folds CallFailedError into the message — which is why nothing`,
        `  downstream may decide anything from an error's type.`,
        ``,
      ]);
    }

    // ── Where does the per-request invocation ceiling bite? ──────────────
    if (url.pathname === '/cap-probe') {
      const max = num(q.get('max'), 64);
      const name = `cap-${Date.now().toString(36)}`;
      const limiter = limiterFor(env, via, name);
      // Wide-open limits: this measures invocation accounting, not pacing.
      await limiter.configure({
        bucket: { capacity: 1000, fillPerWindow: 1000, windowInMs: 1000 },
        concurrency: 50,
      });

      let completed = 0;
      let failedAt: number | null = null;
      let error: string | null = null;

      for (let i = 1; i <= max; i++) {
        try {
          await limiter.execute((): Promise<CallReport<number>> =>
            Promise.resolve({ value: i, status: 200 })
          );
          completed = i;
        } catch (err) {
          failedAt = i;
          error =
            err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          break;
        }
      }

      return text([
        `PER-REQUEST INVOCATION CAP PROBE`,
        `  sequential execute() calls inside ONE request, via=${via}`,
        ``,
        `  attempted up to   ${String(max)}`,
        `  completed         ${String(completed)}`,
        `  first failure at  ${failedAt === null ? 'none' : String(failedAt)}`,
        `  error             ${error ?? 'none'}`,
        ``,
        `  Documented: 32 Worker invocations per request, each service-binding`,
        `  call counting toward it; DO calls are ordinary subrequests (1000).`,
        `  So via=service is expected to bite far earlier than via=direct.`,
        `  "none" means the ceiling was NOT reached at ${String(max)} — which`,
        `  locates nothing, it only raises the floor. Re-run with a larger`,
        `  &max to push it further.`,
        ``,
      ]);
    }

    // ── Start a stampede ─────────────────────────────────────────────────
    if (url.pathname === '/start') {
      const probeId = q.get('probeId') ?? `p${Date.now().toString(36)}`;
      const delaySeconds = num(q.get('delaySeconds'), 60);
      const config: ProbeConfig = {
        probeId,
        via,
        instances: num(q.get('instances'), 10),
        callsPerInstance: num(q.get('callsPerInstance'), 10),
        callsPerStep: num(q.get('callsPerStep'), 5),
        holdMs: num(q.get('holdMs'), 500),
        // The one shared instant. Every instance sleeps until exactly this.
        startAtMs: Date.now() + delaySeconds * 1000,
        // 100 calls at 10 per minute is roughly a 10 minute drain, so the last
        // caller parks well past the ~6 minute mark the design hinges on.
        capacity: num(q.get('capacity'), 5),
        fillPerWindow: num(q.get('fillPerWindow'), 10),
        windowInMs: num(q.get('windowInMs'), 60_000),
        concurrency: num(q.get('concurrency'), 5),
        simulate429OnCall: num(q.get('simulate429OnCall'), 0),
        retryAfterSeconds: num(q.get('retryAfterSeconds'), 5),
      };

      // A fresh probeId is a fresh bucket, so no run inherits another's
      // tokens or penalty. `configure` also rejects anyone queued, which is
      // why it happens before the instances exist rather than after.
      await limiterFor(env, via, probeId).configure({
        bucket: {
          capacity: config.capacity,
          fillPerWindow: config.fillPerWindow,
          windowInMs: config.windowInMs,
        },
        concurrency: config.concurrency,
      });
      await collector(probeId).putConfig(probeId, config);

      for (let i = 0; i < config.instances; i++) {
        const params: LimiterProbeParams = {
          probeId,
          via: config.via,
          label: `i${String(i).padStart(2, '0')}`,
          startAtMs: config.startAtMs,
          callsPerInstance: config.callsPerInstance,
          callsPerStep: config.callsPerStep,
          holdMs: config.holdMs,
          simulate429OnCall: config.simulate429OnCall,
          retryAfterSeconds: config.retryAfterSeconds,
        };
        await env.PROBE.create({ params });
      }

      const total = config.instances * config.callsPerInstance;
      const drainMin =
        (total / config.fillPerWindow) * (config.windowInMs / 60_000);
      return text([
        `probe started: ${probeId}`,
        ``,
        `  via                 ${config.via}`,
        `  instances           ${String(config.instances)}`,
        `  calls per instance  ${String(config.callsPerInstance)} (steps of ${String(config.callsPerStep)})`,
        `  total calls         ${String(total)}`,
        `  bucket              capacity ${String(config.capacity)}, fill ${String(config.fillPerWindow)} per ${String(config.windowInMs)} ms`,
        `  concurrency         ${String(config.concurrency)}`,
        `  hold per call       ${String(config.holdMs)} ms`,
        `  synthetic 429       ${
          config.simulate429OnCall > 0
            ? `call #${String(config.simulate429OnCall)}, Retry-After ${String(config.retryAfterSeconds)}s`
            : 'off'
        }`,
        `  stampede at         ${new Date(config.startAtMs).toISOString()} (in ${String(delaySeconds)}s)`,
        ``,
        `expected drain ~${drainMin.toFixed(1)} min. Then:`,
        `  /report/${probeId}?key=...`,
        ``,
      ]);
    }

    // ── Report ───────────────────────────────────────────────────────────
    if (url.pathname.startsWith('/report/')) {
      const probeId = url.pathname.slice('/report/'.length);
      const stub = collector(probeId);
      const config = await stub.getConfig(probeId);
      if (config === undefined) {
        return text([`no probe found: ${probeId}`, ''], 404);
      }
      const [results, stats] = await Promise.all([
        stub.results(probeId),
        limiterFor(env, config.via, probeId).stats(),
      ]);
      return text([buildReport(config, results, stats)]);
    }

    return text(
      [
        `durable-rate-limiter verification harness`,
        ``,
        `  /ping           both halves up, envelope versions agree`,
        `  /closure-check  a closure survives the hop(s)`,
        `  /client-path    the shipped client stack, end to end`,
        `  /cap-probe      per-request invocation ceiling  [&max=64]`,
        `  /start          stampede N Workflow instances   [see README]`,
        `  /report/:id     the plain-text report`,
        ``,
        `  all need ?key=<PROBE_KEY>`,
        `  all accept &via=service (default) or &via=direct`,
        ``,
      ],
      404
    );
  },
};
