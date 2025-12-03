import type { CopyActivity, ConversationLog, StorageData } from '../types';

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
      data.unshift(activity);
      
      // Keep only the most recent activities
      if (data.length > this.MAX_ACTIVITIES) {
        data.length = this.MAX_ACTIVITIES;
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
    return activities.slice(0, limit);
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
  static async saveConversation(conversation: ConversationLog): Promise<void> {
    try {
      const data = await this.getAllConversations();
      data.unshift(conversation);
      
      // Keep only the most recent conversations
      if (data.length > this.MAX_CONVERSATIONS) {
        data.length = this.MAX_CONVERSATIONS;
      }

      await chrome.storage.local.set({
        [this.CONVERSATION_STORAGE_KEY]: data
      });
    } catch (error) {
      console.error('Error saving conversation:', error);
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

  /**
   * Get recent conversations with limit
   */
  static async getRecentConversations(limit: number = 50): Promise<ConversationLog[]> {
    const conversations = await this.getAllConversations();
    return conversations.slice(0, limit);
  }

  /**
   * Get conversations by session ID
   */
  static async getConversationsBySession(sessionId: string): Promise<ConversationLog[]> {
    const conversations = await this.getAllConversations();
    return conversations.filter(conv => conv.sessionId === sessionId);
  }

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

    const totalPromptLength = conversations.reduce((sum, c) => sum + c.promptLength, 0);
    const totalResponseLength = conversations.reduce((sum, c) => sum + c.responseLength, 0);
    const responseTimes = conversations.filter(c => c.responseTime).map(c => c.responseTime!);
    const averageResponseTime = responseTimes.length > 0 
      ? responseTimes.reduce((sum, t) => sum + t, 0) / responseTimes.length 
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
