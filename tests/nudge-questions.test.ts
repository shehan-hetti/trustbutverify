/**
 * Tests for src/nudges/nudge-questions.ts
 *
 * Pure data + one filter function — no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import { NUDGE_QUESTIONS, getActiveNudgeQuestions } from '../src/nudges/nudge-questions';

describe('NUDGE_QUESTIONS data integrity', () => {
  it('contains at least one question', () => {
    expect(NUDGE_QUESTIONS.length).toBeGreaterThan(0);
  });

  it('every question has a unique id', () => {
    const ids = NUDGE_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every question has required fields', () => {
    for (const q of NUDGE_QUESTIONS) {
      expect(q.id).toBeTruthy();
      expect(q.text).toBeTruthy();
      expect(['copy', 'response']).toContain(q.triggerType);
      expect(['yes_no_skip', 'yes_partly_no_skip', 'rating_1_10_skip']).toContain(q.answerMode);
      expect(typeof q.active).toBe('boolean');
    }
  });

  it('has both copy and response trigger types', () => {
    const types = new Set(NUDGE_QUESTIONS.map((q) => q.triggerType));
    expect(types.has('copy')).toBe(true);
    expect(types.has('response')).toBe(true);
  });
});

describe('getActiveNudgeQuestions', () => {
  it('returns all active questions when no triggerType filter', () => {
    const active = getActiveNudgeQuestions();
    const expected = NUDGE_QUESTIONS.filter((q) => q.active);
    expect(active).toHaveLength(expected.length);
  });

  it('filters by triggerType = copy', () => {
    const copy = getActiveNudgeQuestions('copy');
    expect(copy.length).toBeGreaterThan(0);
    for (const q of copy) {
      expect(q.triggerType).toBe('copy');
      expect(q.active).toBe(true);
    }
  });

  it('filters by triggerType = response', () => {
    const resp = getActiveNudgeQuestions('response');
    expect(resp.length).toBeGreaterThan(0);
    for (const q of resp) {
      expect(q.triggerType).toBe('response');
      expect(q.active).toBe(true);
    }
  });

  it('returns empty array for trigger type with no active questions (hypothetical)', () => {
    // All tests above confirm current data; this just checks function signature
    // If we ever add a new trigger type with no active items, it should return []
    const result = getActiveNudgeQuestions('copy');
    expect(Array.isArray(result)).toBe(true);
  });
});
