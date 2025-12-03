import { StorageManager } from '../utils/storage';
import type {
  MessagePayload,
  MessageResponse,
  CopyActivity,
  ConversationLog,
  GetConversationsParams
} from '../types';

/**
 * Background service worker for TrustButVerify extension
 */
console.log('[TrustButVerify] Service worker started');

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener(
  (message: MessagePayload, sender, sendResponse: (response: MessageResponse) => void) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error('[TrustButVerify] Error handling message:', error);
        sendResponse({
          success: false,
          error: error.message
        });
      });
    
    // Return true to indicate async response
    return true;
  }
);

/**
 * Handle incoming messages
 */
async function handleMessage(
  message: MessagePayload,
  sender: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  switch (message.type) {
    case 'COPY_EVENT':
      return handleCopyEvent(message.data as CopyActivity);
    
    case 'GET_ACTIVITIES':
      return handleGetActivities((message.data as { limit?: number })?.limit);
    
    case 'CLEAR_ACTIVITIES':
      return handleClearActivities();
    
    case 'CONVERSATION_EVENT':
      return handleConversationEvent(message.data as ConversationLog);
    
    case 'GET_CONVERSATIONS':
      return handleGetConversations(message.data as GetConversationsParams | undefined);
    
    case 'CLEAR_CONVERSATIONS':
      return handleClearConversations();

    case 'GET_ANALYTICS':
      return handleGetAnalytics();
    
    default:
      return {
        success: false,
        error: 'Unknown message type'
      };
  }
}

/**
 * Handle copy event from content script
 */
async function handleCopyEvent(activity: CopyActivity): Promise<MessageResponse> {
  try {
    await StorageManager.saveActivity(activity);
    console.log('[TrustButVerify] Copy activity saved:', {
      domain: activity.domain,
      length: activity.textLength,
      timestamp: new Date(activity.timestamp).toISOString()
    });
    
    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error saving activity:', error);
    throw error;
  }
}

/**
 * Handle get activities request
 */
async function handleGetActivities(limit?: number): Promise<MessageResponse> {
  try {
    const activities = limit 
      ? await StorageManager.getRecentActivities(limit)
      : await StorageManager.getAllActivities();
    
    return {
      success: true,
      data: activities
    };
  } catch (error) {
    console.error('[TrustButVerify] Error getting activities:', error);
    throw error;
  }
}

/**
 * Handle clear activities request
 */
async function handleClearActivities(): Promise<MessageResponse> {
  try {
    await StorageManager.clearAllActivities();
    console.log('[TrustButVerify] All activities cleared');
    
    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error clearing activities:', error);
    throw error;
  }
}

/**
 * Handle conversation event from content script
 */
async function handleConversationEvent(conversation: ConversationLog): Promise<MessageResponse> {
  try {
    await StorageManager.saveConversation(conversation);
    console.log('[TrustButVerify] Conversation saved:', {
      domain: conversation.domain,
      promptLength: conversation.promptLength,
      responseLength: conversation.responseLength,
      responseTime: conversation.responseTime,
      timestamp: new Date(conversation.timestamp).toISOString()
    });
    
    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error saving conversation:', error);
    throw error;
  }
}

/**
 * Handle get conversations request
 */
async function handleGetConversations(params?: GetConversationsParams): Promise<MessageResponse> {
  try {
    const limit = params?.limit;
    const domainFilter = params?.domain?.trim();
    const searchTerm = params?.search?.trim()?.toLowerCase();

    const conversations = limit
      ? await StorageManager.getRecentConversations(limit)
      : await StorageManager.getAllConversations();

    const filtered = conversations.filter((conversation) => {
      const matchesDomain = domainFilter ? conversation.domain === domainFilter : true;

      if (!searchTerm) {
        return matchesDomain;
      }

      const haystack = `${conversation.userPrompt}\n${conversation.llmResponse}`.toLowerCase();
      return matchesDomain && haystack.includes(searchTerm);
    });
    
    return {
      success: true,
      data: filtered
    };
  } catch (error) {
    console.error('[TrustButVerify] Error getting conversations:', error);
    throw error;
  }
}

/**
 * Handle analytics request
 */
async function handleGetAnalytics(): Promise<MessageResponse> {
  try {
    const stats = await StorageManager.getStorageStats();
    return {
      success: true,
      data: stats
    };
  } catch (error) {
    console.error('[TrustButVerify] Error getting analytics:', error);
    throw error;
  }
}

/**
 * Handle clear conversations request
 */
async function handleClearConversations(): Promise<MessageResponse> {
  try {
    await StorageManager.clearAllConversations();
    console.log('[TrustButVerify] All conversations cleared');
    
    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error clearing conversations:', error);
    throw error;
  }
}

// Extension installed/updated
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[TrustButVerify] Extension installed/updated:', details.reason);
});
