# Publishing

The release checklist. `prepublishOnly` runs `clean → check → build`, so npm
will refuse to publish a package that fails the local gates — but it cannot run
the deployed verification, and that is the one gate that means anything about
the production claims in the README.

Nothing here is optional for a release that changes `src/`.

---

## 1. Local gates — must be green

```sh
npm ci
npm run check
```

`check` is `typecheck && lint && format:check && coverage`. Each one must pass on
its own terms:

- [ ] **Typecheck green.** `npm run typecheck` (`tsc --noEmit`). Also
      `npm run verify:typecheck`, which typechecks the harness against `dist/`
      and is the only thing that catches a broken published `.d.ts`.
- [ ] **Lint and format green.** `npm run lint`, `npm run format:check`.
- [ ] **Coverage green.** `npm run coverage` — 100% of lines, branches,
      functions and statements, thresholds enforced in `vitest.config.ts`. Below
      threshold is a failed release, not a warning. Coverage uses **istanbul**;
      native V8 coverage does not work inside workerd, so do not "fix" a
      coverage failure by switching provider.
- [ ] **Build clean.** `npm run build` produces `dist/do.*` and `dist/client.*`
      with declarations and sourcemaps.

## 2. Deployed verification — must be run against a real deployment

Local emulation does not reproduce the platform limits. Miniflare does not
appear to enforce invocation accounting, so a green local suite proves the logic
and nothing about the ceilings, the parks, or the quota behaviour the README
claims.

Full deploy and teardown commands are in
[README.md § Deployed verification](README.md#deployed-verification). In short:

```sh
npm run build && npm run verify:typecheck
npx wrangler deploy --config verify/limiter/wrangler.jsonc     # limiter FIRST
npx wrangler deploy --config verify/consumer/wrangler.jsonc
npx wrangler secret put PROBE_KEY --config verify/consumer/wrangler.jsonc
```

- [ ] `/ping` — both halves deployed and agreed on `ENVELOPE_VERSION`.
- [ ] `/closure-check`, both `&via=service` and `&via=direct` — `VERDICT: PASS`.
- [ ] `/client-path` — `VERDICT: PASS`. This is the shipped client stack end to
      end: `read()`, the hooks, the envelope.
- [ ] `/cap-probe?max=64`, both topologies — no failure located.
- [ ] `/start` load run, report read to completion — every call accounted for,
      concurrency peak equal to the configured value, longest park recorded.
- [ ] Backpressure run (`&simulate429OnCall=3&retryAfterSeconds=30`) — the
      workload stretches and no call is lost.
- [ ] Drop rate from the report noted in the release notes if it has moved
      materially from 2.4%.

The harness imports from `dist/`, so it verifies the artifact that is about to
be published rather than the sources. Build before deploying it.

**Tear down when finished** — this costs real money while it runs.

```sh
npx wrangler delete --config verify/consumer/wrangler.jsonc
npx wrangler delete --config verify/limiter/wrangler.jsonc
```

## 3. Documentation

- [ ] Any changed behaviour is reflected in `README.md` — in particular the
      sizing rule, the anti-patterns, and the known limits.
- [ ] **No compounded drop probability appears anywhere.** The base rate is a
      small sample and the events are not independent; a single number would be
      false precision presented as a guarantee.
- [ ] If the wire shape changed: `ENVELOPE_VERSION` bumped, and the change noted
      as breaking. Within a major version only additive, optional-with-a-default
      changes are allowed — the two halves deploy on independent schedules and
      skew is the live failure mode.

## 4. Package contents

- [ ] `npm pack --dry-run` — the tarball contains `dist/`, `README.md`,
      `LICENSE` and `package.json`, and nothing else. No `src/`,
      no `test/`, no `verify/`, no `.wrangler/`, no coverage output.
- [ ] Both subpath exports resolve:

  ```sh
  node -e "import('./dist/do.js').catch(e=>{console.error(e);process.exit(1)})"
  node --input-type=module -e "import * as c from './dist/client.js'; console.log(Object.keys(c))"
  ```

  `dist/do.js` imports `cloudflare:workers` and will not load under Node — that
  is expected and is why it is `external` in `tsup.config.ts`. The check that
  matters is that `dist/client.js` loads and exports what it should.

- [ ] `version` bumped in `package.json`.

## 5. Publish

```sh
npm publish   # prepublishOnly reruns clean + check + build
```

`publishConfig` sets `access: public` (the package is scoped) and
`provenance: true`, so publishing from CI with an OIDC-enabled workflow attaches
a provenance attestation. Publishing from a laptop requires either dropping
provenance for that release or accepting the failure — do not silently remove
it from `package.json`.

## 6. After

- [ ] `git tag v<version> && git push --tags`.
- [ ] GitHub release, body summarising the notable changes in this version.
- [ ] Verify the published tarball installs and typechecks in a scratch Worker
      project, using the quickstart from the README verbatim. The quickstart is
      the most-read code in the package and the least-tested.
