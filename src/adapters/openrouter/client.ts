import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

/**
 * gpt-oss is a hybrid reasoning model: before its final answer it emits an
 * internal "analysis" (chain-of-thought) channel. OpenRouter's `:free` route is
 * served by provider/vLLM backends that frequently inline that analysis straight
 * into `message.content` instead of a separate `reasoning` field — so the
 * model's "Oops/Sorry/…" self-correction leaks into the reply the user sees.
 *
 * `reasoning: { exclude: true }` is OpenRouter's documented switch that tells it
 * not to return reasoning tokens at all. The `@ai-sdk/openai` provider has no
 * native flag for this OpenRouter-specific body field, so we inject it via the
 * provider's sanctioned `fetch` middleware (createOpenAI({ fetch })) on every
 * chat/completion POST. One wrapped model fixes every generateText call site
 * (run-agent + both proactive composers + cron), with no new dependency and no
 * AI SDK upgrade.
 *
 * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
const CHAT_PATHS = ['/chat/completions', '/completions'];

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url; // Request
}

/**
 * Wrap a fetch implementation so any JSON body POSTed to a chat/completion
 * endpoint carries `reasoning.exclude = true`. Non-chat URLs and non-JSON
 * bodies pass through untouched.
 */
export function reasoningExcludingFetch(
  base: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const body = init?.body;
    if (typeof body === 'string' && CHAT_PATHS.some((p) => urlOf(input).includes(p))) {
      try {
        const json = JSON.parse(body) as Record<string, unknown>;
        // Merge so an existing `reasoning` object (e.g. effort) is preserved.
        json.reasoning = { exclude: true, ...(json.reasoning as object | undefined) };
        init = { ...init, body: JSON.stringify(json) };
      } catch {
        // Body isn't JSON (e.g. multipart) — forward untouched.
      }
    }
    return base(input, init);
  };
}

/** Build the OpenRouter-backed LanguageModel with reasoning suppressed. */
export function createOpenRouterModel(opts: {
  apiKey: string;
  model: string;
}): LanguageModel {
  const openrouter = createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: opts.apiKey,
    fetch: reasoningExcludingFetch(),
  });
  return openrouter(opts.model);
}
