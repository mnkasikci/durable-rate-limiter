import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STATE_FILE,
  findStates,
  stripJsonComments,
  writeState,
  type ProjectState,
} from './state.js';

const STATE: ProjectState = {
  workerName: 'durable-rate-limiter',
  limiterConfig: 'wrangler.jsonc',
  limitsFile: 'durable-rate-limiter.limits.jsonc',
};

/**
 * A throwaway project root.
 *
 * `.git` matters: without it the upward walk climbs out of the fixture into the
 * temp directory and finds the *other* fixtures — which is exactly the
 * behaviour these tests are pinning, just pointed at the wrong tree.
 */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drl-state-'));
  await mkdir(path.join(dir, '.git'));
  return dir;
}

describe('stripJsonComments', () => {
  it('removes line and block comments', () => {
    expect(stripJsonComments('// gone\n{"a": 1} /* also gone */')).toContain(
      '{"a": 1}'
    );
    expect(stripJsonComments('// gone\n{"a": 1}')).not.toContain('gone');
  });

  it('leaves comment-like text inside strings alone', () => {
    const source = '{"url": "https://a.b/c", "note": "/* not a comment */"}';
    expect(JSON.parse(stripJsonComments(source))).toEqual({
      url: 'https://a.b/c',
      note: '/* not a comment */',
    });
  });

  it('is not fooled by an escaped quote before a comment', () => {
    const source = '{"q": "he said \\"hi\\"" /* c */}';
    expect(JSON.parse(stripJsonComments(source))).toEqual({
      q: 'he said "hi"',
    });
  });
});

describe('the state file', () => {
  it('round-trips through its own comment header', async () => {
    const dir = await scratch();
    await writeState(dir, STATE);

    const found = await findStates(dir);
    expect(found).toHaveLength(1);
    expect(found[0]?.state).toEqual(STATE);
    // The header is the thing that tells a reader not to delete it.
    expect(found[0]?.dir).toBe(dir);
  });

  it('finds a limiter one directory down, where init puts it', async () => {
    const root = await scratch();
    const limiter = path.join(root, 'durable-rate-limiter');
    await mkdir(limiter);
    await writeState(limiter, STATE);

    const found = await findStates(root);
    expect(found).toHaveLength(1);
    expect(found[0]?.dir).toBe(limiter);
  });

  it('reports every limiter when a repository has several', async () => {
    const root = await scratch();
    for (const name of ['b-limiter', 'a-limiter']) {
      await mkdir(path.join(root, name));
      await writeState(path.join(root, name), { ...STATE, workerName: name });
    }

    const found = await findStates(root);
    expect(found.map((entry) => entry.state.workerName)).toEqual([
      'a-limiter',
      'b-limiter',
    ]);
  });

  it('finds it from a subdirectory, where people actually stand', async () => {
    const root = await scratch();
    const limiter = path.join(root, 'durable-rate-limiter');
    await mkdir(limiter);
    await writeState(limiter, STATE);
    const deep = path.join(root, 'src', 'routes');
    await mkdir(deep, { recursive: true });

    const found = await findStates(deep);
    expect(found[0]?.dir).toBe(limiter);
  });

  it('never climbs out of a repository', async () => {
    const outer = await scratch();
    await writeState(outer, STATE);
    const inner = path.join(outer, 'other-project');
    await mkdir(path.join(inner, '.git'), { recursive: true });

    // The limiter in the parent belongs to a different project.
    expect(await findStates(inner)).toEqual([]);
  });

  it('ignores a file it cannot parse rather than crashing', async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, STATE_FILE), '{ this is not json');
    expect(await findStates(dir)).toEqual([]);
  });
});
