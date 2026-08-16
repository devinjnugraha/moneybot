import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/agent/system-prompt.js';

describe('system prompt — advisory rules', () => {
	const prompt = buildSystemPrompt('2026-08-17');

	it('mentions get_analytics and get_financial_health in the advisory section', () => {
		expect(prompt).toContain('ANALISIS & SARAN');
		expect(prompt).toContain('get_analytics');
	});

	it('forbids inventing figures and requires grounding in tool metrics', () => {
		expect(prompt).toContain('Jangan mengarang');
		expect(prompt).toContain('insufficient_data');
	});

	it('keeps prose interpretation-only (no table restating)', () => {
		expect(prompt).toContain('interpretasi');
	});
});
