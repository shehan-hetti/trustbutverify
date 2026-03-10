/**
 * Tests for src/nudges/nudge-selector.ts
 *
 * Uses the chrome.storage.local mock from setup.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getNextNudgeQuestion, peekNextNudgeQuestion, resetNudgePointer } from '../src/nudges/nudge-selector';
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

  it('returns a question for "response" trigger type', async () => {
    const q = await getNextNudgeQuestion('response');
    expect(q).not.toBeNull();
    expect(q!.triggerType).toBe('response');
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

  it('copy and response pointers are independent', async () => {
    const copyQ1 = await getNextNudgeQuestion('copy');
    const respQ1 = await getNextNudgeQuestion('response');

    // Advance copy once more
    const copyQ2 = await getNextNudgeQuestion('copy');

    // Response should still give the second item on next call (not affected by copy advancement)
    const respQ2 = await getNextNudgeQuestion('response');

    expect(copyQ1).not.toBeNull();
    expect(respQ1).not.toBeNull();
    expect(copyQ2).not.toBeNull();
    expect(respQ2).not.toBeNull();
    // Q2 should differ from Q1 within each type (since pool.length > 1)
    expect(copyQ2!.id).not.toBe(copyQ1!.id);
    expect(respQ2!.id).not.toBe(respQ1!.id);
  });
});

describe('nudge-selector: peekNextNudgeQuestion', () => {
  beforeEach(async () => {
    await resetNudgePointer();
  });

  it('returns the same question as the next getNextNudgeQuestion would', async () => {
    const peeked = await peekNextNudgeQuestion('copy');
    const next = await getNextNudgeQuestion('copy');
    expect(peeked!.id).toBe(next!.id);
  });

  it('does not advance the pointer', async () => {
    const peek1 = await peekNextNudgeQuestion('copy');
    const peek2 = await peekNextNudgeQuestion('copy');
    expect(peek1!.id).toBe(peek2!.id);
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
    const respPool = getActiveNudgeQuestions('response').sort((a, b) => a.id.localeCompare(b.id));

    const c = await getNextNudgeQuestion('copy');
    const r = await getNextNudgeQuestion('response');
    expect(c!.id).toBe(copyPool[0].id);
    expect(r!.id).toBe(respPool[0].id);
  });
});
