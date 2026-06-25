import { describe, it, expect } from 'vitest';
import { reasoningExcludingFetch } from '../../../src/adapters/openrouter/client.js';

/** A recording stand-in for global fetch: captures (url, init) and returns a
 *  minimal JSON Response. */
function captureFetch(): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

describe('reasoningExcludingFetch', () => {
  it('injects reasoning.exclude=true into chat/completion POST bodies', async () => {
    const { fetch, calls } = captureFetch();
    await reasoningExcludingFetch(fetch)(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b:free', messages: [] }),
    });

    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.body as string);
    expect(sent.reasoning).toEqual({ exclude: true });
    expect(sent.model).toBe('openai/gpt-oss-120b:free'); // other fields preserved
  });

  it('merges with an existing reasoning object instead of clobbering it', async () => {
    const { fetch, calls } = captureFetch();
    await reasoningExcludingFetch(fetch)(CHAT_URL, {
      method: 'POST',
      body: JSON.stringify({ reasoning: { effort: 'high' } }),
    });

    const sent = JSON.parse(calls[0]!.body as string);
    expect(sent.reasoning).toEqual({ effort: 'high', exclude: true });
  });

  it('leaves non-chat URLs untouched', async () => {
    const { fetch, calls } = captureFetch();
    const raw = JSON.stringify({ foo: 'bar' });
    await reasoningExcludingFetch(fetch)('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      body: raw,
    });

    expect(calls[0]!.body).toBe(raw);
  });

  it('leaves non-JSON bodies untouched even on a chat URL', async () => {
    const { fetch, calls } = captureFetch();
    const raw = 'definitely-not-json';
    await reasoningExcludingFetch(fetch)(CHAT_URL, { method: 'POST', body: raw });

    expect(calls[0]!.body).toBe(raw);
  });
});
