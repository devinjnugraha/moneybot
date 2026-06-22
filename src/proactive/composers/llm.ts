import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { PROACTIVE_SYSTEM_PROMPT } from '../prompt.js';
import type { ProactivePayload } from '../types.js';

/** Serialize the payload's data into a readable prompt for the model. */
function serialize(payload: ProactivePayload): string {
  return `Tulis pesan proaktif untuk data berikut (trigger: ${payload.triggerType}):\n\n${JSON.stringify(payload.data, null, 2)}`;
}

/**
 * Compose a message via a single generateText call (no tools — the detector
 * already gathered the data). Throws on failure; the resolver falls back to the
 * template composer.
 */
export async function llmCompose(payload: ProactivePayload, model: LanguageModel): Promise<string> {
  const { text } = await generateText({
    model,
    system: PROACTIVE_SYSTEM_PROMPT,
    prompt: serialize(payload),
  });
  return text;
}
