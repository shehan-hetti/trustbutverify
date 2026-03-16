import type { NudgeQuestion } from '../types';

/**
 * Static question bank (versioned in source control).
 * Update wording/flags here without changing runtime logic.
 */
export const NUDGE_QUESTIONS: NudgeQuestion[] = [
  {
    id: 'copy-double-check-1',
    text: 'Any part here you would want to double-check before using?',
    triggerType: 'copy',
    answerMode: 'yes_no_skip',
    active: true,
    tags: ['accountability', 'factual-correctness', 'self-reflection']
  },
  {
    id: 'copy-factual-confidence-1',
    text: 'On a scale of 1-10, how confident are you this is factually accurate?',
    triggerType: 'copy',
    answerMode: 'rating_1_10_skip',
    active: true,
    tags: ['factual-correctness'],
    ratingLabels: { low: 'not confident', high: 'very confident' }
  },
  {
    id: 'copy-surprises-1',
    text: 'Is there anything in this output that surprises you?',
    triggerType: 'copy',
    answerMode: 'yes_no_skip',
    active: true,
    tags: ['accountability']
  },
  {
    id: 'copy-verify-source-1',
    text: 'Any claim here you would verify with another source first?',
    triggerType: 'copy',
    answerMode: 'yes_no_skip',
    active: true,
    tags: ['accountability', 'factual-correctness']
  },
  {
    id: 'copy-own-thinking-1',
    text: 'How much of your own thinking is in this copied output?',
    triggerType: 'copy',
    answerMode: 'rating_1_10_skip',
    active: true,
    tags: ['accountability'],
    ratingLabels: { low: 'mostly AI', high: 'mostly me' }
  },
  {
    id: 'copy-editing-1',
    text: 'Are you adding or changing anything in this output before using it?',
    triggerType: 'copy',
    answerMode: 'yes_no_skip',
    active: true,
    tags: ['accountability'],
    yesLabel: 'Yes (I am editing it)'
  },
  {
    id: 'copy-alignment-1',
    text: 'How well does this align with your original plan or idea?',
    triggerType: 'copy',
    answerMode: 'rating_1_10_skip',
    active: true,
    tags: ['accountability', 'self-reflection'],
    ratingLabels: { low: 'not well', high: 'very well' }
  },
  {
    id: 'copy-learning-1',
    text: 'On a scale of 1-10, how much did you learn from working with this output?',
    triggerType: 'copy',
    answerMode: 'rating_1_10_skip',
    active: true,
    tags: ['self-reflection']
  },
  {
    id: 'copy-feeling-good-1',
    text: 'Feeling good about how you used AI for your work?',
    triggerType: 'copy',
    answerMode: 'yes_partly_no_skip',
    active: true,
    tags: ['self-reflection']
  }
];

export function getActiveNudgeQuestions(triggerType?: NudgeQuestion['triggerType']): NudgeQuestion[] {
  return NUDGE_QUESTIONS.filter((q) => q.active && (!triggerType || q.triggerType === triggerType));
}
