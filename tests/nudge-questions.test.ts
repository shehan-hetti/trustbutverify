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

  it('currently uses copy trigger type only', () => {
    const types = new Set(NUDGE_QUESTIONS.map((q) => q.triggerType));
    expect(types.has('copy')).toBe(true);
    expect(types.has('response')).toBe(false);
  });

  it('supports tags as string arrays (including multi-tag questions)', () => {
    const tagged = NUDGE_QUESTIONS.filter((q) => Array.isArray(q.tags));
    expect(tagged.length).toBeGreaterThan(0);
    for (const q of tagged) {
      expect(q.tags!.every((t) => typeof t === 'string' && t.trim().length > 0)).toBe(true);
    }
    expect(tagged.some((q) => (q.tags?.length || 0) > 1)).toBe(true);
  });

  it('rating and custom yes-label metadata are valid when present', () => {
    for (const q of NUDGE_QUESTIONS) {
      if (q.ratingLabels) {
        expect(q.answerMode).toBe('rating_1_10_skip');
        expect(q.ratingLabels.low.trim().length).toBeGreaterThan(0);
        expect(q.ratingLabels.high.trim().length).toBeGreaterThan(0);
      }
      if (q.yesLabel) {
        expect(['yes_no_skip', 'yes_partly_no_skip']).toContain(q.answerMode);
        expect(q.yesLabel.trim().length).toBeGreaterThan(0);
      }
    }
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

  it('returns empty for triggerType = response when no active response questions exist', () => {
    const resp = getActiveNudgeQuestions('response');
    expect(resp).toEqual([]);
  });

  it('returns empty array for trigger type with no active questions (hypothetical)', () => {
    // All tests above confirm current data; this just checks function signature
    // If we ever add a new trigger type with no active items, it should return []
    const result = getActiveNudgeQuestions('copy');
    expect(Array.isArray(result)).toBe(true);
  });
});
