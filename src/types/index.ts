/**
 * Type definitions for TrustButVerify extension
 */

/* ------------------------------------------------------------------ */
/*  Text readability / complexity metrics                             */
/* ------------------------------------------------------------------ */

/**
 * Raw readability scores produced by text-readability-ts.
 * Every value is the direct output of the library function –
 * no rounding or clamping is applied at storage time.
 */
export interface TextReadabilityMetrics {
  /** Schema version – bump when adding / removing fields. */
  version: 1;
  /** Length (chars) of the text sample fed to the library. */
  sampleTextLength: number;
  /** Number of sentences detected. */
  sentenceCount: number;
  /** Number of words detected. */
  wordCount: number;

  /* — Grade-level / index scores — */
  fleschReadingEase: number;       // 0-100+  (higher = easier)
  fleschKincaidGrade: number;      // US grade level
  smogIndex: number;               // US grade level
  colemanLiauIndex: number;        // US grade level
  automatedReadabilityIndex: number; // US grade level
  gunningFog: number;              // US grade level
  daleChallReadabilityScore: number; // raw Dale-Chall score
  lix: number;                     // Läsbarhetsindex
  rix: number;                     // Anderson's Rix

  /* — Consensus helpers — */
  /** text_standard() string, e.g. "9th and 10th grade". */
  textStandard?: string;
  /** text_median() single grade number. */
  textMedian?: number;
}

/**
 * Derived complexity band computed from the raw metrics.
 *
 * Grade consensus = textMedian (most reliable single number).
 * Bands:
 *   very-easy   ≤ 4
 *   easy         5 – 7
 *   moderate     8 – 10
 *   hard        11 – 13
 *   very-hard   ≥ 14
 */
export type ComplexityBand =
  | 'very-easy'
  | 'easy'
  | 'moderate'
  | 'hard'
  | 'very-hard';

export interface TextComplexitySummary {
  /** Consensus grade level (from textMedian). */
  gradeConsensus: number;
  /** Human-friendly complexity band. */
  complexityBand: ComplexityBand;
  /**
   * Optional reason codes explaining band assignment, e.g.
   * ['high-fog', 'low-flesch-ease'].
   */
  reasonCodes?: string[];
}

/* ------------------------------------------------------------------ */

export interface CopyActivityTrigger {
  type: 'selection' | 'programmatic';
  method?: string;
  expanded?: boolean;
  extractionStrategy?: string;
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
  /**
   * Resolved side of the conversation turn that the copy belongs to.
   * Omitted when not confidently determinable (no 'unknown' persisted).
   */
  turnSide?: 'prompt' | 'response';
  /**
   * Full extracted container text (typically the full message wrapper).
   * May be capped for storage; see containerTextLength for original length.
   */
  containerText?: string;
  /**
   * Original (uncapped) length of containerText.
   */
  containerTextLength?: number;
  /**
   * When turnSide is 'response', the paired prompt text captured at copy time.
   */
  pairedPromptText?: string;
  /**
   * Links this copy event to a stored ConversationTurn id.
   */
  turnId?: string;
  /**
   * Categorization label for this copy event.
   */
  copyCategory?: string;
  /**
   * Where copyCategory came from.
   */
  copyCategorySource?: 'turn' | 'llm';
  /**
   * Readability metrics computed on the copied text (response-side only).
   */
  readability?: TextReadabilityMetrics;
  /**
   * Derived complexity summary for the copied text.
   */
  complexity?: TextComplexitySummary;
  selectionContext?: string;
  trigger?: CopyActivityTrigger;
}

export interface ConversationTurn {
  id: string;
  ts: number; // timestamp of assistant finish
  responseTimeMs?: number; // delta from prompt submit to assistant finish
  /**
   * Turn-level category produced by LLM-2.
   * Stored as the full pipe-separated label string returned by the model.
   */
  category?: string;
  /**
   * Turn-level summary produced by LLM-2.
   * Stored as the full summary line value returned by the model.
   */
  summary?: string;
  /**
   * Link to the previous turn id in this conversation.
   */
  previousTurnId?: string;
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
    /**
     * Readability metrics for the full assistant response text.
     */
    readability?: TextReadabilityMetrics;
    /**
     * Derived complexity summary for the assistant response.
     */
    complexity?: TextComplexitySummary;
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

/* ------------------------------------------------------------------ */
/*  Nudge system types                                                 */
/* ------------------------------------------------------------------ */

export type NudgeTriggerType = 'copy' | 'response';

export type NudgeAnswerMode =
  | 'yes_no_skip'
  | 'yes_partly_no_skip'
  | 'rating_1_10_skip';

export type NudgeNumericRating = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * Stored in a single `response` field.
 * - Binary / ternary nudges use yes/no/partly/skip
 * - Rating nudges store 1..10 directly here (no separate responseValue)
 */
export type NudgeResponseValue =
  | 'yes'
  | 'no'
  | 'partly'
  | 'skip'
  | NudgeNumericRating;

export interface NudgeQuestion {
  id: string;
  text: string;
  triggerType: NudgeTriggerType;
  answerMode: NudgeAnswerMode;
  active: boolean;
  tags?: string[];
  /** Low/high scale labels for rating questions, e.g. { low: 'not confident', high: 'very confident' } */
  ratingLabels?: { low: string; high: string };
  /** Custom label for the "Yes" answer button, e.g. 'Yes (I am editing it)' */
  yesLabel?: string;
}

export interface NudgeEvent {
  id: string;
  timestamp: number;
  conversationId: string;
  turnId?: string;
  copyActivityId?: string;
  domain: string;
  platform?: string;
  triggerType: NudgeTriggerType;
  nudgeQuestionId: string;
  nudgeQuestionText: string;
  response: NudgeResponseValue;
  responseTimeMs: number;
  dismissedBy: 'answer' | 'skip' | 'close' | 'timeout' | 'replaced';
}

export interface NudgeAggregateStats {
  totalShown: number;
  answered: number;
  skipped: number;
  dismissRateByQuestionType: Record<NudgeTriggerType, number>;
}

/* ------------------------------------------------------------------ */
/*  Backend sync types                                                 */
/* ------------------------------------------------------------------ */

export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

export interface SyncResult {
  success: boolean;
  newConversations: number;
  updatedConversations: number;
  newTurns: number;
  newCopyActivities: number;
  newNudgeEvents: number;
  syncedAt: number;
  error?: string;
}

export interface VerifyParticipantResult {
  valid: boolean;
  error?: string;
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
    | 'GET_ANALYTICS'
    | 'SAVE_NUDGE_EVENT'
    | 'GET_NUDGE_STATS'
    | 'VERIFY_PARTICIPANT'
    | 'TRIGGER_SYNC'
    | 'GET_SYNC_STATUS';
  data?:
    | CopyActivity
    | ConversationLog
    | { limit?: number }
    | GetConversationsParams
    | NudgeEvent
    | {
        threadId: string;
        threadInfo?: Partial<ConversationLog>;
        turns: ConversationTurn[];
      }
    | { uuid: string };
}

export interface MessageResponse {
  success: boolean;
  data?:
    | CopyActivity[]
    | ConversationLog[]
    | { count: number }
    | AnalyticsSummary
    | NudgeAggregateStats
    | SyncResult
    | VerifyParticipantResult
    | { participantUuid?: string; lastSyncAt?: number; syncStatus: SyncStatus };
  error?: string;
}
