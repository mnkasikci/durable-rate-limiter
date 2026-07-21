/**
 * Which binding a limiter reaches through — and nothing else.
 *
 * A binder is pure captured configuration: a string, plus the knowledge of how
 * to turn `(env, instanceName)` into a stub. It performs no I/O and touches no
 * `env`, so `defineBinder('RATE_LIMITER')` is safe at module scope. `env` does
 * not exist there anyway, which is why `.for(env)` is a separate step.
 *
 * ## Two names, routinely conflated
 *
 * - **binding name** (`RATE_LIMITER`) — the key in `env`, from `wrangler.jsonc`
 * - **instance name** (`google-docs`) — passed to `idFromName`, picks the bucket
 *
 * They are many-to-one: one class, one binding, several independent limiters.
 * A binder is declared once and reused by every limiter in the application.
 */

import type { CallReport } from '../core/index.js';

/**
 * The consumer's generated `Env`, merged in from their own `wrangler types`
 * output.
 *
 * `wrangler types` emits `interface Env { ... }` at global scope, and this
 * empty declaration merges with it. When a consumer has not generated types
 * there is nothing to merge, `Env` stays empty, `DoBindings<Env>` is `never`,
 * and `defineBinder` refuses every argument — which is precisely the case
 * `defineBinder.unchecked` exists for. An unhelpful-looking compile error that
 * points at a documented escape hatch beats silently checking nothing.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Env {}
}

/**
 * The keys of `E` whose values are actually Durable Object namespaces.
 *
 * This is the whole type-level check: a typo is not a key of `Env`, and a KV or
 * D1 binding is a key whose value fails the `extends`, so both map to `never`
 * and neither compiles. Types erase, so it costs nothing at runtime.
 *
 * The probe is `idFromName` returning a `DurableObjectId` rather than
 * `DurableObjectNamespace` itself. `DurableObjectNamespace<T>` is covariant in
 * `T` — it hands back a `DurableObjectStub<T>` — so there is no single instance
 * of it that every binding is assignable to, and matching structurally on the
 * one method no other binding type has avoids the problem entirely. `KVNamespace`
 * and `D1Database` have no `idFromName`; nothing else returns a `DurableObjectId`.
 */
export type DoBindings<E> = {
  [K in keyof E]: E[K] extends { idFromName(name: string): DurableObjectId }
    ? K
    : never;
}[keyof E];

/**
 * The Durable Object surface this package needs, written out by hand.
 *
 * Measured, not assumed: `DurableObjectStub<LimiterDO>['execute']` resolves to
 * **`never`**. Generic methods erase through a stub — including ones whose type
 * parameter is inferred from an argument, which the received wisdom says
 * survive. `never` is assignable to everything, so the loss produces no error
 * at any call site; type checking simply stops.
 *
 * Declaring the surface and asserting a stub to it exactly once (in
 * {@link stubFrom}) confines that erasure to a single line instead of letting
 * `never` leak into every consumer's call.
 */
export interface LimiterStub {
  execute<T>(fn: () => Promise<CallReport<T>>): Promise<T>;
}

/**
 * The minimum of `DurableObjectNamespace` this package uses.
 *
 * Structural and generic in the id type so that a real namespace, and a plain
 * object handing back a fake stub, both satisfy it — that is what lets
 * {@link defineTestBinder} return the same `Binder` type as the real thing.
 */
export interface NamespaceLike<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): unknown;
}

/** Inert captured configuration. Reused across every limiter in an app. */
export interface Binder {
  /**
   * The key looked up on `env`, or `null` for a binder that was handed a
   * namespace directly and never looks at `env` at all.
   */
  readonly bindingName: string | null;
  /**
   * Resolve a stub for one named limiter instance. Called from `.for(env)`,
   * never at module scope.
   */
  stubFor(env: object, instanceName: string): LimiterStub;
}

function isNamespaceLike(value: unknown): value is NamespaceLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NamespaceLike>;
  return (
    typeof candidate.idFromName === 'function' &&
    typeof candidate.get === 'function'
  );
}

/**
 * Names every Durable Object binding actually present, because the useful half
 * of "not found" is knowing what *was* found. A one-character typo is obvious
 * next to the real name and invisible on its own.
 */
function availableBindings(env: object): string {
  const names = Object.entries(env)
    .filter(([, value]) => isNamespaceLike(value))
    .map(([key]) => key);
  const list = names.length === 0 ? '(none)' : names.join(', ');
  return `Available Durable Object bindings: ${list}.`;
}

/**
 * The one place a stub's type is asserted — see {@link LimiterStub} for why
 * that matters and why it must stay one place.
 */
function stubFrom(namespace: NamespaceLike, instanceName: string): LimiterStub {
  return namespace.get(namespace.idFromName(instanceName)) as LimiterStub;
}

/**
 * The runtime half of the check, run at `.for(env)` — the first moment `env`
 * exists.
 *
 * A check against `wrangler.jsonc` is not possible: the config file is not part
 * of the deployed bundle. This covers consumers who have not generated `Env`,
 * where the type layer gives nothing at all.
 */
function resolveNamespace(env: object, bindingName: string): NamespaceLike {
  const value = (env as Record<string, unknown>)[bindingName];
  if (value === undefined) {
    throw new Error(
      `Binding "${bindingName}" not found on env.\n${availableBindings(env)}`
    );
  }
  if (!isNamespaceLike(value)) {
    throw new Error(
      `Binding "${bindingName}" on env is not a Durable Object namespace.\n` +
        availableBindings(env)
    );
  }
  return value;
}

function binderForName(bindingName: string): Binder {
  return {
    bindingName,
    stubFor: (env, instanceName) =>
      stubFrom(resolveNamespace(env, bindingName), instanceName),
  };
}

/**
 * Name the Durable Object binding a limiter reaches through, checked against
 * the consumer's generated `Env`.
 *
 * ```ts
 * const binder = defineBinder('RATE_LIMITER');
 * ```
 *
 * A typo fails to compile, and so does pointing at a KV or D1 binding by
 * mistake. Declared once at module scope and shared by every limiter.
 */
export function defineBinder(
  bindingName: Extract<DoBindings<Env>, string>
): Binder {
  return binderForName(bindingName);
}

/**
 * The escape hatch for consumers without a generated `Env`.
 *
 * Nothing is checked at compile time — the runtime presence check at
 * `.for(env)` is all that remains, and it names the bindings it did find.
 * Explicit, so the absence of type checking is visible at the call site rather
 * than inferred from a mysteriously permissive signature.
 */
defineBinder.unchecked = function unchecked(bindingName: string): Binder {
  return binderForName(bindingName);
};

/**
 * Inject a namespace directly, for genuine unit tests outside workerd.
 *
 * Returns the same `Binder` type as {@link defineBinder}, so the module under
 * test is unchanged.
 *
 * Most tests need no seam at all: under `@cloudflare/vitest-pool-workers` the
 * test environment is built *from* `wrangler.jsonc`, so the real binding exists
 * and is backed by a local Durable Object. This is for the tests that run
 * outside that.
 *
 * Deliberately not an allowlisted magic binding name (`"mockBinder"`,
 * `"testBinder"`). That would be invisible coupling, it would silently weaken
 * the check for anyone whose real binding happened to match, and it would put a
 * test concern in the production path — which is the thing the check exists to
 * protect. A named, typed injection point is discoverable; a magic string is
 * folklore.
 */
export function defineTestBinder<Id>(namespace: NamespaceLike<Id>): Binder {
  return {
    bindingName: null,
    stubFor: (_env, instanceName) => stubFrom(namespace, instanceName),
  };
}
