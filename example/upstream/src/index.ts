// drl-example-upstream — a PURE mock third-party API.
//
// This Worker plays the THIRD PARTY. It knows nothing about the limiter: it
// enforces its own documented limit — a ROLLING (sliding) window across the
// whole API, not per caller — exactly the way the package does, by recording
// served timestamps and pruning those older than the window at read time. That
// the limit is per-API rather than per-caller is what makes the shared quota
// real: alpha and bravo spend from one ceiling.
//
// Every route is OPEN — no key. That is deliberate and acceptable here: these
// routes only read and mutate FAKE state (a made-up rolling window and two
// counters). There is nothing to protect. The one genuinely guarded surface in
// the whole demo is the limiter's key-guarded /configure, which is a real
// control plane; this mock is a toy the dashboard pokes at.
//
// Routes:
//   GET  /api          the fake API: admit-or-429 against the rolling window,
//                      held for processingMs so limiter concurrency slots stay
//                      visibly occupied.
//   GET  /rate-limit   observability, OUTSIDE the rate limit's own scope.
//   POST /configure    { limitPerWindow?, windowMs? | windowSeconds?, processingMs? }
//   POST /reset        clear served timestamps and counters (config stays).
import { DurableObject } from 'cloudflare:workers';

import type { RateLimitResponse } from '../../shared/protocol.js';

/** Defaults, applied until /configure overrides them. */
const DEFAULT_CONFIG: MockConfig = {
  limitPerWindow: 12,
  windowMs: 60_000,
  processingMs: 250,
};

/** Sanity ceilings so a fat-fingered form cannot wedge the demo. */
const MAX_PROCESSING_MS = 5_000;

/** The single mock instance: one place to read, strict ordering, read-your-writes. */
const MOCK_INSTANCE = 'singleton';

/** The mock's own limits. Persisted, so a mid-demo eviction keeps the settings. */
interface MockConfig {
  limitPerWindow: number;
  windowMs: number;
  processingMs: number;
}

/**
 * The admit decision, returned as DATA rather than thrown — a custom Error loses
 * its properties across the RPC boundary, so a decision the Worker must read
 * travels as a plain object. `processingMs` rides along so the Worker holds the
 * caller without a second round-trip for the config.
 */
export interface AdmitResult {
  ok: boolean;
  retryAfterSeconds: number;
  processingMs: number;
}

/**
 * The mock DO's surface, written out by hand and asserted once where the stub is
 * obtained. None of these is generic, so the stub type would survive on its own —
 * but declaring the surface is the repo idiom (see `LimiterRpc`) and keeps a raw
 * stub type from reaching a call site. All methods return data; none throws a
 * custom error across the boundary.
 */
export interface MockApiRpc {
  admit(now: number): Promise<AdmitResult>;
  rateLimit(now: number): Promise<RateLimitResponse>;
  configure(
    patch: Partial<MockConfig>,
    now: number
  ): Promise<RateLimitResponse>;
  reset(): Promise<void>;
}

/**
 * The rolling-window rate limiter in the flesh, plus two counters.
 *
 * State is a DO — not KV — on purpose: the window needs strict ordering and
 * read-your-writes so two near-simultaneous `/api` calls cannot both slip past a
 * ceiling that only one slot remained under. State is persisted through
 * `ctx.storage` so an eviction mid-demo keeps the settings and the run, and
 * cached in memory so a read costs nothing.
 */
export class MockApiDO extends DurableObject<Env> {
  #config: MockConfig = { ...DEFAULT_CONFIG };
  #served: number[] = [];
  #served_total = 0;
  #rejected_total = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#config =
        (await ctx.storage.get<MockConfig>('config')) ?? this.#config;
      this.#served = (await ctx.storage.get<number[]>('served')) ?? [];
      this.#served_total = (await ctx.storage.get<number>('servedTotal')) ?? 0;
      this.#rejected_total =
        (await ctx.storage.get<number>('rejectedTotal')) ?? 0;
    });
  }

  /** Drop served timestamps that have aged out of the rolling window. */
  #prune(now: number): void {
    this.#served = this.#served.filter(
      (at) => now - at < this.#config.windowMs
    );
  }

  /**
   * Admit a call, or refuse it — the sliding window doing its job. Only served
   * requests are recorded, so the window measures what the API actually served.
   * On refusal, Retry-After is the seconds until the oldest recorded request
   * ages out of the window. The hold (processingMs) is done by the Worker, not
   * here: sleeping inside the single-instance DO would serialise every call and
   * hide the very concurrency this demo exists to show.
   */
  async admit(now: number): Promise<AdmitResult> {
    this.#prune(now);
    if (this.#served.length >= this.#config.limitPerWindow) {
      const oldest = this.#served[0] ?? now;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + this.#config.windowMs - now) / 1000)
      );
      this.#rejected_total += 1;
      await this.ctx.storage.put('rejectedTotal', this.#rejected_total);
      return { ok: false, retryAfterSeconds, processingMs: 0 };
    }
    this.#served.push(now);
    this.#served_total += 1;
    await this.ctx.storage.put('served', this.#served);
    await this.ctx.storage.put('servedTotal', this.#served_total);
    return {
      ok: true,
      retryAfterSeconds: 0,
      processingMs: this.#config.processingMs,
    };
  }

  /** The current window and counters, pruned to `now`. */
  rateLimit(now: number): Promise<RateLimitResponse> {
    this.#prune(now);
    const remaining = Math.max(
      0,
      this.#config.limitPerWindow - this.#served.length
    );
    // "Until the window next frees a slot" — the oldest served timestamp ageing
    // out. Zero when the window is already whole (nothing served).
    const oldest = this.#served[0];
    const resetInMs =
      oldest === undefined
        ? 0
        : Math.max(0, oldest + this.#config.windowMs - now);
    return Promise.resolve({
      limitPerWindow: this.#config.limitPerWindow,
      windowMs: this.#config.windowMs,
      processingMs: this.#config.processingMs,
      remaining,
      resetInMs,
      served: this.#served_total,
      rejected: this.#rejected_total,
    });
  }

  /**
   * Apply a config patch and return the fresh window. The Worker has already
   * validated each field is a whole number, so this only merges and persists.
   * Applied immediately: the next `/api` call sees the new limit.
   */
  async configure(
    patch: Partial<MockConfig>,
    now: number
  ): Promise<RateLimitResponse> {
    this.#config = { ...this.#config, ...patch };
    await this.ctx.storage.put('config', this.#config);
    return this.rateLimit(now);
  }

  /** Clear the served timestamps and counters; the config is left untouched. */
  async reset(): Promise<void> {
    this.#served = [];
    this.#served_total = 0;
    this.#rejected_total = 0;
    await this.ctx.storage.put('served', this.#served);
    await this.ctx.storage.put('servedTotal', this.#served_total);
    await this.ctx.storage.put('rejectedTotal', this.#rejected_total);
  }
}

function mockStub(env: Env): MockApiRpc {
  // The declared `MockApiRpc` return type widens the stub to the hand-written
  // surface exactly once. The namespace is typed to `MockApiDO`, whose methods
  // are all concrete, so no cast is needed.
  return env.MOCK.getByName(MOCK_INSTANCE);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A whole number `>= min`, or `undefined` when the field was absent or invalid. */
function wholeNumber(value: unknown, min: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    return undefined;
  }
  return value;
}

interface ConfigureBody {
  limitPerWindow?: unknown;
  windowMs?: unknown;
  windowSeconds?: unknown;
  processingMs?: unknown;
}

/**
 * Build a validated config patch from the request body. Whole numbers only; a
 * bad or absent field is simply left unchanged. `windowMs` wins over
 * `windowSeconds` if both arrive, and `processingMs` is capped so the demo
 * cannot be wedged behind a multi-second hold.
 */
function patchFromBody(body: ConfigureBody): Partial<MockConfig> {
  const patch: Partial<MockConfig> = {};

  const limit = wholeNumber(body.limitPerWindow, 1);
  if (limit !== undefined) patch.limitPerWindow = limit;

  const windowMs = wholeNumber(body.windowMs, 1);
  const windowSeconds = wholeNumber(body.windowSeconds, 1);
  if (windowMs !== undefined) {
    patch.windowMs = windowMs;
  } else if (windowSeconds !== undefined) {
    patch.windowMs = windowSeconds * 1000;
  }

  const processingMs = wholeNumber(body.processingMs, 0);
  if (processingMs !== undefined) {
    patch.processingMs = Math.min(processingMs, MAX_PROCESSING_MS);
  }

  return patch;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // ── The fake API ─────────────────────────────────────────────────────
    if (url.pathname === '/api') {
      const decision = await mockStub(env).admit(Date.now());
      if (!decision.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: 'upstream rate limit' }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': String(decision.retryAfterSeconds),
            },
          }
        );
      }
      // Hold the caller for a beat so concurrent calls visibly overlap — this
      // is what keeps the limiter's concurrency slot occupied, since the client
      // awaits the callback. Done here, not in the DO, so the single instance
      // is not serialised behind each hold.
      if (decision.processingMs > 0) await sleep(decision.processingMs);
      return json({ ok: true, servedAt: Date.now() });
    }

    // ── Observability, outside the rate limit's own scope ────────────────
    if (url.pathname === '/rate-limit') {
      return json(await mockStub(env).rateLimit(Date.now()));
    }

    // ── Reconfigure the mock (whole numbers, applied immediately) ────────
    if (url.pathname === '/configure' && method === 'POST') {
      const body = await request.json<ConfigureBody>();
      const stats = await mockStub(env).configure(
        patchFromBody(body),
        Date.now()
      );
      return json(stats);
    }

    // ── Clear the window and counters ────────────────────────────────────
    if (url.pathname === '/reset' && method === 'POST') {
      await mockStub(env).reset();
      return new Response(null, { status: 204 });
    }

    // ── Identity ─────────────────────────────────────────────────────────
    if (url.pathname === '/') {
      return new Response(
        'drl-example-upstream — a mock third-party API.\n\n' +
          '  GET  /api          the fake API (admit-or-429, held processingMs)\n' +
          '  GET  /rate-limit   the current window and counters\n' +
          '  POST /configure    { limitPerWindow?, windowMs? | windowSeconds?, processingMs? }\n' +
          '  POST /reset        clear served timestamps and counters\n',
        { headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }

    return new Response('not found', { status: 404 });
  },
};
