# @bakidev/durable-rate-limiter

A shared rate limiter and concurrency gate for Cloudflare Workers, backed by a
Durable Object.

One token bucket, shared by every isolate, every Workflow instance, every cron
tick and every application bound to it. `call()` takes a function rather than a
request, so the object decides _when_ the work runs while the work itself runs
in the caller's isolate — payloads never transit the object and no credentials
cross the boundary.

> **Status: scaffold.** The package is not implemented yet and nothing is
> published. The scope below is settled; the code is not written.

## Documentation

- [docs/preface.md](docs/preface.md) — what this is, and why a Durable Object is
  required rather than an in-process limiter.
- [docs/Features.md](docs/Features.md) — the settled feature scope, including
  the known limits.
- [AGENTS.md](AGENTS.md) — invariants and repo layout for contributors.

## Install

```sh
npm install @bakidev/durable-rate-limiter
```

Two subpath exports:

```ts
import { RateLimiterDurableObject } from '@bakidev/durable-rate-limiter/do';
import {
  defineBinder,
  defineLimiter,
} from '@bakidev/durable-rate-limiter/client';
```

`./do` is re-exported by the limiter Worker you deploy. `./client` is what
consuming applications import. Both are built from one shared envelope
definition so the halves cannot drift.

## Development

```sh
npm install
npm run check   # typecheck + lint + format + 100% coverage
npm run build
```

## License

MIT © Nurbaki Kasikci
