import type { CopyActivity, ConversationLog, ConversationTurn } from '../types';

/**
 * Storage utility for managing copy activities and conversation logs
 */
export class StorageManager {
  private static readonly COPY_STORAGE_KEY = 'copyActivities';
  private static readonly CONVERSATION_STORAGE_KEY = 'conversationLogs';
  private static readonly MAX_ACTIVITIES = 1000;
  private static readonly MAX_CONVERSATIONS = 500;

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

  /**
   * Save a copy activity to storage
   */
  static async saveActivity(activity: CopyActivity): Promise<void> {
    try {
      const data = await this.getAllActivities();
      // Append new activity at the end to keep chronological order
      data.push(activity);
      
      // Keep only the most recent activities
      if (data.length > this.MAX_ACTIVITIES) {
        // Remove oldest from the start, keep latest MAX_ACTIVITIES at the end
        const excess = data.length - this.MAX_ACTIVITIES;
        data.splice(0, excess);
      }

      await chrome.storage.local.set({
        [this.COPY_STORAGE_KEY]: data
      });
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
      const result = await chrome.storage.local.get(this.COPY_STORAGE_KEY);
      return result[this.COPY_STORAGE_KEY] || [];
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
      await chrome.storage.local.remove(this.COPY_STORAGE_KEY);
    } catch (error) {
      console.error('Error clearing activities:', error);
      throw error;
    }
  }

  /**
   * Get activities count
   */
  static async getActivitiesCount(): Promise<number> {
    const activities = await this.getAllActivities();
    return activities.length;
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
    if (!conversationId) {
      return;
    }
    try {
      const data = await this.getAllConversations();
      const existing = data.find(c => c.id === conversationId);
      if (!existing) {
        return;
      }
      if (!existing.copyActivities) existing.copyActivities = [];
      // Append copy activity at end
      existing.copyActivities.push(activity);
      existing.lastUpdatedAt = Date.now();
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

    const activities = await this.getAllActivities();
    const idx = activities.findIndex(a => a.id === activityId);
    if (idx !== -1) {
      activities[idx] = { ...activities[idx], ...patch };
      await chrome.storage.local.set({ [this.COPY_STORAGE_KEY]: activities });
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

    const activities = await this.getAllActivities();
    let activityUpdated = false;
    for (let i = 0; i < activities.length; i++) {
      const a = activities[i];
      if (a.turnId === turnId && a.copyCategorySource === 'turn') {
        activities[i] = { ...a, ...patch };
        activityUpdated = true;
      }
    }
    if (activityUpdated) {
      await chrome.storage.local.set({ [this.COPY_STORAGE_KEY]: activities });
    }

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
   * Get conversation count
   */
  static async getConversationsCount(): Promise<number> {
    const conversations = await this.getAllConversations();
    return conversations.length;
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
}
