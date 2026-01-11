import type { CopyActivity, ConversationLog, ConversationTurn } from '../types';

/**
 * Storage utility for managing copy activities and conversation logs
 */
export class StorageManager {
  private static readonly COPY_STORAGE_KEY = 'copyActivities';
  private static readonly CONVERSATION_STORAGE_KEY = 'conversationLogs';
  private static readonly MAX_ACTIVITIES = 1000;
  private static readonly MAX_CONVERSATIONS = 500;

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
          domain: threadInfo?.domain || (new URL(threadInfo?.url || window.location.href)).hostname,
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

      // Append turns at end
      existing.turns.push(...turns);
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
    conversations.forEach((c) => {
      c.turns.forEach((t) => {
        totalPromptLength += t.prompt.textLength;
        totalResponseLength += t.response.textLength;
      });
    });

    // Response time is not directly tracked per turn; set to 0 for now
    const averageResponseTime = 0;

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
