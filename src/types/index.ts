/**
 * Type definitions for TrustButVerify extension
 */

export interface CopyActivity {
  id: string;
  timestamp: number;
  url: string;
  domain: string;
  copiedText: string;
  textLength: number;
  selectionContext?: string;
}

export interface ConversationLog {
  id: string;
  timestamp: number;
  url: string;
  domain: string;
  sessionId: string;
  userPrompt: string;
  llmResponse: string;
  promptLength: number;
  responseLength: number;
  responseTime?: number; // milliseconds between prompt and response
  metadata?: {
    model?: string;
    conversationTitle?: string;
    messageCount?: number;
    promptTokens?: number;
    responseTokens?: number;
  };
}

export interface StorageData {
  activities: CopyActivity[];
  conversations: ConversationLog[];
}

export interface AnalyticsSummary {
  totalCopies: number;
  totalConversations: number;
  totalPromptLength: number;
  totalResponseLength: number;
  averageResponseTime: number;
  domainBreakdown: Record<string, number>;
}

export interface GetConversationsParams {
  limit?: number;
  domain?: string;
  search?: string;
}

export interface MessagePayload {
  type:
    | 'COPY_EVENT'
    | 'GET_ACTIVITIES'
    | 'CLEAR_ACTIVITIES'
    | 'CONVERSATION_EVENT'
    | 'GET_CONVERSATIONS'
    | 'CLEAR_CONVERSATIONS'
    | 'GET_ANALYTICS';
  data?:
    | CopyActivity
    | ConversationLog
    | { limit?: number }
    | GetConversationsParams;
}

export interface MessageResponse {
  success: boolean;
  data?:
    | CopyActivity[]
    | ConversationLog[]
    | { count: number }
    | AnalyticsSummary;
  error?: string;
}

export type SupportedDomain = 
  | 'chat.openai.com'
  | 'chatgpt.com'
  | 'deepseek.com'
  | 'chat.deepseek.com'
  | 'www.deepseek.com'
  | 'x.ai'
  | 'grok.com'
  | 'claude.ai'
  | 'gemini.google.com';
