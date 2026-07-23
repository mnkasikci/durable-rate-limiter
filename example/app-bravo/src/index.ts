// drl-example-bravo — one of two independently-deployed apps that share the
// upstream quota through the shared limiter. It is identical in shape to
// app-alpha and shares nothing with it but `example/shared/protocol.ts`.
//
//   GET  /burst?n=8   fire n concurrent calls through the shared limiter
//   GET  /status      this app's live request-state snapshot
//   POST /reset       clear this app's StatusDO
//   GET  /            plain-text identity/help
import { DurableObject } from 'cloudflare:workers';

import { CallDroppedError, type DropHook } from '../../../dist/client.js';

import {
  HEADER_APP,
  HEADER_REQUEST_ID,
  type DemoApp,
  type DropReason,
  type RequestState,
  type StatusSnapshot,
} from '../../shared/protocol.js';
import { upstreamLimiterFor } from './limiter.js';

/** This app's identity. app-alpha differs only here and in its worker name. */
const APP: DemoApp = 'bravo';

const DEFAULT_BURST = 8;
const MAX_BURST = 20;

/** The single status instance: one place to read across isolates. */
const STATUS_INSTANCE = 'singleton';

/**
 * Keep at most this many terminal (completed/dropped) entries. A burst runs in
 * one isolate while a dashboard poll may land on another, so the counts must
 * live in a Durable Object rather than an in-memory variable — but a long demo
 * would grow that store without bound, so the oldest terminal entries are
 * evicted past this cap. In-flight entries are never capped: they drain on their
 * own as requests finish.
 */
const MAX_TERMINAL = 500;

/** Terminal states never transition again in this app's instrumentation. */
function isTerminal(state: RequestState): boolean {
  return state === 'completed' || state === 'dropped';
}

interface StoredEntry {
  state: RequestState;
  /** Epoch ms of the last transition — the eviction key for terminal entries. */
  at: number;
  /** Only set on `dropped`, for the headline count's cheap breakdown. */
  reason?: DropReason;
}

/**
 * The StatusDO's surface, written out by hand and asserted once where the stub
 * is obtained. All methods return data; none throws a custom error across the
 * RPC boundary (a thrown custom error loses its properties). See `LimiterRpc`
 * for the idiom.
 */
export interface StatusRpc {
  transition(
    requestId: string,
    state: RequestState,
    at: number,
    reason?: DropReason
  ): Promise<void>;
  snapshot(): Promise<StatusSnapshot>;
  reset(): Promise<void>;
}

/**
 * Records the CURRENT state of every request the app fires, so the dashboard can
 * poll a truthful tally.
 *
 * Why a Durable Object at all: a burst runs inside one isolate's `waitUntil`
 * while a `/status` poll may be served by a different isolate, so an in-memory
 * counter would report zero to the poll that mattered. One named instance gives
 * every writer and the reader one place with strict ordering.
 */
export class StatusDO extends DurableObject<Env> {
  #entries = new Map<string, StoredEntry>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<[string, StoredEntry][]>('entries');
      if (stored !== undefined) this.#entries = new Map(stored);
    });
  }

  /** Record where a request is now. Terminal entries past the cap are evicted oldest-first. */
  async transition(
    requestId: string,
    state: RequestState,
    at: number,
    reason?: DropReason
  ): Promise<void> {
    const entry: StoredEntry = { state, at };
    if (reason !== undefined) entry.reason = reason;
    this.#entries.set(requestId, entry);

    if (isTerminal(state)) {
      const terminal = [...this.#entries].filter(([, e]) =>
        isTerminal(e.state)
      );
      if (terminal.length > MAX_TERMINAL) {
        terminal.sort((a, b) => a[1].at - b[1].at);
        for (const [key] of terminal.slice(0, terminal.length - MAX_TERMINAL)) {
          this.#entries.delete(key);
        }
      }
    }

    await this.ctx.storage.put('entries', [...this.#entries]);
  }

  /** Tally every tracked request's current state. */
  snapshot(): Promise<StatusSnapshot> {
    const counts = {
      queued: 0,
      inFlight: 0,
      requeued: 0,
      completed: 0,
      dropped: 0,
    };
    const droppedBreakdown = { droppedQueue: 0, exhausted429: 0, failed: 0 };

    for (const entry of this.#entries.values()) {
      counts[entry.state] += 1;
      if (entry.state === 'dropped') {
        if (entry.reason === 'exhausted429') droppedBreakdown.exhausted429 += 1;
        else if (entry.reason === 'failed') droppedBreakdown.failed += 1;
        else droppedBreakdown.droppedQueue += 1;
      }
    }

    return Promise.resolve({
      counts,
      droppedBreakdown,
      total: this.#entries.size,
    });
  }

  /** Clear every tracked request so the next run starts from zero. */
  async reset(): Promise<void> {
    this.#entries.clear();
    await this.ctx.storage.put('entries', [...this.#entries]);
  }
}

function statusStub(env: Env): StatusRpc {
  // The declared `StatusRpc` return type widens the stub to the hand-written
  // surface exactly once. The namespace is typed to `StatusDO`, whose methods
  // are concrete, so no cast is needed.
  return env.STATUS.getByName(STATUS_INSTANCE);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/burst') {
      const n = clamp(
        Number(url.searchParams.get('n')) || DEFAULT_BURST,
        1,
        MAX_BURST
      );
      // 202 and run in waitUntil: a burst can queue for MINUTES under a shared
      // penalty, and the trigger must not block on that. State transitions are
      // written to the StatusDO as they happen, so a poll sees progress live
      // rather than all at once at the end.
      //
      // Honest caveat: waitUntil keeps the isolate alive only so long, so a
      // burst that parks for an extreme stretch could be cut short. For the
      // demo's minutes-long penalties it is the right shape; a production run
      // that must outlast that belongs in a Workflow.
      ctx.waitUntil(runBurst(env, n));
      return Response.json({ app: APP, n }, { status: 202 });
    }

    if (url.pathname === '/status') {
      return Response.json(await statusStub(env).snapshot());
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      await statusStub(env).reset();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/') {
      return new Response(
        `drl-example-${APP}\n\n` +
          `  GET  /burst?n=8   fire n concurrent calls through the shared limiter\n` +
          `  GET  /status      live request-state snapshot\n` +
          `  POST /reset       clear the status snapshot\n` +
          `  GET  /            this message\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }

    return new Response('not found', { status: 404 });
  },
};

/**
 * Fire `n` concurrent calls through the shared limiter, recording each request's
 * state to the StatusDO as it moves queued → inFlight → completed (or requeued,
 * or dropped). Every transition is knowable client-side because the limiter runs
 * the callback in THIS isolate.
 */
async function runBurst(env: Env, n: number): Promise<void> {
  // Transitions are written as they happen; the promises are tracked so
  // waitUntil keeps the isolate alive until the last write lands.
  const pending: Promise<unknown>[] = [];
  const mark = (
    requestId: string,
    state: RequestState,
    reason?: DropReason
  ): void => {
    pending.push(
      statusStub(env).transition(requestId, state, Date.now(), reason)
    );
  };

  const stamp = `${APP}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const calls: Promise<unknown>[] = [];

  for (let index = 0; index < n; index++) {
    const requestId = `${stamp}-${String(index).padStart(2, '0')}`;

    // Before the call: the limiter's object is parking it.
    mark(requestId, 'queued');

    // Per request so it can name which request was dropped. A transient drop
    // that WILL be retried is genuinely waiting its turn again, so it goes back
    // to `queued`; the FINAL drop surfaces as a CallDroppedError caught below
    // and is recorded once as the terminal `dropped`.
    const onDrop: DropHook = (drop) => {
      if (drop.willRetry) mark(requestId, 'queued');
    };

    const limiter = upstreamLimiterFor(env, onDrop);

    calls.push(
      (async () => {
        try {
          // A FRESH request per attempt: `fn` is re-invoked from scratch on
          // every retry, so it must build its own Request each time — a reused
          // one fails the second attempt with "body already used".
          const status = await limiter.call(
            () => {
              // The callback fired: the fetch is about to run.
              mark(requestId, 'inFlight');
              // Dispatched over the UPSTREAM service binding: a plain fetch()
              // of another Worker's workers.dev URL is blocked (error 1042).
              return env.UPSTREAM.fetch(`${env.UPSTREAM_URL}/api`, {
                headers: {
                  [HEADER_APP]: APP,
                  [HEADER_REQUEST_ID]: requestId,
                },
              });
            },
            {
              read: (res) => {
                // A 429 means the limiter will pause every caller and re-invoke:
                // the request is requeued until its next attempt fires inFlight.
                if (res.status === 429) mark(requestId, 'requeued');
                return res.status;
              },
            }
          );

          // Resolved. A 429 that survived to here exhausted the retry budget and
          // was never served — the limiter treats a real 429 as a rate limit,
          // pauses every caller, and hands back the last status.
          if (status === 429) mark(requestId, 'dropped', 'exhausted429');
          else mark(requestId, 'completed');
        } catch (error) {
          // CallDroppedError: dropped while parked, retries spent. Anything else
          // is an unexpected failure. Both are terminal `dropped`.
          mark(
            requestId,
            'dropped',
            error instanceof CallDroppedError ? 'queue' : 'failed'
          );
        }
      })()
    );
  }

  await Promise.allSettled(calls);
  await Promise.allSettled(pending);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.trunc(value)));
}
