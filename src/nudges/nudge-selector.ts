import type { NudgeQuestion, NudgeTriggerType } from '../types';
import { getActiveNudgeQuestions } from './nudge-questions';

/* ------------------------------------------------------------------ */
/*  Deterministic round-robin nudge question selector                 */
/*                                                                     */
/*  Maintains one pointer per trigger type (copy / response) in        */
/*  chrome.storage.local. Each call to getNextNudgeQuestion() advances */
/*  the pointer, cycling through the active question pool for that     */
/*  trigger type without repeating until the full cycle completes.     */
/*                                                                     */
/*  If questions are added or removed between calls the pointer wraps  */
/*  safely via modulo — worst case a question is skipped or repeated   */
/*  once, then the cycle self-corrects.                                */
/* ------------------------------------------------------------------ */

/** chrome.storage.local key — must not collide with keys in storage.ts */
const POINTERS_STORAGE_KEY = 'nudgeRoundRobinPointers';

/** Persisted shape: { copy: number, response: number } */
interface RoundRobinPointers {
  copy: number;
  response: number;
}

const DEFAULT_POINTERS: RoundRobinPointers = { copy: 0, response: 0 };

/* ─── Internal helpers ─────────────────────────────────────────────── */

async function loadPointers(): Promise<RoundRobinPointers> {
  try {
    const result = await chrome.storage.local.get(POINTERS_STORAGE_KEY);
    const stored = result[POINTERS_STORAGE_KEY] as Partial<RoundRobinPointers> | undefined;
    if (!stored || typeof stored !== 'object') {
      return { ...DEFAULT_POINTERS };
    }
    return {
      copy: typeof stored.copy === 'number' ? stored.copy : 0,
      response: typeof stored.response === 'number' ? stored.response : 0
    };
  } catch {
    return { ...DEFAULT_POINTERS };
  }
}

async function savePointers(pointers: RoundRobinPointers): Promise<void> {
  try {
    await chrome.storage.local.set({ [POINTERS_STORAGE_KEY]: pointers });
  } catch (error) {
    console.error('[NudgeSelector] Failed to persist pointers:', error);
  }
}

/* ─── Public API ───────────────────────────────────────────────────── */

/**
 * Pick the next active question for the given trigger type using
 * deterministic round-robin.
 *
 * Returns `null` if no active questions exist for that trigger type
 * (e.g. all questions with that trigger are deactivated).
 *
 * The pointer is advanced and persisted on every successful call so
 * the cycle survives service-worker restarts and extension reloads.
 */
export async function getNextNudgeQuestion(
  triggerType: NudgeTriggerType
): Promise<NudgeQuestion | null> {
  const pool = getActiveNudgeQuestions(triggerType);
  if (pool.length === 0) {
    return null;
  }

  // Sort by id for a stable ordering independent of array declaration order
  pool.sort((a, b) => a.id.localeCompare(b.id));

  const pointers = await loadPointers();
  const currentIndex = pointers[triggerType] % pool.length;
  const selected = pool[currentIndex];

  // Advance pointer (wraps naturally via modulo on next call)
  pointers[triggerType] = currentIndex + 1;
  await savePointers(pointers);

  return selected;
}

/**
 * Peek at the next question without advancing the pointer.
 * Useful for diagnostics or UI previews.
 */
export async function peekNextNudgeQuestion(
  triggerType: NudgeTriggerType
): Promise<NudgeQuestion | null> {
  const pool = getActiveNudgeQuestions(triggerType);
  if (pool.length === 0) {
    return null;
  }

  pool.sort((a, b) => a.id.localeCompare(b.id));

  const pointers = await loadPointers();
  const currentIndex = pointers[triggerType] % pool.length;
  return pool[currentIndex];
}

/**
 * Reset the pointer for a specific trigger type (or both).
 * Useful for testing or when the question bank is reconfigured.
 */
export async function resetNudgePointer(
  triggerType?: NudgeTriggerType
): Promise<void> {
  const pointers = await loadPointers();
  if (!triggerType) {
    pointers.copy = 0;
    pointers.response = 0;
  } else {
    pointers[triggerType] = 0;
  }
  await savePointers(pointers);
}
