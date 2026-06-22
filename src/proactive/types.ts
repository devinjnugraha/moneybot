import type { LanguageModel } from 'ai';
import type { ProactiveTriggerType } from '../domain/entities.js';
import type { Repos } from '../repositories/interfaces.js';

export type ComposerChannel = 'llm' | 'template';

export interface ProactivePayload {
  triggerType: ProactiveTriggerType;
  dedupKey: string; // DB-uniqueness key (design §6)
  channel: ComposerChannel; // selects the composer
  data: Record<string, unknown>; // trigger-specific facts for the composer
}

/** Context passed to a composer. `now` is injected — never real time. */
export interface ComposerCtx {
  now: Date;
}

/** Turns one payload into the user-facing Bahasa Indonesia message. */
export type Composer = (payload: ProactivePayload, ctx: ComposerCtx) => Promise<string>;

/**
 * A detector is PURE given repos + an injected `now`. Returns 0..N payloads.
 * `[]` means "nothing worth saying". (Design §4.)
 */
export type Detector = (ctx: {
  userId: string;
  repos: Repos;
  now: Date;
}) => Promise<ProactivePayload[]>;

/** Tunable policy injected into the dispatcher (built from config in cron.ts). */
export interface ProactivePolicy {
  enabled: boolean;
  maxPerDay: number;
  quietHours: string; // "HH:MM-HH:MM" (WIB), may cross midnight
  contextWindowTurns: number;
}

// `LanguageModel` is re-exported so callers wiring the composer need only this module.
export type { LanguageModel };
