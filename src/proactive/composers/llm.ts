import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { buildProactiveSystemPrompt } from '../prompt.js';
import { todayWibDisplay } from '../../domain/time.js';
import type { ProactivePayload } from '../types.js';

/** Serialize the payload's data into a readable prompt for the model. */
function serialize(payload: ProactivePayload): string {
  return `Tulis pesan proaktif untuk data berikut (trigger: ${payload.triggerType}):\n\n${JSON.stringify(payload.data, null, 2)}`;
}

/**
 * Compose a message via a single generateText call (no tools — the detector
 * already gathered the data). `now` seeds today's-date context in the system
 * prompt (defaults to real time so unmocked callers still work). Throws on
 * failure; the resolver falls back to the template composer.
 */
export async function llmCompose(
  payload: ProactivePayload,
  model: LanguageModel,
  now: Date = new Date(),
): Promise<string> {
  const { text } = await generateText({
    model,
    system: buildProactiveSystemPrompt(todayWibDisplay(now)),
    prompt: serialize(payload),
  });
  return text;
}
