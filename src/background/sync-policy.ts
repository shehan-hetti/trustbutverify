import type { ConversationLog, NudgeEvent } from '../types';

export type SyncSkipReason = 'none' | 'empty' | 'no-new-data';

export interface SyncDecision {
  shouldSync: boolean;
  reason: SyncSkipReason;
}

/**
 * Decide whether a sync API call is necessary based on local payload state.
 */
export function evaluateSyncNeed(
  conversations: ConversationLog[],
  nudgeEvents: NudgeEvent[],
  lastSyncAt?: number
): SyncDecision {
  const hasSyncableConversationData = conversations.some(
    (c) => (c.turns?.length || 0) > 0 || (c.copyActivities?.length || 0) > 0
  );
  const hasSyncableData = hasSyncableConversationData || nudgeEvents.length > 0;

  if (!hasSyncableData) {
    return { shouldSync: false, reason: 'empty' };
  }

  const hasNewConversationData = lastSyncAt === undefined
    ? hasSyncableConversationData
    : conversations.some((c) => (c.lastUpdatedAt || 0) > lastSyncAt);
  const hasNewNudgeData = lastSyncAt === undefined
    ? nudgeEvents.length > 0
    : nudgeEvents.some((e) => (e.timestamp || 0) > lastSyncAt);

  if (!hasNewConversationData && !hasNewNudgeData) {
    return { shouldSync: false, reason: 'no-new-data' };
  }

  return { shouldSync: true, reason: 'none' };
}
