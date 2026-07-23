/**
 * The package's CLI. One command today: `init`.
 */

import { createRequire } from 'node:module';

import { init } from './init.js';
import { remote, sample } from './remote.js';
import { Cancelled, bold, cyan, dim, red, say } from './prompt.js';

const HELP = `${bold('durable-rate-limiter')} — setup for @bakidev/durable-rate-limiter

${bold('Usage')}
  npx @bakidev/durable-rate-limiter init [options]

${bold('Commands')}
  init            Scaffold the limiter Worker, add the binding, write the
                  limiter module, and set your limit against your upstream.
  configure       Upload the limits file to the limiter. Run this after editing
                  it. Deploys nothing — the limits are not part of the build.
  stats           Read every bucket's live state back.
  sample          Write an example limits file, so the shape is visible before
                  it is real. Touches nothing else.

${bold('Options')}
  -y, --yes       Take every default without asking. Never deploys, and never
                  applies an unedited sample.
      --save      With ${cyan('stats')}: write the live limits over the limits file.
                  The way to get an accurate one for a limiter you inherited.
  -h, --help      Show this.
  -v, --version   Print the package version.

${bold('Environment')}
  DRL_CONFIG_KEY  The limiter Worker's CONFIG_KEY, so configure and stats do
                  not have to ask for it.

${dim('Run it from the root of the application that will consume the limiter.')}
`;

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith('-')));
  const command = args.find((arg) => !arg.startsWith('-'));

  if (flags.has('-h') || flags.has('--help')) {
    say(HELP);
    return 0;
  }

  if (flags.has('-v') || flags.has('--version')) {
    say(version());
    return 0;
  }

  const options = {
    cwd: process.cwd(),
    assumeYes: flags.has('-y') || flags.has('--yes'),
    save: flags.has('--save'),
  };

  if (command === undefined || command === 'init') return init(options);
  if (command === 'sample') return sample(options);
  if (command === 'configure' || command === 'stats') {
    return remote(command, options);
  }

  say(red(`Unknown command: ${command}`));
  say(dim(`Try ${cyan('npx @bakidev/durable-rate-limiter --help')}`));
  return 1;
}

function version(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version: string };
  return pkg.version;
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof Cancelled) {
      say();
      say(dim('cancelled — nothing further was written'));
      process.exitCode = 130;
      return;
    }
    say(red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
