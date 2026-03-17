/**
 * Tests for deterministic nudge-event ID format used by content-script.
 *
 * The ID builder is currently a private method in content-script, so we
 * replicate the pure logic here (same approach as service-worker-utils tests).
 */
import { describe, it, expect } from 'vitest';

function buildNudgeEventIdFactory() {
  const collisions = new Map<string, number>();

  return (questionId: string, timestampMs: number): string => {
    const sanitizedQuestionId = (questionId || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
    const baseId = `nudge-${sanitizedQuestionId}-${timestampMs}`;
    const seenCount = (collisions.get(baseId) || 0) + 1;
    collisions.set(baseId, seenCount);

    if (collisions.size > 500) {
      collisions.clear();
    }

    return seenCount === 1 ? baseId : `${baseId}-${seenCount}`;
  };
}

describe('nudge event id format', () => {
  it('builds id as nudge-<questionId>-<timestamp>', () => {
    const build = buildNudgeEventIdFactory();
    const id = build('copy-own-thinking-1', 1771405123456);
    expect(id).toBe('nudge-copy-own-thinking-1-1771405123456');
  });

  it('sanitizes question id into a safe token', () => {
    const build = buildNudgeEventIdFactory();
    const id = build('Copy Own Thinking #1', 1000);
    expect(id).toBe('nudge-copy-own-thinking-1-1000');
  });

  it('adds numeric suffix when base id repeats in same runtime', () => {
    const build = buildNudgeEventIdFactory();
    const id1 = build('copy-own-thinking-1', 1000);
    const id2 = build('copy-own-thinking-1', 1000);
    const id3 = build('copy-own-thinking-1', 1000);

    expect(id1).toBe('nudge-copy-own-thinking-1-1000');
    expect(id2).toBe('nudge-copy-own-thinking-1-1000-2');
    expect(id3).toBe('nudge-copy-own-thinking-1-1000-3');
  });
});
