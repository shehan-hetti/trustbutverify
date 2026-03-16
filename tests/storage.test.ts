/**
 * Tests for src/utils/storage.ts – StorageManager
 *
 * All tests use the in-memory chrome.storage.local mock from setup.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StorageManager } from '../src/utils/storage';
import type { CopyActivity, ConversationTurn, ConversationLog, NudgeEvent } from '../src/types';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeCopyActivity(overrides?: Partial<CopyActivity>): CopyActivity {
  return {
    id: `copy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    url: 'https://chatgpt.com/c/test-thread',
    domain: 'chatgpt.com',
    conversationId: 'chatgpt.com::test-thread',
    copiedText: 'Hello world',
    textLength: 11,
    ...overrides,
  };
}

function makeTurn(overrides?: Partial<ConversationTurn>): ConversationTurn {
  const ts = Date.now();
  return {
    id: `turn-${ts}`,
    ts,
    prompt: {
      text: 'What is TypeScript?',
      textLength: 19,
      ts: ts - 2000,
    },
    response: {
      text: 'TypeScript is a typed superset of JavaScript.',
      textLength: 46,
      ts,
    },
    ...overrides,
  };
}

function makeNudgeEvent(overrides?: Partial<NudgeEvent>): NudgeEvent {
  return {
    id: `nudge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    conversationId: 'chatgpt.com::test-thread',
    domain: 'chatgpt.com',
    triggerType: 'copy',
    nudgeQuestionId: 'copy-confidence-1',
    nudgeQuestionText: 'Did you copy this because you trust this response?',
    response: 'yes',
    responseTimeMs: 1500,
    dismissedBy: 'answer',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Conversation / Turn CRUD                                           */
/* ------------------------------------------------------------------ */

describe('StorageManager – conversations & turns', () => {
  it('starts with no conversations', async () => {
    const convos = await StorageManager.getAllConversations();
    expect(convos).toEqual([]);
  });

  it('upsertConversationTurns creates a new conversation', async () => {
    const turn = makeTurn();
    await StorageManager.upsertConversationTurns(
      'chatgpt.com::thread-1',
      { url: 'https://chatgpt.com/c/thread-1', domain: 'chatgpt.com', platform: 'ChatGPT' },
      [turn],
    );

    const convos = await StorageManager.getAllConversations();
    expect(convos).toHaveLength(1);
    expect(convos[0].id).toBe('chatgpt.com::thread-1');
    expect(convos[0].turns).toHaveLength(1);
    expect(convos[0].platform).toBe('ChatGPT');
  });

  it('upsertConversationTurns appends turns to existing conversation', async () => {
    const turn1 = makeTurn({ ts: Date.now() - 10000 });
    await StorageManager.upsertConversationTurns('t1', { url: 'https://chatgpt.com/c/t1', domain: 'chatgpt.com' }, [turn1]);

    const turn2 = makeTurn({ ts: Date.now() });
    turn2.prompt.text = 'Follow-up question';
    turn2.response.text = 'Follow-up answer';
    await StorageManager.upsertConversationTurns('t1', undefined, [turn2]);

    const convos = await StorageManager.getAllConversations();
    expect(convos).toHaveLength(1);
    expect(convos[0].turns).toHaveLength(2);
    // Second turn should have previousTurnId pointing to first
    expect(convos[0].turns[1].previousTurnId).toBe(convos[0].turns[0].id);
  });

  it('deduplicates near-duplicate turns within 5 s window', async () => {
    const ts = Date.now();
    const turn = makeTurn({ ts });
    await StorageManager.upsertConversationTurns('t1', { url: 'https://chatgpt.com/c/t1', domain: 'chatgpt.com' }, [turn]);

    // Insert an identical turn with a very close timestamp
    const dup = { ...makeTurn({ ts: ts + 1000 }), prompt: { ...turn.prompt }, response: { ...turn.response } };
    await StorageManager.upsertConversationTurns('t1', undefined, [dup]);

    const convos = await StorageManager.getAllConversations();
    expect(convos[0].turns).toHaveLength(1);
  });

  it('getConversationById returns the correct conversation', async () => {
    await StorageManager.upsertConversationTurns('a', { url: 'https://chatgpt.com/c/a', domain: 'chatgpt.com' }, [makeTurn()]);
    await StorageManager.upsertConversationTurns('b', { url: 'https://chatgpt.com/c/b', domain: 'chatgpt.com' }, [makeTurn()]);

    const convo = await StorageManager.getConversationById('a');
    expect(convo).toBeDefined();
    expect(convo!.id).toBe('a');
  });

  it('clearAllConversations removes everything', async () => {
    await StorageManager.upsertConversationTurns('t1', { url: 'u', domain: 'd' }, [makeTurn()]);
    await StorageManager.clearAllConversations();
    const convos = await StorageManager.getAllConversations();
    expect(convos).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Copy Activity CRUD                                                 */
/* ------------------------------------------------------------------ */

describe('StorageManager – copy activities', () => {
  it('saveActivity stores a copy activity inside its conversation', async () => {
    const activity = makeCopyActivity({ conversationId: 'chatgpt.com::t1' });
    await StorageManager.saveActivity(activity);

    const all = await StorageManager.getAllActivities();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(activity.id);
  });

  it('getCopyActivityById returns the correct activity', async () => {
    const a = makeCopyActivity({ id: 'find-me', conversationId: 'chatgpt.com::t1' });
    await StorageManager.saveActivity(a);

    const found = await StorageManager.getCopyActivityById('find-me');
    expect(found).toBeDefined();
    expect(found!.id).toBe('find-me');
  });

  it('getCopyActivityById returns undefined for unknown id', async () => {
    expect(await StorageManager.getCopyActivityById('nonexistent')).toBeUndefined();
  });

  it('getRecentActivities respects the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await StorageManager.saveActivity(
        makeCopyActivity({ id: `a-${i}`, timestamp: Date.now() + i, conversationId: 'chatgpt.com::t1' }),
      );
    }
    const recent = await StorageManager.getRecentActivities(3);
    expect(recent).toHaveLength(3);
  });

  it('clearAllActivities empties copy arrays but keeps conversations', async () => {
    await StorageManager.upsertConversationTurns('t1', { url: 'u', domain: 'd' }, [makeTurn()]);
    await StorageManager.saveActivity(makeCopyActivity({ conversationId: 't1' }));

    await StorageManager.clearAllActivities();
    const activities = await StorageManager.getAllActivities();
    expect(activities).toHaveLength(0);

    // Conversation still exists
    const convos = await StorageManager.getAllConversations();
    expect(convos.length).toBeGreaterThan(0);
  });

  it('does not duplicate copy activity with same id', async () => {
    const a = makeCopyActivity({ id: 'dup-1', conversationId: 'chatgpt.com::t1' });
    await StorageManager.saveActivity(a);
    await StorageManager.saveActivity(a);

    const all = await StorageManager.getAllActivities();
    expect(all.filter((x) => x.id === 'dup-1')).toHaveLength(1);
  });

  it('patchCopyActivityById updates specific fields', async () => {
    await StorageManager.saveActivity(
      makeCopyActivity({ id: 'patch-me', conversationId: 'chatgpt.com::t1', copyCategory: undefined }),
    );
    await StorageManager.patchCopyActivityById('patch-me', { copyCategory: 'Code', copyCategorySource: 'llm' });

    const found = await StorageManager.getCopyActivityById('patch-me');
    expect(found!.copyCategory).toBe('Code');
    expect(found!.copyCategorySource).toBe('llm');
  });
});

/* ------------------------------------------------------------------ */
/*  Nudge Events                                                       */
/* ------------------------------------------------------------------ */

describe('StorageManager – nudge events', () => {
  it('saveNudgeEvent stores an event', async () => {
    await StorageManager.saveNudgeEvent(makeNudgeEvent({ id: 'ne-1' }));
    const all = await StorageManager.getAllNudgeEvents();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('ne-1');
  });

  it('does not duplicate nudge events with same id', async () => {
    const e = makeNudgeEvent({ id: 'ne-dup' });
    await StorageManager.saveNudgeEvent(e);
    await StorageManager.saveNudgeEvent(e);
    const all = await StorageManager.getAllNudgeEvents();
    expect(all.filter((x) => x.id === 'ne-dup')).toHaveLength(1);
  });

  it('getNudgeAggregateStats computes correct totals', async () => {
    await StorageManager.saveNudgeEvent(
      makeNudgeEvent({ id: 'ne-a', triggerType: 'copy', response: 'yes' }),
    );
    await StorageManager.saveNudgeEvent(
      makeNudgeEvent({ id: 'ne-b', triggerType: 'copy', response: 'skip' }),
    );
    await StorageManager.saveNudgeEvent(
      makeNudgeEvent({ id: 'ne-c', triggerType: 'response', response: 'no' }),
    );

    const stats = await StorageManager.getNudgeAggregateStats();
    expect(stats.totalShown).toBe(3);
    expect(stats.answered).toBe(2);
    expect(stats.skipped).toBe(1);
    expect(stats.dismissRateByQuestionType.copy).toBeCloseTo(0.5);
    expect(stats.dismissRateByQuestionType.response).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Participant / Sync config                                          */
/* ------------------------------------------------------------------ */

describe('StorageManager – participant & sync helpers', () => {
  it('participant UUID round-trip', async () => {
    expect(await StorageManager.getParticipantUuid()).toBeUndefined();
    await StorageManager.setParticipantUuid('test-uuid-123');
    expect(await StorageManager.getParticipantUuid()).toBe('test-uuid-123');
  });

  it('sync status round-trip', async () => {
    expect(await StorageManager.getSyncStatus()).toBe('idle');
    await StorageManager.setSyncStatus('syncing');
    expect(await StorageManager.getSyncStatus()).toBe('syncing');
  });

  it('lastSyncAt round-trip', async () => {
    expect(await StorageManager.getLastSyncAt()).toBeUndefined();
    const now = Date.now();
    await StorageManager.setLastSyncAt(now);
    expect(await StorageManager.getLastSyncAt()).toBe(now);
  });

  it('compactAfterSuccessfulSync keeps last 10 conversations, 20 copies per conversation, and 20 nudge events', async () => {
    const baseTs = Date.now() - 1_000_000;

    // Create 12 conversations with one turn each so they are syncable.
    for (let i = 0; i < 12; i++) {
      await StorageManager.upsertConversationTurns(
        `conv-${i}`,
        {
          url: `https://chatgpt.com/c/conv-${i}`,
          domain: 'chatgpt.com',
          platform: 'ChatGPT'
        },
        [
          makeTurn({
            ts: baseTs + i * 1000,
            prompt: {
              text: `Prompt ${i}`,
              textLength: `Prompt ${i}`.length,
              ts: baseTs + i * 1000 - 300
            },
            response: {
              text: `Response ${i}`,
              textLength: `Response ${i}`.length,
              ts: baseTs + i * 1000
            }
          })
        ]
      );
    }

    // Add 25 copy activities for each conversation.
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 25; j++) {
        await StorageManager.saveActivity(
          makeCopyActivity({
            id: `conv-${i}-copy-${j}`,
            conversationId: `conv-${i}`,
            timestamp: baseTs + i * 10_000 + j,
            copiedText: `Copy ${j} for conv-${i}`,
            textLength: `Copy ${j} for conv-${i}`.length
          })
        );
      }
    }

    // Add 30 nudge events.
    for (let i = 0; i < 30; i++) {
      await StorageManager.saveNudgeEvent(
        makeNudgeEvent({
          id: `nudge-${i}`,
          timestamp: baseTs + i * 500,
          conversationId: `conv-${i % 12}`
        })
      );
    }

    await StorageManager.compactAfterSuccessfulSync();

    const conversations = await StorageManager.getAllConversations();
    const nudgeEvents = await StorageManager.getAllNudgeEvents();

    expect(conversations).toHaveLength(10);
    expect(nudgeEvents).toHaveLength(20);

    for (const convo of conversations) {
      expect((convo.copyActivities || []).length).toBeLessThanOrEqual(20);
    }

    // Ensure we kept the most recently updated conversations.
    const ids = new Set(conversations.map((c) => c.id));
    expect(ids.has('conv-11')).toBe(true);
    expect(ids.has('conv-10')).toBe(true);
    expect(ids.has('conv-0')).toBe(false);
    expect(ids.has('conv-1')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Storage stats                                                      */
/* ------------------------------------------------------------------ */

describe('StorageManager – getStorageStats', () => {
  it('returns zeroed stats when storage is empty', async () => {
    const stats = await StorageManager.getStorageStats();
    expect(stats.totalCopies).toBe(0);
    expect(stats.totalConversations).toBe(0);
    expect(stats.totalPromptLength).toBe(0);
    expect(stats.totalResponseLength).toBe(0);
    expect(stats.averageResponseTime).toBe(0);
    expect(stats.domainBreakdown).toEqual({});
  });

  it('computes stats correctly with data', async () => {
    await StorageManager.upsertConversationTurns(
      'chatgpt.com::t1',
      { url: 'https://chatgpt.com/c/t1', domain: 'chatgpt.com' },
      [
        makeTurn({
          responseTimeMs: 2000,
          prompt: { text: 'hi', textLength: 2, ts: Date.now() - 3000 },
          response: { text: 'hello there', textLength: 11, ts: Date.now() },
        }),
      ],
    );
    await StorageManager.saveActivity(
      makeCopyActivity({ conversationId: 'chatgpt.com::t1' }),
    );

    const stats = await StorageManager.getStorageStats();
    expect(stats.totalConversations).toBe(1);
    expect(stats.totalCopies).toBe(1);
    expect(stats.totalPromptLength).toBe(2);
    expect(stats.totalResponseLength).toBe(11);
    expect(stats.averageResponseTime).toBe(2000);
    expect(stats.domainBreakdown['chatgpt.com']).toBe(1);
  });
});
