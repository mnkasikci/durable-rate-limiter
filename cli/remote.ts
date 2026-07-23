/**
 * `configure`, `stats` and `sample` — everything that happens after `init`.
 *
 * The first two go through the key-guarded route on the limiter Worker,
 * because `configure` and `stats` are methods on a Durable Object and nothing
 * outside a Worker can reach one. There is no `wrangler` command for this.
 *
 * None of them deploys anything. The limits are durable state inside the
 * object, and the limits file is an input to `configure` rather than something
 * bundled into the Worker — so changing a limit is a `configure` and nothing
 * else. The Worker is redeployed when the Worker's own code changes.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  LIMITS_FILE,
  type LimitsEntry,
  limitsFileSource,
  limitsPayload,
  parseLimits,
  sampleLimitsFileSource,
} from './plan.js';
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
  /** `stats --save`: write what came back over the limits file. */
  save?: boolean;
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
    const limitsPath = path.join(dir, state.limitsFile);
    const shownLimits = rel(cwd, limitsPath);
    const limiterConfig = rel(cwd, path.join(dir, state.limiterConfig));

    say();
    say(bold(`durable-rate-limiter ${command}`));
    say(dim(`  ${rel(cwd, dir)} — ${state.workerName}`));

    let sending: Record<string, unknown> | undefined;

    if (command === 'configure') {
      const entries = await loadLimits(
        prompter,
        options.assumeYes,
        limitsPath,
        shownLimits
      );
      if (entries === null) return 1;

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
      say();
      say(dim(`  From ${shownLimits}:`));
      for (const entry of entries) {
        say(
          `    ${bold(entry.name.padEnd(20))} ${String(
            entry.bucket.limitPerWindow
          )} per ${String(entry.bucket.windowInMs)} ms ${dim(
            `(limitPerWindow ${String(
              entry.bucket.limitPerWindow
            )}), concurrency ${String(entry.concurrency)}`
          )}`
        );
      }
      say();
      say(
        dim(
          '  No deploy is needed for this. Redeploy the limiter Worker only when\n' +
            '  its own code changes — a package upgrade, an edit to its index.ts.'
        )
      );
      if (!(await prompter.confirm('Apply these?', true))) {
        say(dim('  nothing was applied'));
        return 0;
      }

      sending = limitsPayload(entries);
    }

    const url = await resolveUrl(prompter, dir, state);
    const key = await resolveKey(prompter, state.workerName, limiterConfig);

    const response = await fetch(
      endpoint(url, command, key),
      sending === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(sending) }
    );

    if (response.status === 401) {
      say(red('  unauthorized — wrong key, or DRL_CONFIG_KEY is not set'));
      say();
      sayKeyRecovery(state.workerName, limiterConfig);
      return 1;
    }

    if (response.status === 405) {
      sayStale(state.workerName, limiterConfig);
      return 1;
    }

    if (!response.ok) {
      say(red(`  ${String(response.status)} from the limiter Worker`));
      say(dim(`    ${(await response.text()).slice(0, 400)}`));
      return 1;
    }

    const body = (await response.json()) as StatsResponse;

    if (sending !== undefined && !applied(sending, body)) {
      sayStale(state.workerName, limiterConfig);
      return 1;
    }

    say();
    if (command === 'configure') {
      say(`  ${green('✓')} applied the limits in ${shownLimits}`);
      say();
    }
    printStats(body);

    if (options.save === true) {
      await saveLimits(prompter, limitsPath, shownLimits, body);
    }

    return 0;
  } finally {
    prompter.close();
  }
}

/**
 * `sample` — an example limits file, written without touching the network.
 *
 * It exists so that nobody has to invent JSON from the README, and it marks
 * itself as an example so that `configure` can refuse to apply it by accident.
 */
export async function sample(options: RemoteOptions): Promise<number> {
  const { cwd } = options;
  const prompter = new Prompter(options.assumeYes);

  try {
    const found = await findStates(cwd);
    const dir = found[0]?.dir ?? cwd;
    const target = path.join(dir, found[0]?.state.limitsFile ?? LIMITS_FILE);

    say();
    say(bold('durable-rate-limiter sample'));
    say(
      dim(
        'An example, so the shape is visible before it is real. It applies\n' +
          '  nothing and reaches nothing — the numbers in it are invented.'
      )
    );

    if (!(await confirmOverwrite(prompter, target, rel(cwd, target)))) return 0;
    await writeFile(target, sampleLimitsFileSource());

    say();
    say(`  ${green('wrote')} ${rel(cwd, target)}`);
    say();
    say(dim('  Make it true, then apply it:'));
    say(
      `    ${cyan('npx @bakidev/durable-rate-limiter stats --save')}   ${dim('(overwrite it with the live limits)')}`
    );
    say(
      `    ${cyan('npx @bakidev/durable-rate-limiter configure')}      ${dim('(upload what is in it)')}`
    );
    return 0;
  } finally {
    prompter.close();
  }
}

// --- the limits file --------------------------------------------------------

/** Reads and validates the limits file, saying exactly what is wrong with it. */
async function loadLimits(
  prompter: Prompter,
  assumeYes: boolean,
  limitsPath: string,
  shown: string
): Promise<LimitsEntry[] | null> {
  if (!existsSync(limitsPath)) {
    say(red(`  no limits file at ${shown}`));
    say(
      dim(
        '  Write one with `npx @bakidev/durable-rate-limiter sample`, or read\n' +
          '  the live ones back with `... stats --save`.'
      )
    );
    return null;
  }

  const parsed = parseLimits(await readFile(limitsPath, 'utf8'));
  if (!parsed.ok) {
    say(red(`  ${shown} cannot be read:`));
    for (const problem of parsed.problems) say(red(`    • ${problem}`));
    return null;
  }

  if (parsed.file.source === 'sample') {
    say();
    say(
      yellow(
        `  ! ${shown} is still the example written by \`sample\`. Its numbers are invented.`
      )
    );
    say(
      dim(
        '    Applying them would pace a real limiter at a made-up rate. Delete\n' +
          '    the "source" line once they are yours, and this stops asking.'
      )
    );
    // `--yes` takes defaults; it must not take an invented rate limit. There is
    // nobody there to notice, and the failure is a real limiter paced wrong.
    if (assumeYes) {
      say(red('  refusing to apply an example unattended'));
      return null;
    }
    if (!(await prompter.confirm('Apply the example anyway?', false))) {
      return null;
    }
  }

  return parsed.file.entries;
}

/** Writes the live limits back over the file, so it says what is actually true. */
async function saveLimits(
  prompter: Prompter,
  limitsPath: string,
  shown: string,
  body: StatsResponse
): Promise<void> {
  const entries: LimitsEntry[] = [];

  for (const [name, stats] of Object.entries(body)) {
    const config = stats.config;
    if (typeof config !== 'object' || config === null) continue;
    const { bucket, concurrency, retry } = config as LimitsEntry & {
      retry?: { maxRetries: number; maxDelayInMs: number };
    };
    entries.push({
      name,
      bucket,
      concurrency,
      ...(retry === undefined ? {} : { retry }),
    });
  }

  say();
  if (!(await confirmOverwrite(prompter, limitsPath, shown))) return;

  await writeFile(limitsPath, limitsFileSource(entries));
  say(
    `  ${green('wrote')} ${shown} — ${String(entries.length)} bucket(s), as deployed`
  );
}

/** Asks before replacing a file, which may carry comments nobody can recover. */
async function confirmOverwrite(
  prompter: Prompter,
  target: string,
  shown: string
): Promise<boolean> {
  if (!existsSync(target)) return true;

  const overwrite = await prompter.confirm(
    `${shown} already exists — overwrite it? Any comments in it are lost.`,
    false
  );
  if (!overwrite) say(dim(`  kept ${shown}`));
  return overwrite;
}

// --- staleness --------------------------------------------------------------

/**
 * Whether the Worker applied what it was sent.
 *
 * A limiter Worker deployed before the limits moved out of its bundle answers
 * `/configure` by applying its own baked-in copy and returning a perfectly
 * healthy 200. The response carries the config now in force for each bucket, so
 * comparing it against what was sent is what turns that into a visible failure
 * rather than a limit that silently did not change.
 */
function applied(sent: Record<string, unknown>, body: StatsResponse): boolean {
  return Object.entries(sent).every(([name, config]) => {
    const inForce = body[name]?.config;
    return (
      inForce !== undefined &&
      JSON.stringify(inForce) === JSON.stringify(config)
    );
  });
}

function sayStale(workerName: string, limiterConfig: string): void {
  say();
  say(
    red(`  ${workerName} is running an older build and ignored these limits.`)
  );
  say(
    dim(
      '  It still has its limits compiled in. Redeploy it once — after that,\n' +
        '  changing a limit never needs a deploy again:'
    )
  );
  say();
  say(`    ${cyan(`npx wrangler deploy --config ${limiterConfig}`)}`);
}

// --- locating ---------------------------------------------------------------

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
