import type {
  CopyActivity,
  ConversationLog,
  ConversationTurn,
  NudgeAggregateStats,
  NudgeEvent,
  NudgeTriggerType,
  SyncStatus
} from '../types';

/**
 * Storage utility for managing copy activities and conversation logs
 */
export class StorageManager {
  private static readonly CONVERSATION_STORAGE_KEY = 'conversationLogs';
  private static readonly NUDGE_EVENTS_STORAGE_KEY = 'nudgeEvents';
  private static readonly MAX_ACTIVITIES = 1000;
  private static readonly MAX_CONVERSATIONS = 500;
  private static readonly MAX_NUDGE_EVENTS = 5000;
  private static readonly MAX_LOCAL_CONVERSATIONS_AFTER_SYNC = 10;
  private static readonly MAX_LOCAL_COPY_ACTIVITIES_PER_CONVERSATION_AFTER_SYNC = 20;
  private static readonly MAX_LOCAL_NUDGE_EVENTS_AFTER_SYNC = 20;

  private static normalizeTurnText(text: string): string {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  private static containmentSimilarity(a: string, b: string): number {
    const x = this.normalizeTurnText(a).toLowerCase();
    const y = this.normalizeTurnText(b).toLowerCase();
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y)) return y.length / x.length;
    if (y.includes(x)) return x.length / y.length;
    return 0;
  }

  private static deriveThreadIdFromUrl(url: string, domain: string): string {
    try {
      const u = new URL(url);
      const path = u.pathname;

      const threadMatch = path.match(/\/(?:c|app)\/([^/?#]+)/);
      if (threadMatch) {
        return `${domain}::${threadMatch[1]}`;
      }

      const key = `${u.origin}${u.pathname}`;
      let hash = 0;
      for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
      }
      return `${domain}::h${hash.toString(36)}`;
    } catch {
      return `${domain}::unknown`;
    }
  }

  private static flattenActivities(conversations: ConversationLog[]): CopyActivity[] {
    return conversations
      .flatMap((c) => c.copyActivities || [])
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  private static trimConversations(data: ConversationLog[]): void {
    if (data.length > this.MAX_CONVERSATIONS) {
      data.splice(0, data.length - this.MAX_CONVERSATIONS);
    }
  }

  private static trimNudgeEvents(events: NudgeEvent[]): void {
    if (events.length > this.MAX_NUDGE_EVENTS) {
      events.splice(0, events.length - this.MAX_NUDGE_EVENTS);
    }
  }

  private static pruneGlobalActivities(conversations: ConversationLog[]): void {
    const all = conversations
      .flatMap((convo) =>
        (convo.copyActivities || []).map((activity, idx) => ({
          conversationId: convo.id,
          idx,
          timestamp: activity.timestamp || 0
        }))
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    const excess = all.length - this.MAX_ACTIVITIES;
    if (excess <= 0) {
      return;
    }

    const toDrop = all.slice(0, excess);
    const dropByConversation = new Map<string, Set<number>>();
    for (const item of toDrop) {
      if (!dropByConversation.has(item.conversationId)) {
        dropByConversation.set(item.conversationId, new Set<number>());
      }
      dropByConversation.get(item.conversationId)!.add(item.idx);
    }

    for (const convo of conversations) {
      const indexes = dropByConversation.get(convo.id);
      if (!indexes || !convo.copyActivities || convo.copyActivities.length === 0) {
        continue;
      }
      convo.copyActivities = convo.copyActivities.filter((_, idx) => !indexes.has(idx));
    }
  }

  /**
   * Save a copy activity to storage
   */
  static async saveActivity(activity: CopyActivity): Promise<void> {
    try {
      await this.attachCopyToConversation(activity.conversationId, activity);
    } catch (error) {
      console.error('Error saving activity:', error);
      throw error;
    }
  }

  /**
   * Get all copy activities
   */
  static async getAllActivities(): Promise<CopyActivity[]> {
    try {
      const conversations = await this.getAllConversations();
      return this.flattenActivities(conversations);
    } catch (error) {
      console.error('Error getting activities:', error);
      return [];
    }
  }

  static async getCopyActivityById(activityId: string): Promise<CopyActivity | undefined> {
    if (!activityId) {
      return undefined;
    }
    const activities = await this.getAllActivities();
    return activities.find((a) => a.id === activityId);
  }

  /**
   * Get recent activities with limit
   */
  static async getRecentActivities(limit: number = 50): Promise<CopyActivity[]> {
    const activities = await this.getAllActivities();
    // Return the most recent activities (stored at the end)
    return activities.slice(-limit);
  }

  /**
   * Clear all activities
   */
  static async clearAllActivities(): Promise<void> {
    try {
      const conversations = await this.getAllConversations();
      for (const convo of conversations) {
        if (convo.copyActivities?.length) {
          convo.copyActivities = [];
        }
      }
      await chrome.storage.local.set({ [this.CONVERSATION_STORAGE_KEY]: conversations });
    } catch (error) {
      console.error('Error clearing activities:', error);
      throw error;
    }
  }

  /**
   * Save a conversation log to storage
   */
  static async upsertConversationTurns(
    threadId: string,
    threadInfo: Partial<ConversationLog> | undefined,
    turns: ConversationTurn[]
  ): Promise<void> {
    try {
      const data = await this.getAllConversations();
      let existing = data.find(c => c.id === threadId);

      if (!existing) {
        existing = {
          id: threadId,
          url: threadInfo?.url || '',
          // storage.ts is used from the MV3 service worker (no window). Use provided threadInfo only.
          domain: threadInfo?.domain || (threadInfo?.url ? new URL(threadInfo.url).hostname : ''),
          platform: threadInfo?.platform,
          createdAt: Date.now(),
          lastUpdatedAt: Date.now(),
          title: threadInfo?.title,
          turns: [],
          copyActivities: [],
          metadata: threadInfo?.metadata || {}
        } as ConversationLog;
        // Append new conversation at end; popup will display reversed
        data.push(existing);
      }

      // Append turns at end; keep existing ordering logic unchanged.
      // While appending, ensure each new turn has:
      // - a human-readable id including threadId
      // - category defaulted to 'pending'
      // - previousTurnId pointing to the last stored turn
      let previousTurnId: string | undefined = existing.turns.length
        ? existing.turns[existing.turns.length - 1].id
        : undefined;

      const existingIdSet = new Set(existing.turns.map(t => t.id));
      const makeTurnId = (ts: number, collisionIndex?: number) => {
        const base = `${threadId}::${ts}`;
        return typeof collisionIndex === 'number' ? `${base}::${collisionIndex}` : base;
      };

      const isNearDuplicateTurn = (candidateTurn: ConversationTurn): boolean => {
        const windowTurns = existing.turns.slice(-8);
        const p = this.normalizeTurnText(candidateTurn.prompt?.text || '');
        const r = this.normalizeTurnText(candidateTurn.response?.text || '');
        if (!p || !r) return false;

        for (const t of windowTurns) {
          const tp = this.normalizeTurnText(t.prompt?.text || '');
          const tr = this.normalizeTurnText(t.response?.text || '');
          if (!tp || !tr) continue;
          const dt = Math.abs((candidateTurn.ts || 0) - (t.ts || 0));
          if (dt <= 5000 && tp === p && tr === r) {
            return true;
          }
        }
        return false;
      };

      const findMergeableTurnIndex = (candidateTurn: ConversationTurn): number => {
        const candidatePrompt = this.normalizeTurnText(candidateTurn.prompt?.text || '');
        const candidateResponse = this.normalizeTurnText(candidateTurn.response?.text || '');
        if (!candidatePrompt || !candidateResponse) {
          return -1;
        }

        const start = Math.max(0, existing.turns.length - 8);
        for (let i = existing.turns.length - 1; i >= start; i--) {
          const t = existing.turns[i];
          const tp = this.normalizeTurnText(t.prompt?.text || '');
          const tr = this.normalizeTurnText(t.response?.text || '');
          if (!tp || !tr) {
            continue;
          }

          const dt = Math.abs((candidateTurn.ts || 0) - (t.ts || 0));
          if (dt > 90_000) {
            continue;
          }

          // Same prompt (or strong containment) and same evolving response body.
          const promptScore = this.containmentSimilarity(candidatePrompt, tp);
          const responseScore = this.containmentSimilarity(candidateResponse, tr);
          if (promptScore >= 0.9 && responseScore >= 0.8) {
            return i;
          }
        }

        return -1;
      };

      for (const turn of turns) {
        const mergeIdx = findMergeableTurnIndex(turn);
        if (mergeIdx !== -1) {
          const existingTurn = existing.turns[mergeIdx];

          // Keep stable id and chain, update payload with better/longer content.
          const oldPrompt = this.normalizeTurnText(existingTurn.prompt?.text || '');
          const newPrompt = this.normalizeTurnText(turn.prompt?.text || '');
          const oldResponse = this.normalizeTurnText(existingTurn.response?.text || '');
          const newResponse = this.normalizeTurnText(turn.response?.text || '');

          const preferNewPrompt = newPrompt.length > oldPrompt.length;
          const preferNewResponse = newResponse.length > oldResponse.length;

          existing.turns[mergeIdx] = {
            ...existingTurn,
            ts: Math.max(existingTurn.ts || 0, turn.ts || 0),
            responseTimeMs: turn.responseTimeMs ?? existingTurn.responseTimeMs,
            prompt: preferNewPrompt ? turn.prompt : existingTurn.prompt,
            response: preferNewResponse ? turn.response : existingTurn.response,
            // Preserve resolved category/summary when already available.
            category: existingTurn.category && existingTurn.category !== 'pending'
              ? existingTurn.category
              : turn.category || existingTurn.category,
            summary: existingTurn.summary && existingTurn.summary !== 'pending'
              ? existingTurn.summary
              : turn.summary || existingTurn.summary
          };
          continue;
        }

        // Prevent duplicate turns caused by multiple DOM nodes matching the same response.
        // Only dedupe when prompt+response are identical and timestamps are close.
        if (isNearDuplicateTurn(turn)) {
          continue;
        }

        if (!turn.category) {
          turn.category = 'pending';
        }
        if (!turn.summary) {
          turn.summary = 'pending';
        }

        // Assign/normalize id only for newly added turns.
        let candidate = turn.id && turn.id.startsWith(`${threadId}::`) ? turn.id : makeTurnId(turn.ts);
        if (existingIdSet.has(candidate)) {
          let c = 1;
          while (existingIdSet.has(makeTurnId(turn.ts, c))) c++;
          candidate = makeTurnId(turn.ts, c);
        }
        turn.id = candidate;
        existingIdSet.add(candidate);

        turn.previousTurnId = previousTurnId;
        previousTurnId = turn.id;

        existing.turns.push(turn);
      }
      existing.lastUpdatedAt = Date.now();
      if (threadInfo?.url) existing.url = threadInfo.url;
      if (threadInfo?.title) existing.title = threadInfo.title;
      if (threadInfo?.platform) existing.platform = threadInfo.platform;
      if (threadInfo?.metadata) existing.metadata = { ...(existing.metadata || {}), ...threadInfo.metadata };

      // Trim stored conversations count (keep newest at end by removing from start if over)
      if (data.length > this.MAX_CONVERSATIONS) {
        data.splice(0, data.length - this.MAX_CONVERSATIONS);
      }

      await chrome.storage.local.set({
        [this.CONVERSATION_STORAGE_KEY]: data
      });
    } catch (error) {
      console.error('Error upserting conversation turns:', error);
      throw error;
    }
  }

  /**
   * Get all conversation logs
   */
  static async getAllConversations(): Promise<ConversationLog[]> {
    try {
      const result = await chrome.storage.local.get(this.CONVERSATION_STORAGE_KEY);
      return result[this.CONVERSATION_STORAGE_KEY] || [];
    } catch (error) {
      console.error('Error getting conversations:', error);
      return [];
    }
  }

  static async attachCopyToConversation(conversationId: string | undefined, activity: CopyActivity): Promise<void> {
    try {
      const data = await this.getAllConversations();
      const resolvedConversationId = conversationId || this.deriveThreadIdFromUrl(activity.url, activity.domain);
      let existing = data.find(c => c.id === resolvedConversationId);
      if (!existing) {
        const now = Date.now();
        existing = {
          id: resolvedConversationId,
          url: activity.url,
          domain: activity.domain,
          createdAt: now,
          lastUpdatedAt: now,
          turns: [],
          copyActivities: [],
          metadata: {}
        };
        data.push(existing);
      }
      if (!existing.copyActivities) existing.copyActivities = [];
      if (existing.copyActivities.some((a) => a.id === activity.id)) {
        return;
      }
      // Append copy activity at end
      existing.copyActivities.push({
        ...activity,
        conversationId: resolvedConversationId
      });
      existing.lastUpdatedAt = Date.now();

      this.pruneGlobalActivities(data);
      this.trimConversations(data);

      await chrome.storage.local.set({ [this.CONVERSATION_STORAGE_KEY]: data });
    } catch (error) {
      console.error('Error attaching copy to conversation:', error);
    }
  }

  static async getConversationById(conversationId: string): Promise<ConversationLog | undefined> {
    const conversations = await this.getAllConversations();
    return conversations.find(c => c.id === conversationId);
  }

  static async patchCopyActivityById(activityId: string, patch: Partial<CopyActivity>): Promise<void> {
    if (!activityId) {
      return;
    }

    const conversations = await this.getAllConversations();
    let updated = false;
    for (const convo of conversations) {
      if (!convo.copyActivities || convo.copyActivities.length === 0) {
        continue;
      }
      const cidx = convo.copyActivities.findIndex(a => a.id === activityId);
      if (cidx !== -1) {
        convo.copyActivities[cidx] = { ...convo.copyActivities[cidx], ...patch };
        convo.lastUpdatedAt = Date.now();
        updated = true;
      }
    }

    if (updated) {
      await chrome.storage.local.set({ [this.CONVERSATION_STORAGE_KEY]: conversations });
    }
  }

  static async updateCopyCategoriesForTurn(turnId: string, copyCategory: string): Promise<void> {
    if (!turnId || !copyCategory) {
      return;
    }

    const patch: Partial<CopyActivity> = {
      copyCategory,
      copyCategorySource: 'turn'
    };

    const conversations = await this.getAllConversations();
    let convoUpdated = false;
    for (const convo of conversations) {
      if (!convo.copyActivities || convo.copyActivities.length === 0) continue;
      let thisConvoUpdated = false;
      for (let i = 0; i < convo.copyActivities.length; i++) {
        const a = convo.copyActivities[i];
        if (a.turnId === turnId && a.copyCategorySource === 'turn') {
          convo.copyActivities[i] = { ...a, ...patch };
          convoUpdated = true;
          thisConvoUpdated = true;
        }
      }
      if (thisConvoUpdated) {
        convo.lastUpdatedAt = Date.now();
      }
    }
    if (convoUpdated) {
      await chrome.storage.local.set({ [this.CONVERSATION_STORAGE_KEY]: conversations });
    }
  }

  /**
   * Get recent conversations with limit
   */
  static async getRecentConversations(limit: number = 50): Promise<ConversationLog[]> {
    const conversations = await this.getAllConversations();
    return conversations.slice(0, limit);
  }

  // Deprecated: session-based retrieval removed in per-thread model

  /**
   * Clear all conversation logs
   */
  static async clearAllConversations(): Promise<void> {
    try {
      await chrome.storage.local.remove(this.CONVERSATION_STORAGE_KEY);
    } catch (error) {
      console.error('Error clearing conversations:', error);
      throw error;
    }
  }

  /**
   * Save a nudge event.
   */
  static async saveNudgeEvent(event: NudgeEvent): Promise<void> {
    try {
      const events = await this.getAllNudgeEvents();
      if (events.some((e) => e.id === event.id)) {
        return;
      }

      events.push(event);
      events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      this.trimNudgeEvents(events);

      await chrome.storage.local.set({ [this.NUDGE_EVENTS_STORAGE_KEY]: events });
    } catch (error) {
      console.error('Error saving nudge event:', error);
      throw error;
    }
  }

  /**
   * Get all stored nudge events.
   */
  static async getAllNudgeEvents(): Promise<NudgeEvent[]> {
    try {
      const result = await chrome.storage.local.get(this.NUDGE_EVENTS_STORAGE_KEY);
      const events = (result[this.NUDGE_EVENTS_STORAGE_KEY] as NudgeEvent[] | undefined) || [];
      return events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    } catch (error) {
      console.error('Error getting nudge events:', error);
      return [];
    }
  }

  /**
   * After a successful sync, keep only a small rolling local history.
   * This limits chrome.storage growth while preserving recent context.
   */
  static async compactAfterSuccessfulSync(): Promise<void> {
    try {
      const conversations = await this.getAllConversations();
      const events = await this.getAllNudgeEvents();

      const keepConversationIds = new Set(
        [...conversations]
          .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0))
          .slice(0, this.MAX_LOCAL_CONVERSATIONS_AFTER_SYNC)
          .map((c) => c.id)
      );

      const compactedConversations = conversations
        .filter((c) => keepConversationIds.has(c.id))
        .map((c) => {
          const copyActivities = [...(c.copyActivities || [])]
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, this.MAX_LOCAL_COPY_ACTIVITIES_PER_CONVERSATION_AFTER_SYNC)
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

          return {
            ...c,
            copyActivities
          };
        });

      const compactedEvents = [...events]
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, this.MAX_LOCAL_NUDGE_EVENTS_AFTER_SYNC)
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      await chrome.storage.local.set({
        [this.CONVERSATION_STORAGE_KEY]: compactedConversations,
        [this.NUDGE_EVENTS_STORAGE_KEY]: compactedEvents
      });
    } catch (error) {
      console.error('Error compacting post-sync data:', error);
      throw error;
    }
  }

  /**
   * Aggregate stats computed directly from nudge events.
   */
  static async getNudgeAggregateStats(): Promise<NudgeAggregateStats> {
    const events = await this.getAllNudgeEvents();
    const totalShown = events.length;
    const skipped = events.filter((e) => e.response === 'skip').length;
    const answered = totalShown - skipped;

    const triggerTypes: NudgeTriggerType[] = ['copy', 'response'];
    const dismissRateByQuestionType = triggerTypes.reduce<Record<NudgeTriggerType, number>>((acc, type) => {
      const shownForType = events.filter((e) => e.triggerType === type).length;
      const skippedForType = events.filter((e) => e.triggerType === type && e.response === 'skip').length;
      acc[type] = shownForType > 0 ? skippedForType / shownForType : 0;
      return acc;
    }, {
      copy: 0,
      response: 0
    });

    return {
      totalShown,
      answered,
      skipped,
      dismissRateByQuestionType
    };
  }

  /**
   * Get storage statistics for analysis
   */
  static async getStorageStats(): Promise<{
    totalCopies: number;
    totalConversations: number;
    totalPromptLength: number;
    totalResponseLength: number;
    averageResponseTime: number;
    domainBreakdown: Record<string, number>;
  }> {
    const conversations = await this.getAllConversations();
    const copies = await this.getAllActivities();

    let totalPromptLength = 0;
    let totalResponseLength = 0;
    let totalResponseTime = 0;
    let responseCount = 0;

    conversations.forEach((c) => {
      c.turns.forEach((t) => {
        totalPromptLength += t.prompt.textLength;
        totalResponseLength += t.response.textLength;
        if (t.responseTimeMs !== undefined && t.responseTimeMs > 0) {
          totalResponseTime += t.responseTimeMs;
          responseCount++;
        }
      });
    });

    const averageResponseTime = responseCount > 0 
      ? Math.round(totalResponseTime / responseCount) 
      : 0;

    const domainBreakdown: Record<string, number> = {};
    conversations.forEach(c => {
      domainBreakdown[c.domain] = (domainBreakdown[c.domain] || 0) + 1;
    });

    return {
      totalCopies: copies.length,
      totalConversations: conversations.length,
      totalPromptLength,
      totalResponseLength,
      averageResponseTime,
      domainBreakdown
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Sync / participant config helpers                                  */
  /* ------------------------------------------------------------------ */

  private static readonly PARTICIPANT_UUID_KEY = 'participantUuid';
  private static readonly LAST_SYNC_AT_KEY = 'lastSyncAt';
  private static readonly SYNC_STATUS_KEY = 'syncStatus';

  static async getParticipantUuid(): Promise<string | undefined> {
    const result = await chrome.storage.local.get(this.PARTICIPANT_UUID_KEY);
    return result[this.PARTICIPANT_UUID_KEY] as string | undefined;
  }

  static async setParticipantUuid(uuid: string): Promise<void> {
    await chrome.storage.local.set({ [this.PARTICIPANT_UUID_KEY]: uuid });
  }

  static async getLastSyncAt(): Promise<number | undefined> {
    const result = await chrome.storage.local.get(this.LAST_SYNC_AT_KEY);
    return result[this.LAST_SYNC_AT_KEY] as number | undefined;
  }

  static async setLastSyncAt(ts: number): Promise<void> {
    await chrome.storage.local.set({ [this.LAST_SYNC_AT_KEY]: ts });
  }

  static async getSyncStatus(): Promise<SyncStatus> {
    const result = await chrome.storage.local.get(this.SYNC_STATUS_KEY);
    return (result[this.SYNC_STATUS_KEY] as SyncStatus) || 'idle';
  }

  static async setSyncStatus(status: SyncStatus): Promise<void> {
    await chrome.storage.local.set({ [this.SYNC_STATUS_KEY]: status });
  }
}
