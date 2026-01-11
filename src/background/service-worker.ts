import { StorageManager } from '../utils/storage';
import type {
  MessagePayload,
  MessageResponse,
  CopyActivity,
  ConversationLog,
  ConversationTurn,
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
      return handleConversationEvent(message.data as any);
    case 'UPSERT_CONVERSATION_TURNS':
      return handleUpsertConversationTurns(message.data as {
        threadId: string;
        threadInfo?: Partial<ConversationLog>;
        turns: ConversationTurn[];
      });
    
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
    // Also attach to conversation if provided
    await StorageManager.attachCopyToConversation(activity.conversationId, activity);
    console.log('[TrustButVerify] Copy activity saved:', {
      domain: activity.domain,
      length: activity.textLength,
      trigger: activity.trigger?.method || activity.trigger?.type,
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
async function handleConversationEvent(conversation: any): Promise<MessageResponse> {
  try {
    // Backward compatibility: if an old-style conversation arrives, convert to turns
    if (conversation && conversation.userPrompt && conversation.llmResponse) {
      const threadId = deriveThreadIdFromUrl(conversation.url, conversation.domain);
      const promptTs = conversation.timestamp - (conversation.responseTime || 0);
      const responseTs = conversation.timestamp;
      const turns: ConversationTurn[] = [
        {
          id: `${responseTs}-turn`,
          ts: responseTs,
          responseTimeMs: conversation.responseTime || undefined,
          prompt: {
            text: conversation.userPrompt,
            textLength: conversation.userPrompt.length,
            ts: promptTs
          },
          response: {
            text: conversation.llmResponse,
            textLength: conversation.llmResponse.length,
            ts: responseTs
          }
        }
      ];

      await StorageManager.upsertConversationTurns(threadId, {
        id: threadId,
        url: conversation.url,
        domain: conversation.domain,
        title: conversation.metadata?.conversationTitle,
        metadata: { messageCount: conversation.metadata?.messageCount }
      }, turns);

      console.log('[TrustButVerify] Conversation upserted (legacy payload):', {
        domain: conversation.domain,
        turns: turns.length
      });
      return { success: true };
    }

    // If new format accidentally sent here, try to upsert
    if (conversation && conversation.id && Array.isArray(conversation.turns)) {
      await StorageManager.upsertConversationTurns(conversation.id, conversation, conversation.turns);
      return { success: true };
    }

    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error saving conversation:', error);
    throw error;
  }
}

async function handleUpsertConversationTurns(payload: {
  threadId: string;
  threadInfo?: Partial<ConversationLog>;
  turns: ConversationTurn[];
}): Promise<MessageResponse> {
  try {
    await StorageManager.upsertConversationTurns(payload.threadId, payload.threadInfo, payload.turns);
    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error upserting turns:', error);
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

      const haystack = conversation.turns
        .map(t => `${t.prompt.text}\n${t.response.text}`.toLowerCase())
        .join('\n');
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

function deriveThreadIdFromUrl(url: string, domain: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname;

    // ChatGPT
    const chatgpt = path.match(/\/c\/([^/?#]+)/);
    if (chatgpt) return `${domain}::${chatgpt[1]}`;

    // Gemini
    const gemApp = path.match(/\/app\/([^/?#]+)/);
    if (gemApp) return `${domain}::${gemApp[1]}`;

    // Grok
    const grokC = path.match(/\/c\/([^/?#]+)/);
    if (grokC) return `${domain}::${grokC[1]}`;

    // Fallback: hash origin+path
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
