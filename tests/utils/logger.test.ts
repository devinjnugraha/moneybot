import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logEvent } from '../../src/utils/logger.js';

describe('logEvent', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('info level writes JSON to console.log with timestamp, level, message', () => {
    logEvent('info', 'test message');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    const arg = logSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed).toMatchObject({ level: 'info', message: 'test message' });
    expect(parsed.timestamp).toBeDefined();
    // Valid ISO 8601
    expect(Date.parse(parsed.timestamp)).not.toBeNaN();
  });

  it('error level writes JSON to console.error', () => {
    logEvent('error', 'something broke');
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    const arg = errorSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed).toMatchObject({ level: 'error', message: 'something broke' });
  });

  it('context fields appear in the JSON output', () => {
    logEvent('info', 'user action', { userId: 'u1', chatId: '123' });
    const arg = logSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.userId).toBe('u1');
    expect(parsed.chatId).toBe('123');
  });

  it('undefined context is handled (no extra keys beyond base)', () => {
    logEvent('warn', 'just a warning');
    const arg = logSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(arg);
    expect(Object.keys(parsed)).toContain('timestamp');
    expect(Object.keys(parsed)).toContain('level');
    expect(Object.keys(parsed)).toContain('message');
  });

  it('ad-hoc keys beyond the typed ones are included', () => {
    logEvent('debug', 'extra context', { customField: 42, nested: { x: 1 } });
    const arg = logSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.customField).toBe(42);
    expect(parsed.nested).toEqual({ x: 1 });
  });
});
