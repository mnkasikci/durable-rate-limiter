/**
 * The terminal layer: questions, answers, colour. No decisions live here.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

const plain = Boolean(process.env.NO_COLOR) || !stdout.isTTY;

const wrap = (code: string) => (text: string) =>
  plain ? text : `[${code}m${text}[0m`;

export const bold = wrap('1');
export const dim = wrap('2');
export const cyan = wrap('36');
export const green = wrap('32');
export const yellow = wrap('33');
export const red = wrap('31');

export function say(line = ''): void {
  stdout.write(`${line}\n`);
}

export function heading(text: string): void {
  say();
  say(bold(cyan(text)));
}

/**
 * What to do about a key you no longer have.
 *
 * Said wherever the key is asked for or rejected, because the answer is not
 * obvious: a Cloudflare secret cannot be read back, so "lost" and "wrong" have
 * the same remedy — set a new one, which replaces the old.
 */
export function sayKeyRecovery(workerName: string, configPath: string): void {
  say(
    dim('  Lost the key? A secret cannot be read back — set a new one, which')
  );
  say(dim('  replaces it, and use that from then on:'));
  say(
    `    ${cyan(`npx wrangler secret put DRL_CONFIG_KEY --config ${configPath}`)}`
  );
  say(
    dim(
      `  or in the dashboard: Workers & Pages → ${workerName} → Settings →\n` +
        '  Variables and Secrets → DRL_CONFIG_KEY.'
    )
  );
}

export interface AskOptions {
  default?: string;
  /** Returns an error message, or null when the answer is acceptable. */
  validate?: (answer: string) => string | null;
  hint?: string;
}

/**
 * Prompts, with an `--yes` mode that takes every default without asking.
 *
 * In `--yes` mode a question with no default is a programming error rather than
 * a prompt: the flag promises not to block, so a missing default has to fail
 * loudly instead of silently hanging on a pipe.
 */
export class Prompter {
  private rl: Interface | null = null;

  constructor(private readonly assumeYes: boolean) {}

  private get input(): Interface {
    if (this.rl === null) {
      const rl = createInterface({ input: stdin, output: stdout });
      // Without this, Ctrl-C during a pending question closes the interface and
      // leaves the promise unsettled — the process hangs instead of exiting.
      rl.on('SIGINT', () => {
        rl.close();
        say();
        say(dim('cancelled — nothing further was written'));
        process.exit(130);
      });
      this.rl = rl;
    }
    return this.rl;
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }

  async ask(question: string, options: AskOptions = {}): Promise<string> {
    const fallback = options.default;

    if (this.assumeYes) {
      if (fallback === undefined) {
        throw new Error(
          `--yes cannot answer "${question}" — no default exists.`
        );
      }
      say(`${question} ${dim(`→ ${fallback}`)}`);
      return fallback;
    }

    if (options.hint) say(dim(`  ${options.hint}`));

    for (;;) {
      const suffix = fallback === undefined ? '' : dim(` (${fallback})`);
      const answer = (
        await this.input.question(`${question}${suffix} `)
      ).trim();
      const value = answer === '' ? (fallback ?? '') : answer;

      if (value === '') {
        say(red('  a value is required'));
        continue;
      }

      const error = options.validate?.(value);
      if (error === null || error === undefined) return value;
      say(red(`  ${error}`));
    }
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    if (this.assumeYes) {
      say(`${question} ${dim(`→ ${fallback ? 'yes' : 'no'}`)}`);
      return fallback;
    }

    for (;;) {
      const suffix = dim(fallback ? ' (Y/n)' : ' (y/N)');
      const answer = (await this.input.question(`${question}${suffix} `))
        .trim()
        .toLowerCase();
      if (answer === '') return fallback;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      say(red('  answer y or n'));
    }
  }

  /** Numbered single choice; the first option is the default. */
  async choose<T extends string>(
    question: string,
    options: { value: T; label: string; detail?: string }[]
  ): Promise<T> {
    const first = options[0];
    if (first === undefined)
      throw new Error('choose() needs at least one option');

    if (this.assumeYes) {
      say(`${question} ${dim(`→ ${first.label}`)}`);
      return first.value;
    }

    say(question);
    options.forEach((option, index) => {
      say(`  ${bold(String(index + 1))}. ${option.label}`);
      if (option.detail) say(dim(`     ${option.detail}`));
    });

    for (;;) {
      const count = String(options.length);
      const answer = (
        await this.input.question(dim(`  (1-${count}, default 1) `))
      ).trim();
      if (answer === '') return first.value;
      const chosen = options[Number(answer) - 1];
      if (chosen) return chosen.value;
      say(red(`  pick a number between 1 and ${count}`));
    }
  }
}
