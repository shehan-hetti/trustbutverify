import { describe, it, expect } from 'vitest';
import { evaluateSyncNeed } from '../src/background/sync-policy';
import type { ConversationLog, ConversationTurn, NudgeEvent } from '../src/types';

function makeTurn(ts: number): ConversationTurn {
  return {
    id: `turn-${ts}`,
    ts,
    prompt: {
      text: 'Prompt text',
      textLength: 11,
      ts: ts - 500,
    },
    response: {
      text: 'Response text',
      textLength: 13,
      ts,
    },
  };
}

function makeConversation(overrides?: Partial<ConversationLog>): ConversationLog {
  const now = Date.now();
  return {
    id: 'conv-1',
    url: 'https://chatgpt.com/c/conv-1',
    domain: 'chatgpt.com',
    createdAt: now,
    lastUpdatedAt: now,
    turns: [],
    copyActivities: [],
    ...overrides,
  };
}

function makeNudgeEvent(ts: number): NudgeEvent {
  return {
    id: `nudge-${ts}`,
    timestamp: ts,
    conversationId: 'conv-1',
    domain: 'chatgpt.com',
    triggerType: 'copy',
    nudgeQuestionId: 'copy-confidence-1',
    nudgeQuestionText: 'Did you copy this because you trust this response?',
    response: 'yes',
    responseTimeMs: 1200,
    dismissedBy: 'answer',
  };
}

describe('evaluateSyncNeed', () => {
  it('skips when no syncable data exists', () => {
    const decision = evaluateSyncNeed([], [], undefined);
    expect(decision.shouldSync).toBe(false);
    expect(decision.reason).toBe('empty');
  });

  it('skips when only empty conversation shells exist', () => {
    const shellConversations = [
      makeConversation({ id: 'conv-shell-1', turns: [], copyActivities: [], lastUpdatedAt: 1000 }),
      makeConversation({ id: 'conv-shell-2', turns: [], copyActivities: [], lastUpdatedAt: 2000 }),
    ];
    const decision = evaluateSyncNeed(shellConversations, [], undefined);
    expect(decision.shouldSync).toBe(false);
    expect(decision.reason).toBe('empty');
  });

  it('syncs on first run when conversations have turns/copies', () => {
    const conversations = [
      makeConversation({
        id: 'conv-1',
        lastUpdatedAt: 1000,
        turns: [makeTurn(900)],
      }),
    ];
    const decision = evaluateSyncNeed(conversations, [], undefined);
    expect(decision.shouldSync).toBe(true);
    expect(decision.reason).toBe('none');
  });

  it('syncs on first run when nudge events exist', () => {
    const nudges = [makeNudgeEvent(1500)];
    const decision = evaluateSyncNeed([], nudges, undefined);
    expect(decision.shouldSync).toBe(true);
    expect(decision.reason).toBe('none');
  });

  it('skips when all data is older than lastSyncAt', () => {
    const conversations = [
      makeConversation({
        id: 'conv-1',
        lastUpdatedAt: 1000,
        turns: [makeTurn(900)],
      }),
    ];
    const nudges = [makeNudgeEvent(1100)];

    const decision = evaluateSyncNeed(conversations, nudges, 2000);
    expect(decision.shouldSync).toBe(false);
    expect(decision.reason).toBe('no-new-data');
  });

  it('syncs when a conversation is newer than lastSyncAt', () => {
    const conversations = [
      makeConversation({
        id: 'conv-1',
        lastUpdatedAt: 3000,
        turns: [makeTurn(2900)],
      }),
    ];

    const decision = evaluateSyncNeed(conversations, [], 2000);
    expect(decision.shouldSync).toBe(true);
    expect(decision.reason).toBe('none');
  });

  it('syncs when a nudge event is newer than lastSyncAt', () => {
    const conversations = [
      makeConversation({
        id: 'conv-1',
        lastUpdatedAt: 1000,
        turns: [makeTurn(900)],
      }),
    ];
    const nudges = [makeNudgeEvent(3000)];

    const decision = evaluateSyncNeed(conversations, nudges, 2000);
    expect(decision.shouldSync).toBe(true);
    expect(decision.reason).toBe('none');
  });
});
