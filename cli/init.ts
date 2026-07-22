/**
 * `durable-rate-limiter init` — the README's five steps, asked rather than read.
 *
 * The order is not cosmetic. The limiter Worker is deployed first because a
 * consumer's binding names it and the binding cannot be created before the
 * Worker it names exists; the binding is written before `wrangler types`
 * because that is what makes `defineBinder` typecheck; the limiter module is
 * written before the configure module because the instance name it fixes is
 * the argument the other one needs.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  LIMITS_FILE,
  bindingFragment,
  configureModuleSource,
  hasTopLevelKey,
  insertFragment,
  limitsFileSource,
  limitsPayload,
  isValidBindingName,
  isValidConcurrency,
  isValidInstanceName,
  isValidUpstreamLimit,
  isValidWindow,
  isValidWorkerName,
  limiterModuleSource,
  limiterWorkerSource,
  limiterWranglerConfig,
  sizeBucket,
  toIdentifier,
  type ConfigFormat,
  type Topology,
} from './plan.js';
import {
  Prompter,
  bold,
  cyan,
  dim,
  green,
  heading,
  red,
  say,
  sayKeyRecovery,
  yellow,
} from './prompt.js';
import {
  endpoint,
  extractDeployedUrl,
  statePath,
  writeState,
  type ProjectState,
} from './state.js';

export interface InitOptions {
  cwd: string;
  assumeYes: boolean;
}

/**
 * Named after the package and the class it exports, not after the application
 * running `init`. It is a shared piece of infrastructure — the second consumer
 * binds the same Worker, and `my-limiter` in someone else's account tells them
 * nothing about what it is.
 */
const DEFAULT_WORKER_NAME = 'durable-rate-limiter';

export async function init(options: InitOptions): Promise<number> {
  const { cwd } = options;
  const prompter = new Prompter(options.assumeYes);
  const done: string[] = [];
  const todo: string[] = [];

  try {
    say();
    say(bold('durable-rate-limiter init'));
    say(
      dim(
        'Sets up the limiter Worker, the binding, the limiter module and its limits.'
      )
    );
    say(dim('Nothing is written or run without being shown to you first.'));

    // --- 0. before anything is touched --------------------------------------
    heading('Before you start');
    say(
      'This writes files into your project and edits your wrangler config.\n' +
        'Commit first, so you can read exactly what it did as a diff — and undo\n' +
        'it with one command if you would rather do it by hand.'
    );
    say();

    const dirty = gitStatus(cwd);
    if (dirty === 'dirty') {
      say(yellow('  ! you have uncommitted changes'));
    } else if (dirty === 'clean') {
      say(green('  ✓ working tree is clean'));
    } else {
      say(dim('  (not a git repository — nothing to compare against)'));
    }

    say();
    say(
      dim(
        'Nothing has been changed so far. Ctrl-C now costs you nothing: commit,\n' +
          '  then run this again.'
      )
    );
    if (!(await prompter.confirm('Ready to continue?', true))) {
      say();
      say(dim('nothing was written'));
      return 0;
    }

    // --- 1. the limiter Worker ---------------------------------------------
    heading('1. The limiter Worker');
    say(
      dim(
        'The object must live in a Worker of its own — a Worker implementing a\n' +
          '  Durable Object gets no preview URLs, and a new DO migration cannot be\n' +
          '  uploaded as a version.'
      )
    );

    const workerName = await prompter.ask('Name for the limiter Worker?', {
      default: DEFAULT_WORKER_NAME,
      hint:
        'Every consumer names this Worker in its binding, and one limiter\n' +
        '  Worker serves all of them — so name it after what it is, not after\n' +
        '  the application setting it up.',
      validate: (value) =>
        isValidWorkerName(value)
          ? null
          : 'lowercase letters, digits and dashes only',
    });

    const limiterDir = await prompter.ask('Where should it be scaffolded?', {
      default: DEFAULT_WORKER_NAME,
    });

    say();
    say(
      dim(
        '`configure` is a method on the Durable Object, so only a deployed\n' +
          '  Worker can reach it — there is no wrangler command that can. If this\n' +
          '  Worker carries a key-guarded /configure route, your limits can live\n' +
          '  beside it as code and this CLI can apply them for you.'
      )
    );
    const configRoute = await prompter.confirm(
      'Add the /configure route to the limiter Worker?',
      true
    );

    const limiterRoot = path.resolve(cwd, limiterDir);
    const compatibilityDate = new Date().toISOString().slice(0, 10);

    const wroteSource = await writeIfAllowed(
      prompter,
      cwd,
      path.join(limiterRoot, 'src', 'index.ts'),
      limiterWorkerSource({ configRoute })
    );
    const wroteConfig = await writeIfAllowed(
      prompter,
      cwd,
      path.join(limiterRoot, 'wrangler.jsonc'),
      limiterWranglerConfig({ workerName, compatibilityDate })
    );
    if (wroteSource || wroteConfig) {
      done.push(`scaffolded the limiter Worker in ${rel(cwd, limiterRoot)}/`);
    }

    const limiterConfigPath = rel(
      cwd,
      path.join(limiterRoot, 'wrangler.jsonc')
    );

    say();
    say(
      dim(
        'It is deployed at the end, once its limits exist — nothing binds to it\n' +
          '  until your application is deployed, which happens after that.'
      )
    );

    // --- 2. the binding ----------------------------------------------------
    heading('2. Bind it from your application');

    const topology = await prompter.choose<Topology>('Which topology?', [
      {
        value: 'direct',
        label: 'Direct Durable Object binding (one hop)',
        detail:
          'Shortest correct path. Couples the consumer to the class name.',
      },
      {
        value: 'service',
        label: 'Service binding to LimiterEntrypoint (two hops)',
        detail:
          'A declared interface that can evolve independently. ~2 ms warm — the two are indistinguishable in practice.',
      },
    ]);

    const consumerConfigPath = await prompter.ask(
      "Path to the consuming application's wrangler config?",
      {
        default: detectConsumerConfig(cwd) ?? 'wrangler.jsonc',
        validate: (value) =>
          existsSync(path.resolve(cwd, value))
            ? null
            : 'no file there — the consumer config must already exist',
      }
    );

    const consumerConfig = path.resolve(cwd, consumerConfigPath);
    const consumerDir = path.dirname(consumerConfig);
    const format: ConfigFormat = consumerConfig.endsWith('.toml')
      ? 'toml'
      : 'jsonc';

    const bindingName = await prompter.ask('Binding name?', {
      default: topology === 'direct' ? 'RATE_LIMITER' : 'LIMITER',
      hint: 'The key in `env` — not the bucket name, which comes next.',
      validate: (value) =>
        isValidBindingName(value)
          ? null
          : 'must be a valid JavaScript identifier',
    });

    const fragment = bindingFragment({
      topology,
      format,
      bindingName,
      workerName,
    });
    const existing = await readFile(consumerConfig, 'utf8');
    const key = topology === 'direct' ? 'durable_objects' : 'services';

    say();
    say(dim(`  ${consumerConfigPath} needs:`));
    say();
    say(indent(fragment));

    if (hasTopLevelKey(existing, key)) {
      say(
        yellow(
          `  "${key}" already appears in ${consumerConfigPath} — merge the above by hand.`
        )
      );
      todo.push(`merge the ${key} binding into ${consumerConfigPath}`);
    } else if (
      await prompter.confirm(`Add it to ${consumerConfigPath}?`, true)
    ) {
      const result = insertFragment(existing, fragment, format);
      if (result.ok) {
        await writeFile(consumerConfig, result.text);
        done.push(`added the ${key} binding to ${consumerConfigPath}`);
      } else {
        say(red(`  ${result.reason}`));
        todo.push(`add the binding to ${consumerConfigPath} by hand`);
      }
    } else {
      todo.push(`add the binding to ${consumerConfigPath}`);
    }

    const typesCommand = [
      'wrangler',
      'types',
      '--config',
      rel(consumerDir, consumerConfig),
    ];
    if (
      topology === 'direct' &&
      (await prompter.confirm(
        `Run ${cyan(`npx ${typesCommand.join(' ')}`)} so defineBinder can typecheck the binding?`,
        true
      ))
    ) {
      const types = run('npx', typesCommand, consumerDir);
      if (types.status === 0) done.push('generated the consumer types');
      else
        todo.push(
          `run npx ${typesCommand.join(' ')} in ${rel(cwd, consumerDir)}`
        );
    } else if (topology === 'direct') {
      todo.push(
        `run npx ${typesCommand.join(' ')} in ${rel(cwd, consumerDir)}`
      );
    }

    // --- 3. the limiter module ---------------------------------------------
    heading('3. Define your first limiter');
    say(
      'One limiter per upstream limit — not one per application.\n' +
        dim(
          '  If service.com/api/read allows 60 requests a minute and\n' +
            '  service.com/api/write allows 30, those are two limiters with two\n' +
            '  names, and each call site uses the one belonging to its endpoint.\n' +
            '  They are independent buckets on the same class and the same\n' +
            '  binding, so adding the second one costs nothing: define it beside\n' +
            '  the first and give it its own name.\n\n' +
            '  Endpoints sharing one quota share one limiter — that is the point.'
        )
    );

    const instanceName = await prompter.ask(
      'Name for this first limiter (the bucket name)?',
      {
        default: 'example-api',
        hint:
          "`idFromName`'s argument. A typo does not error — it silently creates\n" +
          '  a second bucket pacing at the full rate against the same quota, so\n' +
          '  name it after the quota it protects.',
        validate: (value) =>
          isValidInstanceName(value)
            ? null
            : 'letters, digits, dots, dashes and underscores',
      }
    );

    const modulePath = await prompter.ask(
      'Where should the limiter module go?',
      {
        default: path.join(rel(cwd, consumerDir), 'src', 'limiter.ts'),
      }
    );

    const moduleAbs = path.resolve(cwd, modulePath);
    if (
      await writeIfAllowed(
        prompter,
        cwd,
        moduleAbs,
        limiterModuleSource({ topology, bindingName, instanceName })
      )
    ) {
      done.push(`wrote ${rel(cwd, moduleAbs)}`);
    }

    // --- 4/5. limits --------------------------------------------------------
    heading('4. Set your limits');
    say(
      dim(
        'Worst-case throughput is capacity + fillPerWindow — not fillPerWindow.\n' +
          '  A full bucket drains instantly and then refills over the same window,\n' +
          '  so both knobs together must fit under the upstream limit.'
      )
    );

    const upstreamLimit = Number(
      await prompter.ask("What is the upstream's limit, in calls per window?", {
        default: '60',
        validate: (value) =>
          isValidUpstreamLimit(value) ? null : 'a whole number, at least 2',
      })
    );
    const windowInMs = Number(
      await prompter.ask('Window length in milliseconds?', {
        default: '60000',
        validate: (value) =>
          isValidWindow(value) ? null : 'a positive whole number',
      })
    );
    const concurrency = Number(
      await prompter.ask('Maximum calls in flight at once?', {
        default: '5',
        validate: (value) =>
          isValidConcurrency(value) ? null : 'a whole number, at least 1',
      })
    );

    const bucket = sizeBucket(upstreamLimit, windowInMs);
    say();
    say(
      `  ${green('sized')} capacity ${bold(String(bucket.capacity))} + fillPerWindow ${bold(
        String(bucket.fillPerWindow)
      )} = ${bold(String(upstreamLimit))} per ${String(windowInMs)} ms — the true worst case.`
    );

    if (!configRoute) {
      // No route means no way in from outside, so the caller has to make the
      // call from inside a Worker themselves.
      const configurePath = path.join(
        path.dirname(moduleAbs),
        'configure-limiter.ts'
      );
      if (
        await writeIfAllowed(
          prompter,
          cwd,
          configurePath,
          configureModuleSource({
            topology,
            bindingName,
            instanceName,
            bucket,
            concurrency,
          })
        )
      ) {
        done.push(`wrote ${rel(cwd, configurePath)}`);
      }
      todo.push(
        'call configureLimiter(env) once — deploy script, admin route, or guarded first run'
      );
      todo.push(
        `deploy the limiter Worker: npx wrangler deploy --config ${limiterConfigPath}`
      );
    } else {
      const entries = [{ name: instanceName, bucket, concurrency }];
      const limitsPath = path.join(limiterRoot, LIMITS_FILE);
      if (
        await writeIfAllowed(
          prompter,
          cwd,
          limitsPath,
          limitsFileSource(entries)
        )
      ) {
        done.push(`wrote ${rel(cwd, limitsPath)} — your limits, editable`);
      }

      // Inside the limiter's own folder, with paths relative to it — the
      // consumer gains one directory, not a directory plus a root dotfile.
      const state: ProjectState = {
        workerName,
        limiterConfig: 'wrangler.jsonc',
        limitsFile: LIMITS_FILE,
      };
      await writeState(limiterRoot, state);
      done.push(`wrote ${rel(cwd, statePath(limiterRoot))}`);

      // --- 5. deploy and apply ---------------------------------------------
      heading('5. Deploy the limiter and apply the limits');
      say(
        dim(
          'The Worker is deployed once. The limits are uploaded separately, over\n' +
            '  its /configure route — which is why changing one later costs a\n' +
            '  `configure` and no deploy at all. Both happen here.'
        )
      );

      const deployCommand = [
        'wrangler',
        'deploy',
        '--config',
        limiterConfigPath,
      ];
      const applyByHand = [
        `deploy the limiter Worker: npx ${deployCommand.join(' ')}`,
        'set the secret: npx wrangler secret put DRL_CONFIG_KEY --config ' +
          limiterConfigPath,
        'apply the limits: npx @bakidev/durable-rate-limiter configure',
      ];

      if (
        !(await prompter.confirm(
          `Deploy it now (${cyan(`npx ${deployCommand.join(' ')}`)})?`,
          false
        ))
      ) {
        todo.push(...applyByHand);
      } else {
        const deployed = run('npx', deployCommand, cwd);
        if (deployed.status !== 0) {
          say(red(`  deploy exited with ${String(deployed.status)}`));
          todo.push(...applyByHand);
        } else {
          done.push('deployed the limiter Worker');

          const url =
            extractDeployedUrl(deployed.stdout) ??
            (await prompter.ask("The limiter Worker's URL?", {
              hint: 'Could not read it from the deploy output.',
              validate: (value) => (URL.canParse(value) ? null : 'not a URL'),
            }));
          await writeState(limiterRoot, { ...state, url });

          say();
          say(
            dim(
              'The /configure and /stats routes are internet-facing and deny\n' +
                '  everything until DRL_CONFIG_KEY is set. Set it now.'
            )
          );
          const key = await prompter.ask('A key to guard those routes?', {
            default: generateKey(),
            hint:
              'A generated one is offered. It becomes the DRL_CONFIG_KEY secret on\n' +
              '  the limiter Worker — the same name this CLI reads from your\n' +
              '  environment, so `export DRL_CONFIG_KEY=…` and it stops asking.',
          });

          const secret = run(
            'npx',
            [
              'wrangler',
              'secret',
              'put',
              'DRL_CONFIG_KEY',
              '--config',
              limiterConfigPath,
            ],
            cwd,
            key
          );

          if (secret.status !== 0) {
            say(red('  could not set the secret'));
            todo.push(...applyByHand.slice(1));
          } else {
            done.push('set DRL_CONFIG_KEY on the limiter Worker');
            const applied = await applyLimits(url, key, limitsPayload(entries));
            if (applied) done.push('applied the limits — the bucket is live');
            else
              todo.push(
                'apply the limits: npx @bakidev/durable-rate-limiter configure'
              );
          }

          say();
          say(dim(`  To change a limit: edit ${LIMITS_FILE}, then:`));
          say(
            `    ${cyan('npx @bakidev/durable-rate-limiter configure')}   ${dim('(uploads it — no redeploy)')}`
          );
          say(
            `    ${cyan('npx @bakidev/durable-rate-limiter stats')}       ${dim('(reads every bucket back)')}`
          );
          say();
          sayKeyRecovery(workerName, limiterConfigPath);
        }
      }
    }

    // --- summary ------------------------------------------------------------
    heading('Done');
    for (const line of done) say(`  ${green('✓')} ${line}`);
    if (todo.length > 0) {
      say();
      say(bold('Still to do:'));
      for (const line of todo) say(`  ${yellow('•')} ${line}`);
    }

    const ident =
      topology === 'direct'
        ? toIdentifier(instanceName)
        : `${toIdentifier(instanceName)}For`;
    say();
    say('Then, anywhere you have `env`:');
    say(
      dim(
        '  a fetch or scheduled handler, a queue consumer, a Workflow step, a\n' +
          '  Durable Object method — the binding is reached through `env`, so the\n' +
          '  only place this cannot go is module scope, where `env` does not\n' +
          '  exist.'
      )
    );
    say();
    say(
      indent(
        topology === 'direct'
          ? `import { ${ident} } from './limiter.js';\n\nconst limiter = ${ident}.for(env);\nconst file = await limiter.call(() => fetch(url, { headers }), {\n  read: (res) => res.json<{ id: string }>(),\n});\n`
          : `import { ${ident} } from './limiter.js';\n\nconst limiter = ${ident}(env);\nconst file = await limiter.call(() => fetch(url, { headers }), {\n  read: (res) => res.json<{ id: string }>(),\n});\n`
      )
    );
    say(
      dim(
        'That call may await for minutes. That is the design — a request awaiting\n' +
          '  I/O burns no CPU, and object duration is shared across every caller.\n'
      )
    );

    return 0;
  } finally {
    prompter.close();
  }
}

// --- helpers ---------------------------------------------------------------

function rel(from: string, to: string): string {
  const relative = path.relative(from, to);
  return relative === '' ? '.' : relative;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `  ${dim(line)}`))
    .join('\n');
}

const CONSUMER_CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

function detectConsumerConfig(cwd: string): string | undefined {
  return CONSUMER_CONFIGS.find((name) => existsSync(path.join(cwd, name)));
}

/** Writes a generated file, asking first when something is already there. */
async function writeIfAllowed(
  prompter: Prompter,
  cwd: string,
  target: string,
  contents: string
): Promise<boolean> {
  const shown = rel(cwd, target);

  if (existsSync(target)) {
    const overwrite = await prompter.confirm(
      `${shown} already exists — overwrite it?`,
      false
    );
    if (!overwrite) {
      say(dim(`  kept ${shown}`));
      return false;
    }
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  say(`  ${green('wrote')} ${shown}`);
  return true;
}

/** Whether there is anything to lose here, said plainly. */
function gitStatus(cwd: string): 'clean' | 'dirty' | 'none' {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) return 'none';
  return result.stdout.trim() === '' ? 'clean' : 'dirty';
}

/**
 * Runs a command, capturing its stdout while still showing it.
 *
 * The capture is what makes the deploy URL knowable: the account's workers.dev
 * subdomain appears in wrangler's output and nowhere this CLI could otherwise
 * reach. The cost is that the output arrives in one go at the end.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
  input?: string
): { status: number; stdout: string } {
  say(dim(`  $ ${command} ${args.join(' ')}`));

  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    // stdin is piped only when there is something to send; otherwise the child
    // inherits it and can prompt (wrangler's login flow does).
    stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'],
    ...(input === undefined ? {} : { input }),
  });

  // A command that never started has no streams at all, whatever the types say.
  if (result.error) {
    say(red(`  ${result.error.message}`));
    return { status: 1, stdout: '' };
  }

  const { stdout } = result;
  if (stdout !== '') say(indent(stdout.trimEnd()));
  return { status: result.status ?? 1, stdout };
}

/** A key nobody has to invent. 24 random bytes, URL-safe. */
function generateKey(): string {
  return randomBytes(24).toString('base64url');
}

/** Applies the declared limits through the Worker's own guarded route. */
async function applyLimits(
  url: string,
  key: string,
  limits: unknown
): Promise<boolean> {
  say();
  say(dim('  applying the limits…'));

  try {
    const response = await fetch(endpoint(url, 'configure', key), {
      method: 'POST',
      body: JSON.stringify(limits),
    });
    if (!response.ok) {
      say(red(`  /configure returned ${String(response.status)}`));
      return false;
    }

    const stats = (await response.json()) as Record<string, unknown>;
    for (const [name, value] of Object.entries(stats)) {
      say(
        `  ${green('configured')} ${bold(name)} ${dim(JSON.stringify(value))}`
      );
    }
    return true;
  } catch (error: unknown) {
    // A freshly deployed Worker can take a moment to answer, and a route that
    // is not reachable at all is a setup problem, not a reason to fail init.
    say(red(`  could not reach ${url} — ${String(error)}`));
    return false;
  }
}
