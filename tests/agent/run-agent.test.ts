import { describe, it, expect, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import { withNormalizedToolNames } from '../../src/agent/run-agent.js';

// Gemini via OpenRouter leaks its default API namespace into tool-call names
// ("default_api.set_accounts_mode"); the SDK's literal lookup then throws
// NoSuchToolError. The wrapper must strip that prefix and nothing else.
function fakeModel(doGenerate: LanguageModel['doGenerate'], doStream?: LanguageModel['doStream']): LanguageModel {
  return { doGenerate, doStream: doStream ?? vi.fn() } as unknown as LanguageModel;
}

describe('withNormalizedToolNames — doGenerate', () => {
  it('strips the default_api. prefix from tool-call names', async () => {
    const model = fakeModel(vi.fn(async () => ({
      toolCalls: [{ toolCallType: 'function' as const, toolCallId: 'c1', toolName: 'default_api.set_accounts_mode', args: {} }],
    })) as never);
    const response = await withNormalizedToolNames(model).doGenerate({} as never);
    expect(response.toolCalls?.[0]?.toolName).toBe('set_accounts_mode');
  });

  it('leaves unprefixed tool names untouched', async () => {
    const model = fakeModel(vi.fn(async () => ({
      toolCalls: [{ toolCallType: 'function' as const, toolCallId: 'c1', toolName: 'create_expense', args: {} }],
    })) as never);
    const response = await withNormalizedToolNames(model).doGenerate({} as never);
    expect(response.toolCalls?.[0]?.toolName).toBe('create_expense');
  });

  it('passes through responses without toolCalls', async () => {
    const model = fakeModel(vi.fn(async () => ({ text: 'oke' })) as never);
    const response = await withNormalizedToolNames(model).doGenerate({} as never);
    expect((response as { text: string }).text).toBe('oke');
    expect(response.toolCalls).toBeUndefined();
  });
});

describe('withNormalizedToolNames — doStream', () => {
  it('rewrites tool-call parts mid-stream and passes other parts unchanged', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'tool-call', toolCallId: 'c1', toolName: 'default_api.set_accounts_mode', args: {} });
        controller.enqueue({ type: 'text-delta', textDelta: 'hai' });
        controller.close();
      },
    });
    const model = fakeModel(vi.fn(), vi.fn(async () => ({ stream })) as never);
    const { stream: out } = await withNormalizedToolNames(model).doStream({} as never);
    const reader = out.getReader();
    const parts: Array<{ type: string, toolName?: string, textDelta?: string }> = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as { type: string, toolName?: string, textDelta?: string });
    }
    expect(parts[0]).toMatchObject({ type: 'tool-call', toolName: 'set_accounts_mode' });
    expect(parts[1]).toEqual({ type: 'text-delta', textDelta: 'hai' });
  });
});
