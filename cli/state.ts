/**
 * What `init` leaves behind so `configure` and `stats` know where to point.
 *
 * It lives *inside* the scaffolded limiter Worker's directory, not at the root
 * of the consuming repository: this package's setup should cost a consumer one
 * folder, not one folder plus a dotfile in the project root.
 *
 * Every path in it is relative to that directory, so the whole thing can be
 * moved or renamed without becoming a lie, and the commands run wrangler from
 * there regardless of where they were invoked.
 *
 * It holds paths and a URL — never the key. The key is a Cloudflare secret; a
 * copy in a file in the repo would be the weakest link in the arrangement.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const STATE_FILE = '.durable-rate-limiter.jsonc';

export interface ProjectState {
  /** The deployed limiter Worker's name. */
  workerName: string;
  /** Its wrangler config, relative to the directory holding this file. */
  limiterConfig: string;
  /** Where the declared limits live, relative to that same directory. */
  limitsFile: string;
  /** Its deployed origin, when `init` managed to learn it. */
  url?: string;
}

/** A found state file: the state itself, and the directory it governs. */
export interface LocatedState {
  dir: string;
  state: ProjectState;
}

const HEADER = `// Written by \`durable-rate-limiter init\`. Commit this — it holds no secrets.
//
// Do not delete it if you want these to keep working:
//
//   npx @bakidev/durable-rate-limiter configure   apply the limits in limits.ts
//   npx @bakidev/durable-rate-limiter stats       read every bucket back
//
// Every path below is relative to this file's directory.
`;

export function statePath(dir: string): string {
  return path.join(dir, STATE_FILE);
}

export async function writeState(
  dir: string,
  state: ProjectState
): Promise<void> {
  await writeFile(
    statePath(dir),
    `${HEADER}${JSON.stringify(state, null, 2)}\n`
  );
}

async function readStateAt(dir: string): Promise<ProjectState | null> {
  const file = statePath(dir);
  if (!existsSync(file)) return null;

  try {
    return JSON.parse(
      stripJsonComments(await readFile(file, 'utf8'))
    ) as ProjectState;
  } catch {
    return null;
  }
}

/** A directory and its immediate children — where `init` could have scaffolded. */
async function scan(from: string): Promise<LocatedState[]> {
  const found: LocatedState[] = [];

  const here = await readStateAt(from);
  if (here !== null) found.push({ dir: from, state: here });

  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

    const dir = path.join(from, entry.name);
    const state = await readStateAt(dir);
    if (state !== null) found.push({ dir, state });
  }

  return found;
}

/** How far up to look before concluding there is nothing here. */
const MAX_ANCESTORS = 8;

/**
 * Finds every limiter reachable from `cwd`: this directory and its immediate
 * children, then the same one level up, and so on until something turns up.
 *
 * Both directions are deliberate. Down one level is where `init` scaffolds; up
 * is because nobody stands at the repository root when they want to retune a
 * limit. The walk stops at the first directory that yields anything, and never
 * climbs past a repository root — so a limiter in a *sibling* project can never
 * be picked up by mistake.
 */
export async function findStates(cwd: string): Promise<LocatedState[]> {
  let dir = path.resolve(cwd);

  for (let step = 0; step < MAX_ANCESTORS; step += 1) {
    const found = await scan(dir);
    if (found.length > 0) return found;

    if (existsSync(path.join(dir, '.git'))) return [];

    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }

  return [];
}

/**
 * The workers.dev origin wrangler prints on a successful deploy.
 *
 * Read from its output rather than asked for, because the subdomain is an
 * account property this CLI has no other way to know. When the account has no
 * workers.dev subdomain or the deploy is routed elsewhere, there is simply no
 * match and the caller asks.
 */
export function extractDeployedUrl(output: string): string | undefined {
  return /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(output)?.[0];
}

/** The endpoint a command hits, with the key carried as a query parameter. */
export function endpoint(
  url: string,
  route: 'configure' | 'stats',
  key: string
): string {
  const base = new URL(url);
  base.pathname = `/${route}`;
  base.searchParams.set('key', key);
  return base.toString();
}

/**
 * Comments out of JSONC, so the file can explain itself and still parse.
 *
 * String-aware, because a `//` inside a URL is not a comment and neither is one
 * inside an escaped quote — the two cases that make the naive regex version
 * silently corrupt a config.
 */
export function stripJsonComments(source: string): string {
  let output = '';
  let index = 0;
  let inString = false;

  while (index < source.length) {
    // Indexing past the end is impossible inside the loop condition, but the
    // types do not know that and the `?? ''` costs nothing.
    const char = source[index] ?? '';
    const next = source[index + 1];

    if (inString) {
      output += char;
      if (char === '\\') {
        output += next ?? '';
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}
