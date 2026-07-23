# A deployable demo: one bucket, two apps, one mock upstream, one dashboard

> **Status: alpha.** The core claim holds — deploy it and you can watch the
> limiter properly limiting — but the demo around it needs work. The dashboard
> does not yet show all the results properly: it hangs off a 1.5-second poll,
> which causes issues, and a better, faster pipeline is needed. app-alpha and
> app-bravo also need to track their requests better. Treat the numbers on the
> page as a demonstration, not an instrument.

This is the package used the way it is meant to be used — by more than one
application at once. Two independently-deployed Workers, owned by two notional
teams, call the same third-party API through a single shared limiter, and a
local dashboard shows them sharing one allowance in real time.

The whole coordination between the two apps is **one string**. app-alpha and
app-bravo share no code but [`shared/protocol.ts`](shared/protocol.ts), and the
only thing in it that makes them cooperate is `BUCKET_NAME`. Each app imports
it, names its limiter with it, and thereby paces against the same bucket. A typo
would not error — it would silently open a _second_ bucket pacing at the full
rate against the same quota — which is exactly why the name is written once and
imported, never retyped. That is the demonstration.

## The five components

| Component    | Role                                                                                                      | Deployed?           |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------------------- |
| `limiter/`   | the shared limiter Worker (`LimiterDO` + `LimiterEntrypoint`); re-exports the package, no logic           | **yes**             |
| `upstream/`  | a **pure mock third-party API** — a rolling window + counters in one Durable Object                       | **yes**             |
| `app-alpha/` | one app; bursts through the limiter, tracks each request's state in its own `StatusDO`                    | **yes**             |
| `app-bravo/` | the same app, different identity; shares nothing with alpha but the bucket name                           | **yes**             |
| `dashboard/` | a stateless UI Worker: serves the page, proxies polls and commands. Runs **locally** under `wrangler dev` | no — run with `dev` |

Workers 1–4 are **always deployed**. That is the design's keystone: the
dashboard binds all four as service bindings with `"remote": true`, so the same
dashboard code runs under `wrangler dev` (bindings resolve to the deployed
Workers) with no local Durable Object to emulate. Every "does this work under
`wrangler dev`" problem disappears because the stateful pieces are never local.

```
                         drl-example-limiter
                         (LimiterDO + LimiterEntrypoint;
                          re-exports the package, no logic of its own)
                              ^                 ^
             service binding  |                 |  service binding
             LIMITER          |                 |  LIMITER
                              |                 |
        drl-example-alpha ────┘                 └──── drl-example-bravo
          GET /burst?n=8                              GET /burst?n=8
          + StatusDO (per-app request states)         + StatusDO
                \                                        /
                 \   fetch /api  (UPSTREAM binding)     /
                  \                                    /
                   v                                  v
                         drl-example-upstream
                         ┌───────────────────────────────────────┐
                         │ a MOCK third party — knows no limiter    │
                         │ GET  /api         admit-or-429, held      │
                         │ GET  /rate-limit  window + counters       │
                         │ POST /configure   limit / window / work   │
                         │ POST /reset       clear window + counters │
                         │ MockApiDO         rolling window (1 inst.) │
                         └───────────────────────────────────────┘

        drl-example-dashboard  (local `wrangler dev`, remote-bound to all four)
        GET /poll → fans out to limiter /stats, upstream /rate-limit,
                    alpha /status, bravo /status — one blob, per-section errors
```

## Why it is shaped this way

- **The upstream is a mock third party.** `drl-example-upstream` enforces its own
  limit — a **rolling (sliding) window across the whole API**, not per caller —
  exactly the way the package does: it records served timestamps and prunes those
  older than the window at read time. It knows nothing about the limiter. That
  the ceiling is per-API and not per-caller is what makes the shared quota real:
  alpha and bravo spend from one pool, so one app's traffic can rate-limit the
  other. Defaults: **12 / 60s**, with a 250 ms `processingMs` hold per served
  call so the limiter's concurrency slots stay visibly occupied.

- **Every mock route is open — no key.** The mock's routes only read and mutate
  _fake_ state (a made-up rolling window and two counters); there is nothing to
  protect. The one genuinely guarded surface in the whole demo is the limiter's
  key-guarded `/configure`, a real control plane. The mock is a toy the dashboard
  pokes at.

- **The limiter is configured _under_ the upstream.** The shared bucket is set
  to **10 / 60s**, deliberately below the mock's 12. That headroom is why the
  demo starts clean: paced at 10, the two apps together never reach the mock's
  12, so no real `429`s appear until you go looking for them. Raise
  `limitPerWindow` past 12 from the dashboard and the apps overrun the mock, earn
  a real `429`, and you can watch that one `429` pause **both** apps — the shared
  penalty.

- **Four Workers, because the platform requires it.** The limiter's Durable
  Object lives in a Worker of its own (a Worker implementing a DO gets no preview
  URLs, and a new DO migration cannot be uploaded as a version). The apps merely
  _bind_ its named entrypoint, so they keep their own previews.

## The request-state model

Each app tracks the **current state** of every request it fires, in its own
`StatusDO` (a single named instance). A burst runs in one isolate's `waitUntil`
while a dashboard poll may land on another, so an in-memory counter would report
zero to the poll that mattered — the state has to live in a Durable Object.

Every state is knowable **client-side**, because the limiter runs the callback in
the _app's_ isolate: the app sees each transition first-hand.

| State       | Meaning                                                                                          | How the app detects it                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `queued`    | handed to the limiter; callback not yet fired (or waiting its turn again after a transient drop) | before `call()`; and in `onDrop` when `willRetry`                                                                     |
| `inFlight`  | callback fired; the fetch to the mock is running                                                 | first line inside the `call()` callback                                                                               |
| `requeued`  | the callback's response was a 429; the limiter will pause and re-invoke                          | in `read`, when `res.status === 429`                                                                                  |
| `completed` | `call()` resolved with a served (2xx) result                                                     | after `call()` resolves, status ≠ 429                                                                                 |
| `dropped`   | terminal failure                                                                                 | `CallDroppedError` (retries spent), any other throw, **or** a resolved 429 envelope (retries exhausted, never served) |

The `dropped` tile keeps a cheap breakdown — `{ droppedQueue, exhausted429,
failed }` — surfaced as a tooltip, but the headline is one bucket. `StatusDO`
caps stored terminal entries (~500, oldest evicted) so a long demo cannot grow
storage without bound.

## Files

| Path                                        |                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `shared/protocol.ts`                        | the one shared module: `BUCKET_NAME`, headers, the state + snapshot + rate-limit shapes |
| `limiter/src/index.ts`                      | the shared limiter Worker + key-guarded `/configure`, `/stats`                          |
| `limiter/durable-rate-limiter.limits.jsonc` | the editable limits, never deployed                                                     |
| `upstream/src/index.ts`                     | the mock API and its rolling-window `MockApiDO`                                         |
| `app-alpha/`, `app-bravo/`                  | two separate apps; identical but for the app id                                         |
| `dashboard/src/index.ts`                    | the stateless proxy Worker (`/poll` and the command routes)                             |
| `dashboard/src/dashboard.ts`                | the dashboard page (inline CSS + vanilla JS, no external resources)                     |

Every Worker imports from `../../../dist/*.js`, never from `src/` — it uses the
built artifact, exactly as a published consumer would. `npm run build` at the
repo root is step one.

## Deploy

### Fill in your values first

Every account-specific value in this demo is the literal marker
`<fillherefordeployingexampleapp>` — one string everywhere, so one search finds
every site that needs your value before anything deploys:

```sh
grep -r '<fillherefordeployingexampleapp>' example/
```

(or your editor's project-wide search). It appears in exactly three files, and
means one of two things:

| File                                        | What to put there                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `app-alpha/wrangler.jsonc` (`UPSTREAM_URL`) | your **workers.dev subdomain** — the segment between the worker name and `.workers.dev`             |
| `app-bravo/wrangler.jsonc` (`UPSTREAM_URL`) | the same subdomain                                                                                  |
| `dashboard/.dev.vars` (`DRL_CONFIG_KEY`)    | your **config key** — any secret string you invent; it must equal the secret you set on the limiter |

The subdomain is yours the moment you have a Cloudflare account; the first
deploy in step 2 prints the full URL, so if you do not know it, deploy the
upstream first, read the subdomain off the printed URL, then fill the two
`UPSTREAM_URL` sites before deploying the apps. The config key is not issued by
anyone — you make it up, set it as the limiter's secret (step 4), and repeat it
in `dashboard/.dev.vars` and the `/configure` call.

### The steps

All commands run **from the repo root**. The order matters: the apps bind the
limiter and upstream services, so those must exist first.

```sh
# 1. Build the package — the Workers import from dist/.
npm run build

# 2. Deploy the mock upstream. The printed URL contains your subdomain —
#    fill it into both apps' UPSTREAM_URL before step 5.
npx wrangler deploy --config example/upstream/wrangler.jsonc

# 3. Deploy the limiter.
npx wrangler deploy --config example/limiter/wrangler.jsonc

# 4. Set the config key on the limiter. Unset, it denies /configure and /stats.
echo "<fillherefordeployingexampleapp>" | npx wrangler secret put DRL_CONFIG_KEY --config example/limiter/wrangler.jsonc

# 5. Deploy the two apps (they bind the limiter and upstream, now up).
npx wrangler deploy --config example/app-alpha/wrangler.jsonc
npx wrangler deploy --config example/app-bravo/wrangler.jsonc
```

The apps' `UPSTREAM_URL` var already points at the deployed mock's origin; the
request travels over the `UPSTREAM` service binding (a plain cross-Worker
`fetch()` of a workers.dev URL is blocked with error 1042), and the var only
names the origin the URL is built against.

### Configure the bucket

The limits live in `limiter/durable-rate-limiter.limits.jsonc`, are never
deployed, and are applied over the key-guarded `/configure` route. POST the value
under `"limits"` (without the comments):

```sh
curl -X POST \
  "https://drl-example-limiter.<fillherefordeployingexampleapp>.workers.dev/configure?key=$DRL_CONFIG_KEY" \
  -H 'content-type: application/json' \
  -d '{"demo-upstream-api":{"bucket":{"limitPerWindow":10,"windowInMs":60000},"concurrency":3,"retry":{"maxRetries":3,"maxDelayInMs":30000}}}'
```

It answers with each bucket's live stats. A `401` means the key is wrong or
`DRL_CONFIG_KEY` is unset on the limiter; a `405` means the limiter is running an
older build with baked-in limits — redeploy it once.

## Run the dashboard locally

The dashboard is **not deployed**. It is designed to run under `wrangler dev`,
where its four service bindings (`"remote": true`) connect to the deployed
Workers. Give it the limiter's key so its `/stats` and `/configure` proxies are
authorized — put it in `.dev.vars` (gitignored, never deployed), replacing the
`<fillherefordeployingexampleapp>` marker with the same value you set as the
limiter's secret:

```sh
cd example/dashboard
npx wrangler dev
```

Open the printed local URL (e.g. `http://localhost:8787`). The page polls `/poll`
every 1.5s; each poll fans out to all four Workers in parallel and returns one
blob, so a single dead leg degrades one panel rather than breaking the page.

Everything the page touches is **live**: the reconfigure forms rebuild the real
bucket and the real mock, and a burst spends the real window. Edits to
`dashboard.ts` or `index.ts` reload instantly; edits to the package itself still
need `npm run build` first, since the Workers import from `dist/`.

## A demo script

1. **One app, watch the states flow.** Set alpha's burst to 8 and click _Burst_.
   Watch alpha's tiles move: `queued` → `in flight` → `completed` climbing to 8.
   Check the mock panel's `served` count rise and the limiter panel's `remaining`
   fall and refill on its rolling window.

2. **Both apps, watch them share.** Burst alpha and bravo together. The combined
   rate still holds at 10/60s — because both name the same bucket. Neither app
   knows the other exists; the bucket is the only thing they share.

3. **Provoke the upstream.** In the limiter form, raise `limitPerWindow` to `20`
   and Apply. Now the shared bucket paces _above_ the mock's real 12/60s ceiling.
   Burst both apps. Some calls earn a real `429`, the tiles show `requeued`
   (amber) as the limiter pauses and re-invokes, and the limiter panel's penalty
   badge turns red with a lifts-in countdown — **one caller's 429 pauses both
   apps**. Calls that exhaust the retry budget land in `dropped`.

4. **Reset and repeat.** Each app card has a _Reset_ button (clears that app's
   `StatusDO`); the mock panel has _Reset window & counters_. Clear them and the
   next run starts clean.

A number that surprises people: a **rested bucket legitimately spends its whole
limit at once**. The pacing is a sliding log — every take is recorded and counts
until it is `windowInMs` old — so no _rolling_ window ever exceeds the limit, but
a caller idle for a full window may fire the entire allowance in one burst. A
peak that reaches `limitPerWindow` is the contract working, not a leak.

## Known demo caveats

- **`waitUntil` lifetime.** Each `/burst` returns `202` immediately and runs the
  calls in `ctx.waitUntil`, because a burst can queue for minutes under a shared
  penalty and the trigger must not block. `waitUntil` keeps the isolate alive
  only so long, so an extreme, very long burst could be cut short before its last
  transitions are recorded. For the demo's minutes-long penalties it is the right
  shape; work that must outlast that belongs in a Workflow.

- **Drops are real, and made visible.** The limiter's wait queue is memory-only,
  so a caller parked in it can be dropped if the object is evicted or redeployed.
  The client retries that automatically (five times by default); a transient drop
  that will be retried shows as `queued` again, and only a fully-spent retry
  budget lands in `dropped`. A `dropped` count is the retry's last word, not a
  routine event.

- **Local emulation does not reproduce the platform limits.** `wrangler dev` is
  fine for poking at the routes and iterating on the dashboard; it is not where
  the pacing or the drops are measured. Every number here means something only
  against a real deployment.
