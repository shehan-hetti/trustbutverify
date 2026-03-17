/**
 * Tests for src/nudges/nudge-selector.ts
 *
 * Uses the chrome.storage.local mock from setup.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getNextNudgeQuestion, resetNudgePointer } from '../src/nudges/nudge-selector';
import { getActiveNudgeQuestions } from '../src/nudges/nudge-questions';

describe('nudge-selector: getNextNudgeQuestion', () => {
  beforeEach(async () => {
    await resetNudgePointer();
  });

  it('returns a question for "copy" trigger type', async () => {
    const q = await getNextNudgeQuestion('copy');
    expect(q).not.toBeNull();
    expect(q!.triggerType).toBe('copy');
  });

  it('returns null for "response" trigger type when response pool is empty', async () => {
    const q = await getNextNudgeQuestion('response');
    expect(q).toBeNull();
  });

  it('cycles through all copy questions in round-robin order', async () => {
    const pool = getActiveNudgeQuestions('copy').sort((a, b) => a.id.localeCompare(b.id));
    const seen: string[] = [];

    for (let i = 0; i < pool.length; i++) {
      const q = await getNextNudgeQuestion('copy');
      seen.push(q!.id);
    }

    // Should match the sorted pool order
    expect(seen).toEqual(pool.map((q) => q.id));
  });

  it('wraps around after a full cycle', async () => {
    const pool = getActiveNudgeQuestions('copy').sort((a, b) => a.id.localeCompare(b.id));
    // Exhaust one full cycle
    for (let i = 0; i < pool.length; i++) {
      await getNextNudgeQuestion('copy');
    }
    // Next question should be the first again
    const q = await getNextNudgeQuestion('copy');
    expect(q!.id).toBe(pool[0].id);
  });

  it('empty response pool calls do not affect copy round-robin sequence', async () => {
    const copyPool = getActiveNudgeQuestions('copy').sort((a, b) => a.id.localeCompare(b.id));

    const resp1 = await getNextNudgeQuestion('response');
    const resp2 = await getNextNudgeQuestion('response');
    const copy1 = await getNextNudgeQuestion('copy');
    const copy2 = await getNextNudgeQuestion('copy');

    expect(resp1).toBeNull();
    expect(resp2).toBeNull();
    expect(copy1!.id).toBe(copyPool[0].id);
    if (copyPool.length > 1) {
      expect(copy2!.id).toBe(copyPool[1].id);
    }
  });
});

describe('nudge-selector: resetNudgePointer', () => {
  it('resets a specific trigger type', async () => {
    // Advance copy twice
    await getNextNudgeQuestion('copy');
    await getNextNudgeQuestion('copy');

    // Reset copy only
    await resetNudgePointer('copy');

    // Next should be the first item again (sorted pool[0])
    const pool = getActiveNudgeQuestions('copy').sort((a, b) => a.id.localeCompare(b.id));
    const q = await getNextNudgeQuestion('copy');
    expect(q!.id).toBe(pool[0].id);
  });

  it('resets both trigger types when called without argument', async () => {
    await getNextNudgeQuestion('copy');
    await getNextNudgeQuestion('response');
    await resetNudgePointer();

    const copyPool = getActiveNudgeQuestions('copy').sort((a, b) => a.id.localeCompare(b.id));

    const c = await getNextNudgeQuestion('copy');
    const r = await getNextNudgeQuestion('response');
    expect(c!.id).toBe(copyPool[0].id);
    expect(r).toBeNull();
  });
});
