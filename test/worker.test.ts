import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('limiter worker', () => {
  it('responds on the default handler', async () => {
    const res = await SELF.fetch('https://example.com/');
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('durable-rate-limiter');
  });
});
