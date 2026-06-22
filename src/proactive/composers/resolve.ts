import type { LanguageModel } from 'ai';
import type { Composer } from '../types.js';
import { llmCompose } from './llm.js';
import { templateCompose } from './template.js';
import { logEvent } from '../../utils/logger.js';

/**
 * Build a Composer that routes by payload.channel. LLM-channel payloads try the
 * LLM composer and fall back to the template composer on any error, so a model
 * failure never silently drops a proactive message (design §11).
 */
export function createComposer(model: LanguageModel): Composer {
  return async (payload) => {
    if (payload.channel === 'template') return templateCompose(payload);
    try {
      return await llmCompose(payload, model);
    } catch (err) {
      logEvent('warn', 'proactive llm compose failed; falling back to template', {
        triggerType: payload.triggerType,
        error: (err as Error).message,
      });
      return templateCompose(payload);
    }
  };
}
