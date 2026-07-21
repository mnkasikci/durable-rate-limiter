import { DurableObject } from 'cloudflare:workers';

/**
 * Where probe results land.
 *
 * A Durable Object rather than KV, on purpose. Probe instances finish at
 * unpredictable times and the report is read immediately afterwards, so KV's
 * eventual consistency would show a half-finished picture — and a write that
 * has not propagated yet is indistinguishable from an instance that died. The
 * one thing this harness must be able to say precisely is "N of N reported".
 *
 * It also removes a manual setup step: no namespace id to create and paste
 * into a config. And because each instance writes its own key, concurrent
 * writers never read-modify-write over each other.
 *
 * No generic methods below. Generics do not survive the RPC boundary — a
 * stub's method type arguments are erased to `never`, silently, because
 * `never` is assignable to everything. Concrete signatures only. (This is the
 * same erasure the package documents on `LimiterRpc`, met from the other
 * side.)
 */

/** One `limiter.call()`, as observed from inside the caller's isolate. */
export interface ProbeCallRecord {
  label: string;
  index: number;
  /** ms after the shared stampede instant that `call()` was invoked. */
  requestedAt: number;
  /** ms after the stampede instant that the callback actually fired. */
  ranAt: number | null;
  /** ms after the stampede instant that `call()` settled. */
  settledAt: number;
  /** `ranAt - requestedAt`: how long the limiter parked this caller. */
  waitedMs: number | null;
  ok: boolean;
  /** How many times the callback ran. > 1 means the scheduler retried. */
  attempts: number;
  /**
   * How many times this caller was dropped while parked, recovered or not.
   *
   * Without this the harness would stop being able to measure the thing it
   * was built to measure: the client now retries drops, so a recovered one
   * shows up as a plain success and the drop rate reads as zero.
   *
   * Optional because it is: records persisted by a probe that ran before this
   * field existed do not have it, and the report is routinely read against
   * older probe ids. Declaring it required would be the type lying about data
   * already on disk, and would turn a missing value into `NaN` in the totals.
   */
  drops?: number;
  /** `name: message` of the rejection, when there was one. */
  error?: string;
}

export interface ProbeInstanceResult {
  label: string;
  startAtMs: number;
  records: ProbeCallRecord[];
  /** Set when the instance itself blew up rather than an individual call. */
  fatalError?: string;
}

export type Via = 'service' | 'direct';

export interface ProbeConfig {
  probeId: string;
  via: Via;
  instances: number;
  callsPerInstance: number;
  callsPerStep: number;
  holdMs: number;
  /** The shared instant every instance sleeps until. */
  startAtMs: number;
  capacity: number;
  fillPerWindow: number;
  windowInMs: number;
  concurrency: number;
  /** 1-based call index that answers 429 once; 0 disables. */
  simulate429OnCall: number;
  retryAfterSeconds: number;
}

export class ProbeCollectorDO extends DurableObject<Env> {
  async putConfig(probeId: string, config: ProbeConfig): Promise<void> {
    await this.ctx.storage.put(`config:${probeId}`, config);
  }

  async getConfig(probeId: string): Promise<ProbeConfig | undefined> {
    return this.ctx.storage.get<ProbeConfig>(`config:${probeId}`);
  }

  /** One key per instance, so concurrent writers cannot lose each other. */
  async record(probeId: string, result: ProbeInstanceResult): Promise<void> {
    await this.ctx.storage.put(`result:${probeId}:${result.label}`, result);
  }

  async results(probeId: string): Promise<ProbeInstanceResult[]> {
    const map = await this.ctx.storage.list<ProbeInstanceResult>({
      prefix: `result:${probeId}:`,
    });
    return [...map.values()];
  }
}
