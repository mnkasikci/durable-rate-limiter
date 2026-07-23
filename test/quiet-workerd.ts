// Vitest `globalSetup`, so it runs in the Node process that hosts the pool —
// not inside workerd, where the suites themselves run.
//
// @cloudflare/vitest-pool-workers starts Miniflare with `verbose: true`, which
// turns on workerd's info-level logging, and pipes workerd's stderr straight to
// this process. Every rejection that crosses the RPC boundary — a DO method
// rejecting into a client that awaits it — is logged there as
//
//   workerd/io/worker.c++:NNNN: info: uncaught exception; source = Uncaught (in promise); ...
//
// even when the test awaited that rejection and asserted on it. The suites
// assert on rejections constantly (`configure` rejecting a bad limit,
// `execute` on an unconfigured limiter, a bucket destroyed mid-wait), so a
// green run prints ~27 stack traces that mean nothing. The pool hardcodes both
// `verbose` and its stdio handler, so there is no config knob for this.
//
// The filter drops that one line shape and nothing else: only workerd's own
// `info:` level, only the `uncaught exception` message. Anything at
// `warning:`/`error:` level, every `console.*` from a test, and all of Vitest's
// own output are untouched. `DRL_WORKERD_LOGS=1 npm test` brings them back —
// vitest.config.ts does that check, because Vitest hands a `globalSetup` an
// empty `process.env`.

const NOISE = /^workerd\/.*: info: uncaught exception;/;

export default function setup(): () => void {
  const write = process.stderr.write.bind(process.stderr);
  const restore = (): void => {
    process.stderr.write = write;
  };

  // Chunks arrive as whole blocks of lines: keep the lines that are not part of
  // a suppressed record, where a record is the `info:` line plus the indented
  // ` at ...` stack frames that follow it.
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    if (!text.includes('info: uncaught exception;')) return write(text);

    let suppressing = false;
    const kept = text.split('\n').filter((line) => {
      if (NOISE.test(line)) {
        suppressing = true;
        return false;
      }
      if (suppressing && /^\s+at /.test(line)) return false;
      suppressing = false;
      return true;
    });

    const out = kept.join('\n');
    return out.trim() === '' ? true : write(out);
  };

  return restore;
}
