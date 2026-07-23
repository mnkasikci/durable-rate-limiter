import { describe, expect, it } from 'vitest';

import {
  bindingFragment,
  configureModuleSource,
  hasTopLevelKey,
  insertFragment,
  isValidBindingName,
  isValidInstanceName,
  isValidUpstreamLimit,
  isValidWorkerName,
  limiterModuleSource,
  limiterWorkerSource,
  limiterWranglerConfig,
  limitsFileSource,
  limitsPayload,
  parseLimits,
  sampleLimitsFileSource,
  toIdentifier,
} from './plan.js';
import { endpoint, extractDeployedUrl } from './state.js';

describe('the upstream limit', () => {
  it('accepts a whole limit of at least 1, which maps 1:1', () => {
    // No splitting: "1 per window" is a legal limiter, so 1 is the floor.
    expect(isValidUpstreamLimit('1')).toBe(true);
    expect(isValidUpstreamLimit('60')).toBe(true);
    expect(isValidUpstreamLimit('0')).toBe(false);
    expect(isValidUpstreamLimit('2.5')).toBe(false);
    expect(isValidUpstreamLimit('lots')).toBe(false);
  });
});

describe('names', () => {
  it('accepts Worker names Cloudflare accepts', () => {
    expect(isValidWorkerName('my-limiter')).toBe(true);
    expect(isValidWorkerName('My_Limiter')).toBe(false);
    expect(isValidWorkerName('-leading')).toBe(false);
  });

  it('requires a binding name to be usable as a key of env', () => {
    expect(isValidBindingName('RATE_LIMITER')).toBe(true);
    expect(isValidBindingName('rate-limiter')).toBe(false);
  });

  it('accepts instance names that read unambiguously', () => {
    expect(isValidInstanceName('example-api')).toBe(true);
    expect(isValidInstanceName('billing.api_v2')).toBe(true);
    expect(isValidInstanceName('two words')).toBe(false);
  });

  it('turns an instance name into an identifier', () => {
    expect(toIdentifier('example-api')).toBe('exampleApi');
    expect(toIdentifier('billing.api_v2')).toBe('billingApiV2');
    expect(toIdentifier('2fa')).toBe('fa');
  });
});

describe('generated config', () => {
  it('gives the limiter Worker a migration and the consumer none', () => {
    expect(
      limiterWranglerConfig({
        workerName: 'my-limiter',
        compatibilityDate: '2025-07-01',
      })
    ).toContain('"migrations"');

    const consumer = bindingFragment({
      topology: 'direct',
      format: 'jsonc',
      bindingName: 'RATE_LIMITER',
      workerName: 'my-limiter',
    });
    expect(consumer).toContain('"script_name": "my-limiter"');
    // Named only in the comment explaining why it is absent.
    expect(consumer).not.toMatch(/^\s*"migrations"\s*:/m);
  });

  it('names the entrypoint on a service binding', () => {
    const fragment = bindingFragment({
      topology: 'service',
      format: 'jsonc',
      bindingName: 'LIMITER',
      workerName: 'my-limiter',
    });
    expect(fragment).toContain('"entrypoint": "LimiterEntrypoint"');
  });

  it('emits TOML for a TOML consumer', () => {
    expect(
      bindingFragment({
        topology: 'direct',
        format: 'toml',
        bindingName: 'RATE_LIMITER',
        workerName: 'my-limiter',
      })
    ).toContain('[[durable_objects.bindings]]');
  });
});

describe('the limiter Worker', () => {
  it('is a bare re-export when there is no config route', () => {
    const source = limiterWorkerSource({ configRoute: false });
    expect(source).toContain('export { LimiterDO, LimiterEntrypoint }');
    expect(source).not.toContain('/configure');
    expect(source).not.toContain('DRL_CONFIG_KEY');
  });

  it('denies the config route when the secret is unset', () => {
    const source = limiterWorkerSource({ configRoute: true });
    // The guard must fail closed: no secret means no access, never open access.
    expect(source).toContain(
      "if (expected === undefined || expected === '' || provided === null) {"
    );
    expect(source).toContain('return false;');
    expect(source).toContain("new Response('unauthorized', { status: 401 })");
  });

  it('takes its limits from the request, not from its own bundle', () => {
    // The whole point of the arrangement: nothing the Worker imports holds a
    // limit, so a limit can change without the Worker being rebuilt.
    const source = limiterWorkerSource({ configRoute: true });
    expect(source).not.toContain("from './limits.js'");
    expect(source).toContain('await request.json()');
    expect(source).toContain('.configure(name, config)');
  });

  it('refuses a GET on /configure, so a stale build cannot answer one', () => {
    const source = limiterWorkerSource({ configRoute: true });
    expect(source).toContain("request.method !== 'POST'");
    expect(source).toContain("new Response('POST required', { status: 405 })");
  });

  it('asks the registry which buckets exist rather than being told', () => {
    const source = limiterWorkerSource({ configRoute: true });
    expect(source).toContain('stubFor(env, REGISTRY_NAME)');
    expect(source).toContain('registry.listNames()');
  });

  it('prunes a listed name with no bucket behind it while reading', () => {
    // Repair on the read path, which is what makes the registry converge after
    // a creation that failed between registering and configuring.
    const source = limiterWorkerSource({ configRoute: true });
    expect(source).toContain('registry.unregisterName(name)');
  });
});

describe('the limits file', () => {
  const entries = [
    {
      name: 'read-api',
      bucket: { limitPerWindow: 60, windowInMs: 60_000 },
      concurrency: 5,
    },
    {
      name: 'write-api',
      bucket: { limitPerWindow: 30, windowInMs: 60_000 },
      concurrency: 2,
    },
  ];

  it('round-trips what it was given', () => {
    // The generator and the parser are the two ends of the same wire. If they
    // ever disagree, `stats --save` writes a file `configure` cannot read.
    const parsed = parseLimits(limitsFileSource(entries));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.entries).toHaveLength(2);
    expect(parsed.file.entries[0]).toMatchObject(entries[0] ?? {});
    expect(parsed.file.source).toBeUndefined();
  });

  it('says plainly that it is not read at runtime', () => {
    const source = limitsFileSource(entries);
    expect(source).toContain('NOT read at runtime');
    expect(source).toContain('No redeploy');
  });

  it('marks the sample as a sample, in the file and not only in a comment', () => {
    // A header comment cannot stop `configure`. The parsed marker can.
    const parsed = parseLimits(sampleLimitsFileSource());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.source).toBe('sample');
  });

  it('survives the comments it exists to carry', () => {
    const edited = limitsFileSource(entries).replace(
      '"concurrency": 5',
      '// upstream said 5 was the ceiling, 2024-11\n      "concurrency": 5'
    );
    const parsed = parseLimits(edited);
    expect(parsed.ok).toBe(true);
  });

  it('collects every problem rather than only the first', () => {
    const parsed = parseLimits(`{
      "limits": {
        "good": { "bucket": { "limitPerWindow": 1, "windowInMs": 1 }, "concurrency": 0 },
        "also-bad": { "bucket": { "limitPerWindow": 0, "windowInMs": 1 }, "concurrency": 1 }
      }
    }`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems[0]).toContain('concurrency');
    expect(parsed.problems[1]).toContain('limitPerWindow');
  });

  it('rejects a file with nothing in it to apply', () => {
    expect(parseLimits('{ "limits": {} }')).toMatchObject({ ok: false });
    expect(parseLimits('{}')).toMatchObject({ ok: false });
    expect(parseLimits('[]')).toMatchObject({ ok: false });
    expect(parseLimits('not json')).toMatchObject({ ok: false });
  });

  it('rejects an entry shaped wrongly rather than guessing at it', () => {
    expect(parseLimits('{ "limits": { "a": 3 } }')).toMatchObject({
      ok: false,
    });
    expect(parseLimits('{ "limits": { "a": {} } }')).toMatchObject({
      ok: false,
    });
    expect(
      parseLimits(
        '{ "limits": { " bad name": { "bucket": { "limitPerWindow": 1, "windowInMs": 1 }, "concurrency": 1 } } }'
      )
    ).toMatchObject({ ok: false });
    expect(
      parseLimits(
        '{ "limits": { "a": { "bucket": { "limitPerWindow": 1, "windowInMs": 1 }, "concurrency": 1, "retry": 9 } } }'
      )
    ).toMatchObject({ ok: false });
  });

  it('sends the object what it expects, keyed by name', () => {
    const payload = limitsPayload(entries);
    expect(Object.keys(payload)).toEqual(['read-api', 'write-api']);
    expect(payload['read-api']).toMatchObject({
      bucket: { limitPerWindow: 60 },
      concurrency: 5,
      retry: { maxRetries: 3 },
    });
  });
});

describe('talking to a deployed limiter', () => {
  it('reads the origin out of wrangler deploy output', () => {
    const output = [
      'Total Upload: 21.51 KiB / gzip: 4.72 KiB',
      'Deployed durable-rate-limiter triggers (0.51 sec)',
      '  https://durable-rate-limiter.my-account.workers.dev',
      'Current Version ID: 1234',
    ].join('\n');
    expect(extractDeployedUrl(output)).toBe(
      'https://durable-rate-limiter.my-account.workers.dev'
    );
    expect(extractDeployedUrl('no url here')).toBeUndefined();
  });

  it('builds the guarded endpoint, escaping the key', () => {
    expect(
      endpoint('https://limiter.example.workers.dev', 'configure', 'a b&c')
    ).toBe('https://limiter.example.workers.dev/configure?key=a+b%26c');
    expect(endpoint('https://limiter.example.workers.dev/', 'stats', 'k')).toBe(
      'https://limiter.example.workers.dev/stats?key=k'
    );
  });
});

describe('generated modules', () => {
  it('writes the instance name exactly once', () => {
    const source = limiterModuleSource({
      topology: 'direct',
      bindingName: 'RATE_LIMITER',
      instanceName: 'example-api',
    });
    expect(source.match(/'example-api'/g)).toHaveLength(1);
    expect(source).toContain("defineBinder('RATE_LIMITER')");
  });

  it('reaches the service topology through defineTestBinder', () => {
    const source = limiterModuleSource({
      topology: 'service',
      bindingName: 'LIMITER',
      instanceName: 'example-api',
    });
    expect(source).toContain('defineTestBinder');
    expect(source).toContain('env.LIMITER.execute(name, fn)');
  });

  it('configures through the stub directly, or the entrypoint by name', () => {
    const bucket = { limitPerWindow: 60, windowInMs: 60_000 };
    const direct = configureModuleSource({
      topology: 'direct',
      bindingName: 'RATE_LIMITER',
      instanceName: 'example-api',
      bucket,
      concurrency: 5,
    });
    expect(direct).toContain('as unknown as LimiterRpc');
    expect(direct).toContain('limitPerWindow: 60');

    const service = configureModuleSource({
      topology: 'service',
      bindingName: 'LIMITER',
      instanceName: 'example-api',
      bucket,
      concurrency: 5,
    });
    expect(service).toContain("env.LIMITER.configure('example-api'");
  });
});

describe('editing an existing config', () => {
  const jsonc = `{\n  // a comment worth keeping\n  "name": "app",\n}\n`;

  it('inserts without reserialising, so comments survive', () => {
    const result = insertFragment(
      jsonc,
      bindingFragment({
        topology: 'direct',
        format: 'jsonc',
        bindingName: 'RATE_LIMITER',
        workerName: 'my-limiter',
      }),
      'jsonc'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('// a comment worth keeping');
    expect(result.text).toContain('"name": "app"');
    expect(result.text).toContain('"class_name": "LimiterDO"');
    expect(result.text.indexOf('durable_objects')).toBeLessThan(
      result.text.indexOf('"name": "app"')
    );
  });

  it('appends to TOML, where order does not matter', () => {
    const result = insertFragment('name = "app"\n', '[[services]]\n', 'toml');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('name = "app"\n\n[[services]]\n');
  });

  it('refuses a file it cannot place the fragment in', () => {
    const result = insertFragment('not a config', 'x', 'jsonc');
    expect(result.ok).toBe(false);
  });

  it('detects an existing key in either format', () => {
    expect(hasTopLevelKey('{ "durable_objects": {} }', 'durable_objects')).toBe(
      true
    );
    expect(
      hasTopLevelKey('[[durable_objects.bindings]]', 'durable_objects')
    ).toBe(true);
    expect(hasTopLevelKey(jsonc, 'durable_objects')).toBe(false);
    expect(hasTopLevelKey(jsonc, 'services')).toBe(false);
  });
});
