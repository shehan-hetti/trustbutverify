/**
 * Type definitions for TrustButVerify extension
 */

export interface CopyActivityTrigger {
  type: 'selection' | 'programmatic';
  method?: string;
  elementTag?: string;
  elementClasses?: string;
  elementRole?: string;
  elementAriaLabel?: string;
  dataTestId?: string;
  elementTextPreview?: string;
}

export interface CopyActivity {
  id: string;
  timestamp: number;
  url: string;
  domain: string;
  conversationId?: string;
  copiedText: string;
  textLength: number;
  selectionContext?: string;
  trigger?: CopyActivityTrigger;
}

export interface ConversationTurn {
  id: string;
  ts: number; // timestamp of assistant finish
  responseTimeMs?: number; // delta from prompt submit to assistant finish
  prompt: {
    text: string;
    textLength: number;
    ts: number; // prompt submit time
    messageId?: string;
    meta?: Record<string, unknown>;
  };
  response: {
    text: string;
    textLength: number;
    ts: number; // assistant message time
    messageId?: string;
    meta?: Record<string, unknown>;
  };
}

export interface ConversationLog {
  id: string; // stable conversation/thread id
  url: string;
  domain: string;
  platform?: string;
  createdAt: number;
  lastUpdatedAt: number;
  title?: string;
  turns: ConversationTurn[];
  copyActivities?: CopyActivity[];
  metadata?: {
    model?: string;
    messageCount?: number;
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
    | 'UPSERT_CONVERSATION_TURNS'
    | 'GET_CONVERSATIONS'
    | 'CLEAR_CONVERSATIONS'
    | 'GET_ANALYTICS';
  data?:
    | CopyActivity
    | ConversationLog
    | { limit?: number }
    | GetConversationsParams
    | {
        threadId: string;
        threadInfo?: Partial<ConversationLog>;
        turns: ConversationTurn[];
      };
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
