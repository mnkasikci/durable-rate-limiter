/**
 * `configure` and `stats` — the two commands that talk to a deployed limiter.
 *
 * Both go through the key-guarded route on the limiter Worker, because
 * `configure` and `stats` are methods on a Durable Object and nothing outside
 * a Worker can reach one. There is no `wrangler` command for this.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  Prompter,
  bold,
  cyan,
  dim,
  green,
  red,
  say,
  sayKeyRecovery,
  yellow,
} from './prompt.js';
import {
  STATE_FILE,
  endpoint,
  findStates,
  writeState,
  type LocatedState,
  type ProjectState,
} from './state.js';

export interface RemoteOptions {
  cwd: string;
  assumeYes: boolean;
}

/** Every bucket's live state, as the route returns it. */
type StatsResponse = Record<string, Record<string, unknown>>;

export async function remote(
  command: 'configure' | 'stats',
  options: RemoteOptions
): Promise<number> {
  const { cwd } = options;
  const prompter = new Prompter(options.assumeYes);

  try {
    const located = await locate(prompter, cwd);
    if (located === null) return 1;

    const { dir, state } = located;
    // Everything in the state file is relative to the limiter's own folder, so
    // wrangler runs from there and the commands work from anywhere.
    const limitsFile = rel(cwd, path.join(dir, state.limitsFile));
    const limiterConfig = rel(cwd, path.join(dir, state.limiterConfig));

    say();
    say(bold(`durable-rate-limiter ${command}`));
    say(dim(`  ${rel(cwd, dir)} — ${state.workerName}`));

    if (command === 'configure') {
      say(
        dim(
          `The limits come from ${limitsFile}, which is bundled into the\n` +
            '  limiter Worker — so they take effect only once that Worker is\n' +
            '  deployed with your edits in it.'
        )
      );
      say();
      say(
        yellow(
          '  ! configure rebuilds each bucket and rejects anyone currently queued.'
        )
      );
      say(
        dim(
          '    That is deliberate: their wait can never be satisfied under limits\n' +
            '    that no longer exist. Prefer a quiet moment.'
        )
      );

      const deployCommand = [
        'wrangler',
        'deploy',
        '--config',
        state.limiterConfig,
      ];
      if (
        await prompter.confirm(
          `Deploy ${state.workerName} first (${cyan(`npx wrangler deploy --config ${limiterConfig}`)})?`,
          // Yes when a human is here to say so — the limits are bundled into
          // the Worker, so skipping this applies whatever was deployed last.
          // No under `--yes`, which must never deploy on its own.
          !options.assumeYes
        )
      ) {
        const deployed = run('npx', deployCommand, dir);
        if (deployed.status !== 0) {
          say(red('  deploy failed — not applying limits'));
          return 1;
        }
      }
    }

    const url = await resolveUrl(prompter, dir, state);
    const key = await resolveKey(prompter, state.workerName, limiterConfig);

    const response = await fetch(endpoint(url, command, key));

    if (response.status === 401) {
      say(red('  unauthorized — wrong key, or DRL_CONFIG_KEY is not set'));
      say();
      sayKeyRecovery(state.workerName, limiterConfig);
      return 1;
    }

    if (!response.ok) {
      say(red(`  ${String(response.status)} from the limiter Worker`));
      say(dim(`    ${(await response.text()).slice(0, 400)}`));
      return 1;
    }

    const body = (await response.json()) as StatsResponse;
    say();
    if (command === 'configure') {
      say(`  ${green('✓')} applied the limits in ${limitsFile}`);
      say();
    }
    printStats(body);

    return 0;
  } finally {
    prompter.close();
  }
}

/**
 * Finds the limiter these commands act on: here, or one directory down, which
 * is where `init` scaffolds it.
 *
 * More than one is a legitimate arrangement — a repository can host several
 * limiter Workers — so it asks rather than picking.
 */
async function locate(
  prompter: Prompter,
  cwd: string
): Promise<LocatedState | null> {
  const found = await findStates(cwd);

  if (found.length === 0) {
    say(red(`No limiter set up under ${cwd}`));
    say(dim(`  looked for ${STATE_FILE} here, below, and in each parent.`));
    say(
      dim(
        '  Run `npx @bakidev/durable-rate-limiter init` from your application\n' +
          '  root, or cd to the project where you already ran it.'
      )
    );
    return null;
  }

  const first = found[0];
  if (found.length === 1 || first === undefined) {
    return first ?? null;
  }

  const chosen = await prompter.choose(
    'Which limiter?',
    found.map((entry) => ({
      value: entry.dir,
      label: `${entry.state.workerName} ${dim(`(${rel(cwd, entry.dir)})`)}`,
    }))
  );
  return found.find((entry) => entry.dir === chosen) ?? first;
}

function rel(from: string, to: string): string {
  const relative = path.relative(from, to);
  return relative === '' ? '.' : relative;
}

/** The origin, remembered from the deploy or asked for once and then kept. */
async function resolveUrl(
  prompter: Prompter,
  dir: string,
  state: ProjectState
): Promise<string> {
  if (state.url !== undefined) return state.url;

  const url = await prompter.ask("The limiter Worker's URL?", {
    hint: `Its workers.dev origin, or whatever route serves ${state.workerName}.`,
    validate: (value) => (URL.canParse(value) ? null : 'not a URL'),
  });

  await writeState(dir, { ...state, url });
  return url;
}

/**
 * The key, from the environment when this runs unattended, and asked for
 * otherwise. It is never written down by this CLI.
 */
async function resolveKey(
  prompter: Prompter,
  workerName: string,
  limiterConfig: string
): Promise<string> {
  const fromEnv = process.env.DRL_CONFIG_KEY;
  if (fromEnv !== undefined && fromEnv !== '') {
    say(dim('  using DRL_CONFIG_KEY from the environment'));
    return fromEnv;
  }

  say();
  sayKeyRecovery(workerName, limiterConfig);
  return prompter.ask('DRL_CONFIG_KEY?', {
    hint: 'The same name as the secret on the Worker. Export it to skip this prompt.',
  });
}

function printStats(body: StatsResponse): void {
  for (const [name, stats] of Object.entries(body)) {
    say(`  ${bold(name)}`);
    for (const [field, value] of Object.entries(stats)) {
      say(`    ${dim(field.padEnd(18))} ${format(value)}`);
    }
    say();
  }
}

function format(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value);
}

function run(command: string, args: string[], cwd: string): { status: number } {
  say(dim(`  $ ${command} ${args.join(' ')}`));
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  return { status: result.status ?? 1 };
}
