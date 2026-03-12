import type { NudgeQuestion } from '../types';

/**
 * Static question bank (versioned in source control).
 * Update wording/flags here without changing runtime logic.
 */
export const NUDGE_QUESTIONS: NudgeQuestion[] = [
  {
    id: 'copy-confidence-1',
    text: 'Did you copy this because you trust this response?',
    triggerType: 'copy',
    answerMode: 'yes_no_skip',
    active: true,
    tags: ['reinforce']
  },
  {
    id: 'copy-verify-1',
    text: 'Will you verify this copied content before using it?',
    triggerType: 'copy',
    answerMode: 'yes_partly_no_skip',
    active: true,
    tags: ['confront']
  },
  {
    id: 'response-clarity-1',
    text: 'How clear was this response for your task?',
    triggerType: 'response',
    answerMode: 'rating_1_10_skip',
    active: true,
    tags: ['reinforce']
  },
  {
    id: 'response-reliability-1',
    text: 'Does this response feel reliable enough to act on?',
    triggerType: 'response',
    answerMode: 'yes_partly_no_skip',
    active: true,
    tags: ['confront']
  },
  {
    id: 'response-followup-1',
    text: 'Would you ask a follow-up before using this answer?',
    triggerType: 'response',
    answerMode: 'yes_no_skip',
    active: true,
    tags: ['confront']
  }
];

export function getActiveNudgeQuestions(triggerType?: NudgeQuestion['triggerType']): NudgeQuestion[] {
  return NUDGE_QUESTIONS.filter((q) => q.active && (!triggerType || q.triggerType === triggerType));
}
