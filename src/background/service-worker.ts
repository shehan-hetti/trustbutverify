import { StorageManager } from '../utils/storage';
import { computeReadability } from '../utils/readability-metrics';
import { getActiveNudgeQuestions } from '../nudges/nudge-questions';
import { verifyParticipant as apiVerifyParticipant, syncData as apiSyncData } from '../utils/backend-api';
import { evaluateSyncNeed } from './sync-policy';
import type {
  MessagePayload,
  MessageResponse,
  CopyActivity,
  ConversationLog,
  ConversationTurn,
  GetConversationsParams,
  SyncResult
} from '../types';

/**
 * Background service worker for TrustButVerify extension
 */
console.log('[TrustButVerify] Service worker started');
const FLOW_TRACE_ENABLED = true;

function flowTrace(event: string, detail?: Record<string, unknown>): void {
  if (!FLOW_TRACE_ENABLED) {
    return;
  }
  if (detail) {
    console.log('[TBV FLOW][Worker]', event, detail);
    return;
  }
  console.log('[TBV FLOW][Worker]', event);
}

// LLM-2 (CSC cloud) categorization settings (hardcoded per requirement)
const LLM2_URL = 'http://86.50.252.163/completion';
const LLM2_USER = 'llmuser';
const LLM2_PASS = 'Test@123';

const categorizationInFlightByThreadId = new Map<string, Promise<void>>();
const copyCategorizationInFlightByActivityId = new Map<string, Promise<void>>();

const COPY_CATEGORIZATION_QUEUE_KEY = 'pendingCopyCategorizationQueue';
const COPY_CATEGORIZATION_ALARM = 'tbv:categorize-pending-copies';
const COPY_CATEGORIZATION_DELAY_MS = 8_000;
const COPY_CATEGORIZATION_BATCH_LIMIT = 3;
const COPY_CATEGORIZATION_MAX_ATTEMPTS = 3;

const AUTO_SYNC_ALARM = 'tbv:auto-sync';
const AUTO_SYNC_INTERVAL_MINUTES = 5;

// ── Keepalive (prevents 30 s MV3 worker suspension during long operations) ──
const KEEPALIVE_ALARM = 'tbv:keepalive';

function startKeepalive(): void {
  try {
    // Fire every ~24 s (< 30 s Chrome suspension timer).
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  } catch {
    // Alarms unavailable — best-effort only.
  }
}

function stopKeepalive(): void {
  try {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  } catch {
    // ignore
  }
}

// ── Sync checkpoint (resume interrupted syncs per-conversation) ──
const SYNC_CHECKPOINT_KEY = 'syncCheckpointConvId';

type PendingCopyCategorizationItem = {
  id: string;
  attempts: number;
  enqueuedAt: number;
};

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
  flowTrace('handleMessage', {
    type: message.type,
    url: sender.url || sender.tab?.url || undefined
  });
  switch (message.type) {
    case 'COPY_EVENT':
      return handleCopyEvent(message.data as CopyActivity, sender);

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
      }, sender);

    case 'GET_CONVERSATIONS':
      return handleGetConversations(message.data as GetConversationsParams | undefined);

    case 'CLEAR_CONVERSATIONS':
      return handleClearConversations();

    case 'GET_ANALYTICS':
      return handleGetAnalytics();

    case 'SAVE_NUDGE_EVENT':
      return handleSaveNudgeEvent(message.data as import('../types').NudgeEvent);

    case 'GET_NUDGE_STATS':
      return handleGetNudgeStats();

    case 'VERIFY_PARTICIPANT':
      return handleVerifyParticipant(message.data as { uuid: string });

    case 'TRIGGER_SYNC':
      return handleTriggerSync();

    case 'GET_SYNC_STATUS':
      return handleGetSyncStatus();

    case 'NUDGE_SESSION_COMPLETE':
      return handleNudgeSessionComplete(message.data as { fullSkip: boolean, triggerType: import('../types').NudgeTriggerType });

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
async function handleCopyEvent(activity: CopyActivity, sender: chrome.runtime.MessageSender): Promise<MessageResponse> {
  try {
    flowTrace('handleCopyEvent:start', {
      id: activity.id,
      conversationId: activity.conversationId,
      domain: activity.domain,
      turnSide: activity.turnSide,
      textLength: activity.textLength,
      extractionStrategy: activity.trigger?.extractionStrategy || undefined
    });

    // Defense-in-depth: process only response-side copy activity.
    if (activity.turnSide !== 'response') {
      flowTrace('handleCopyEvent:skip-non-response', {
        id: activity.id,
        turnSide: activity.turnSide || null,
        domain: activity.domain,
        extractionStrategy: activity.trigger?.extractionStrategy || null
      });
      return { success: true };
    }

    let enriched = await enrichCopyActivity(activity);

    // Recovery path: if turn capture missed but copy contains a paired prompt + full response,
    // infer and upsert a turn from copy metadata, then rematch.
    if (!enriched.turnId) {
      await tryBackfillTurnFromCopy(enriched);
      enriched = await enrichCopyActivity(enriched);
    }

    // Compute readability metrics for response-side copies.
    if (enriched.turnSide === 'response' && !enriched.readability) {
      const textForMetrics = enriched.copiedText || enriched.containerText || '';
      const result = computeReadability(textForMetrics);
      if (result) {
        enriched = { ...enriched, readability: result.metrics, complexity: result.complexity };
      }
    }

    await StorageManager.saveActivity(enriched);

    // If we couldn't match to a stored turn, queue LLM-2 fallback (debounced).
    // This avoids firing network calls immediately on every copy.
    if (!enriched.turnId && (!enriched.copyCategory || enriched.copyCategory === 'pending')) {
      void enqueueCopyCategorizationIfNeeded(enriched);
    }
    flowTrace('handleCopyEvent:done', {
      id: enriched.id,
      conversationId: enriched.conversationId,
      domain: enriched.domain,
      turnId: enriched.turnId || null,
      turnSide: enriched.turnSide || null,
      copyCategory: enriched.copyCategory || null,
      textLength: enriched.textLength
    });
    console.log('[TrustButVerify] Copy activity saved:', {
      domain: enriched.domain,
      length: enriched.textLength,
      trigger: enriched.trigger?.method || enriched.trigger?.type,
      turnId: enriched.turnId,
      turnSide: enriched.turnSide,
      copyCategory: enriched.copyCategory,
      timestamp: new Date(enriched.timestamp).toISOString()
    });

    // ── Nudge trigger: response-side copy ≥ 80 chars ──
    if (
      enriched.turnSide === 'response' &&
      enriched.textLength >= NUDGE_COPY_MIN_CHARS
    ) {
      void trySendCopyNudge(sender.tab?.id, enriched);
    }

    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error saving activity:', error);
    throw error;
  }
}

async function tryBackfillTurnFromCopy(activity: CopyActivity): Promise<void> {
  flowTrace('tryBackfillTurnFromCopy:start', {
    id: activity.id,
    conversationId: activity.conversationId,
    domain: activity.domain,
    turnId: activity.turnId || null,
    turnSide: activity.turnSide || null,
    extractionStrategy: activity.trigger?.extractionStrategy || undefined
  });
  if (!activity.conversationId) {
    flowTrace('tryBackfillTurnFromCopy:skip', { reason: 'no-conversation-id', id: activity.id });
    return;
  }
  if (activity.turnId) {
    flowTrace('tryBackfillTurnFromCopy:skip', { reason: 'already-linked', id: activity.id, turnId: activity.turnId });
    return;
  }
  if (activity.turnSide !== 'response') {
    flowTrace('tryBackfillTurnFromCopy:skip', { reason: 'not-response-side', id: activity.id, turnSide: activity.turnSide || null });
    return;
  }

  // Backfill is enabled for all supported LLM platforms.
  // When copy extraction provides a paired prompt + response and
  // no matching turn exists, infer the turn from copy metadata.
  const domain = (activity.domain || '').toLowerCase();
  const isSupportedLlm =
    domain.includes('chatgpt.com') || domain.includes('openai.com') ||
    domain.includes('claude.ai') ||
    domain.includes('gemini.google.com') ||
    domain.includes('grok.com') || domain.includes('x.ai') ||
    domain.includes('deepseek.com');
  if (!isSupportedLlm) {
    flowTrace('tryBackfillTurnFromCopy:skip', { reason: 'domain-gated', id: activity.id, domain });
    return;
  }

  const prompt = normalizeText(activity.pairedPromptText || '');
  const copiedResponse = normalizeText(activity.copiedText || '');
  const containerResponse = normalizeText(activity.containerText || '');
  const extractionStrategy = activity.trigger?.extractionStrategy || '';
  const isExplicitSelection = extractionStrategy.includes(':explicit');

  // Guard: explicit partial highlights should not create inferred full turns.
  // This avoids logging full conversation responses when user only copied a snippet.
  if (isExplicitSelection && copiedResponse && containerResponse) {
    const copiedLooksLikeFullContainer =
      containmentScore(copiedResponse, containerResponse) >= 0.9
      && copiedResponse.length >= Math.floor(containerResponse.length * 0.85);
    if (!copiedLooksLikeFullContainer) {
      flowTrace('tryBackfillTurnFromCopy:skip', { reason: 'explicit-partial-selection', id: activity.id });
      return;
    }
  }

  const response = normalizeText(
    isExplicitSelection
      ? (copiedResponse || containerResponse)
      : (containerResponse || copiedResponse)
  );
  if (prompt.length < 2 || response.length < 8) {
    flowTrace('tryBackfillTurnFromCopy:skip', {
      reason: 'prompt-response-too-short',
      id: activity.id,
      promptLength: prompt.length,
      responseLength: response.length
    });
    return;
  }

  const convo = await StorageManager.getConversationById(activity.conversationId);
  if (convo && !Array.isArray(convo.turns)) {
    return;
  }

  const existingTurns = convo?.turns || [];

  // Only recover when this conversation was active recently.
  // Prevent creating historical phantom turns from old copied content.
  const now = activity.timestamp || Date.now();
  if (convo?.lastUpdatedAt && (now - convo.lastUpdatedAt) > 10 * 60 * 1000) {
    flowTrace('tryBackfillTurnFromCopy:skip', { reason: 'conversation-stale', id: activity.id, conversationId: activity.conversationId });
    return;
  }

  const alreadyExists = existingTurns.some((t) => {
    const p = t?.prompt?.text || '';
    const r = t?.response?.text || '';
    return containmentScore(prompt, p) >= 0.9 && containmentScore(response, r) >= 0.8;
  });

  if (alreadyExists) {
    flowTrace('tryBackfillTurnFromCopy:skip', { reason: 'already-exists', id: activity.id, conversationId: activity.conversationId });
    return;
  }

  const inferredTurn: ConversationTurn = {
    id: `${now}-turn`,
    ts: now,
    prompt: {
      text: prompt,
      textLength: prompt.length,
      ts: Math.max(0, now - 1),
      meta: { inferredFromCopy: true }
    },
    response: {
      text: response,
      textLength: response.length,
      ts: now,
      meta: { inferredFromCopy: true }
    }
  };

  await StorageManager.upsertConversationTurns(
    activity.conversationId,
    {
      id: activity.conversationId,
      url: activity.url,
      domain: activity.domain,
      platform: convo?.platform,
      title: convo?.title
    },
    [inferredTurn]
  );

  // Keep categories aligned with the rest of the pipeline.
  await categorizeLatestPendingTurn(activity.conversationId);
  flowTrace('tryBackfillTurnFromCopy:created', {
    id: activity.id,
    conversationId: activity.conversationId,
    inferredTurnId: inferredTurn.id,
    promptLength: inferredTurn.prompt.textLength,
    responseLength: inferredTurn.response.textLength
  });
}

async function enqueueCopyCategorizationIfNeeded(activity: CopyActivity): Promise<void> {
  if (!activity.id) {
    return;
  }

  // If already categorized, don't enqueue.
  if (activity.copyCategorySource || (activity.copyCategory && activity.copyCategory !== 'pending')) {
    return;
  }

  const current = await chrome.storage.local.get(COPY_CATEGORIZATION_QUEUE_KEY);
  const queue = (current[COPY_CATEGORIZATION_QUEUE_KEY] as PendingCopyCategorizationItem[] | undefined) ?? [];
  if (!queue.some((q) => q.id === activity.id)) {
    queue.push({ id: activity.id, attempts: 0, enqueuedAt: Date.now() });
    await chrome.storage.local.set({ [COPY_CATEGORIZATION_QUEUE_KEY]: queue });
  }

  // Debounce by (re-)scheduling a run a few seconds out.
  scheduleCopyCategorizationRun();
}

function scheduleCopyCategorizationRun(): void {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(COPY_CATEGORIZATION_ALARM, {
        when: Date.now() + COPY_CATEGORIZATION_DELAY_MS
      });
      return;
    }
  } catch {
    // ignore
  }

  // Fallback: best-effort timer. Note MV3 workers may suspend; alarms are preferred.
  setTimeout(() => {
    void processCopyCategorizationQueue();
  }, COPY_CATEGORIZATION_DELAY_MS);
}

try {
  if (chrome?.alarms?.onAlarm?.addListener) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === COPY_CATEGORIZATION_ALARM) {
        void processCopyCategorizationQueue();
      } else if (alarm.name === AUTO_SYNC_ALARM) {
        void runAutoSync();
      } else if (alarm.name === KEEPALIVE_ALARM) {
        // No-op: receiving this alarm prevents the service worker from being suspended.
      }
    });
  } else {
    console.warn('[TrustButVerify] chrome.alarms unavailable; copy categorization will use setTimeout fallback');
  }
} catch (err) {
  console.warn('[TrustButVerify] Failed to register alarms listener (non-fatal):', err);
}

async function runAutoSync(): Promise<void> {
  const uuid = await StorageManager.getParticipantUuid();
  if (!uuid) return;
  flowTrace('autoSync:start');
  await handleTriggerSync();
  flowTrace('autoSync:done');
}

async function processCopyCategorizationQueue(): Promise<void> {
  startKeepalive();
  try {
    const current = await chrome.storage.local.get(COPY_CATEGORIZATION_QUEUE_KEY);
    const queue = (current[COPY_CATEGORIZATION_QUEUE_KEY] as PendingCopyCategorizationItem[] | undefined) ?? [];
    if (queue.length === 0) {
      return;
    }

    // Work oldest-first.
    queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

    const batch = queue.slice(0, COPY_CATEGORIZATION_BATCH_LIMIT);
    const remaining = queue.slice(COPY_CATEGORIZATION_BATCH_LIMIT);

    for (const item of batch) {
      if (!item?.id) continue;
      if (item.attempts >= COPY_CATEGORIZATION_MAX_ATTEMPTS) {
        continue;
      }

      const activity = await StorageManager.getCopyActivityById(item.id);
      if (!activity) {
        continue;
      }

      // Skip if it got linked/categorized while waiting.
      if (activity.turnId || activity.copyCategorySource || (activity.copyCategory && activity.copyCategory !== 'pending')) {
        continue;
      }

      // Per requirement: don't categorize response copies if we don't have paired prompt.
      // Re-match against turns right before fallback categorization.
      // Turns may arrive after the copy event.
      const rematched = await enrichCopyActivity(activity);
      if (rematched.turnId && rematched.copyCategorySource === 'turn') {
        await StorageManager.patchCopyActivityById(activity.id, {
          turnId: rematched.turnId,
          turnSide: rematched.turnSide,
          copyCategory: rematched.copyCategory,
          copyCategorySource: rematched.copyCategorySource
        });
        continue;
      }

      await categorizeCopyActivity(rematched);
    }

    // Re-read queue to remove processed items safely (other events may enqueue concurrently).
    const after = await chrome.storage.local.get(COPY_CATEGORIZATION_QUEUE_KEY);
    const latest = (after[COPY_CATEGORIZATION_QUEUE_KEY] as PendingCopyCategorizationItem[] | undefined) ?? [];

    const processedIds = new Set(batch.map((b) => b.id));
    const updated: PendingCopyCategorizationItem[] = [];
    for (const q of latest) {
      if (!processedIds.has(q.id)) {
        updated.push(q);
        continue;
      }

      // If still pending, keep with attempts+1; otherwise drop.
      const a = await StorageManager.getCopyActivityById(q.id);
      const stillPending = a && !a.turnId && !a.copyCategorySource && (!a.copyCategory || a.copyCategory === 'pending');
      if (stillPending && (q.attempts + 1) < COPY_CATEGORIZATION_MAX_ATTEMPTS) {
        updated.push({ ...q, attempts: q.attempts + 1 });
      }
    }

    // Keep any leftover items we didn't touch this run.
    for (const r of remaining) {
      if (!updated.some((u) => u.id === r.id)) {
        updated.push(r);
      }
    }

    await chrome.storage.local.set({ [COPY_CATEGORIZATION_QUEUE_KEY]: updated });

    // If more remain, schedule another run.
    if (updated.length > 0) {
      scheduleCopyCategorizationRun();
    }
  } catch (err) {
    console.warn('[TrustButVerify] Failed processing copy categorization queue (non-fatal):', err);
  } finally {
    stopKeepalive();
  }
}

/* ── Text normalisation & fuzzy matching ──────────────────────────────
 * These functions form a three-tier strategy to match a user's clipboard
 * copy against stored conversation turns:
 *  1. normalizeText / normalizeForMatch — collapse whitespace, strip
 *     zero-width chars, and optionally remove common UI artefacts.
 *  2. containmentScore — check if one normalised string is a substring
 *     of the other (soft then hard mode), returning a ratio [0‥1].
 *  3. tokenOverlapScore — fall back to word-level Jaccard-style overlap
 *     for cases where the copy is a reformatted version (e.g. table CSV
 *     vs rendered table text).
 * ──────────────────────────────────────────────────────────────────── */

function normalizeText(text: string): string {
  return (text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(text: string, mode: 'soft' | 'hard'): string {
  const soft = normalizeText(text)
    .toLowerCase()
    // Normalize some common UI artifacts that can appear in extracted text.
    .replace(/\bcopy code\b/gi, ' ')
    .replace(/\bcopy table\b/gi, ' ')
    .replace(/\bcopy\b/gi, ' ')
    .replace(/\bexport to sheets\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (mode === 'soft') {
    return soft;
  }

  // Hard mode: remove all non-alphanumeric characters to tolerate
  // punctuation/whitespace differences (e.g., missing spaces after periods).
  return soft.replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Tokenise text into words (≥ 3 chars) for overlap scoring.
 * Short tokens are discarded to reduce noise from articles/prepositions.
 */
function tokenizeForOverlap(text: string): string[] {
  const soft = normalizeForMatch(text, 'soft');
  if (!soft) return [];
  // Keep tokens with some signal; drop very short ones.
  return soft
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

/**
 * Compute a Jaccard-like overlap between two texts by comparing their
 * word-token sets. Returns max(coverageA, coverageB) in [0‥1], where
 * coverageX = |intersection| / |tokensX|.
 */
function tokenOverlapScore(a: string, b: string): number {
  const ta = tokenizeForOverlap(a);
  const tb = tokenizeForOverlap(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const setB = new Set(tb);
  let common = 0;
  for (const t of ta) {
    if (setB.has(t)) common++;
  }
  const coverageA = common / ta.length;
  const coverageB = common / tb.length;
  return Math.max(coverageA, coverageB);
}

/**
 * Three-pass containment check between two texts:
 *  1. Soft-normalised substring check (preserves word boundaries).
 *  2. Hard-normalised substring check (strips all punctuation/spaces).
 *  3. Token-overlap fallback (word-level Jaccard, scaled to 0.9 max).
 * Returns a score in [0‥1] where 1.0 = exact match.
 */
function containmentScore(a: string, b: string): number {
  const aSoft = normalizeForMatch(a, 'soft');
  const bSoft = normalizeForMatch(b, 'soft');
  if (!aSoft || !bSoft) return 0;
  if (aSoft === bSoft) return 1.0;

  // First: soft containment (fast).
  if (bSoft.includes(aSoft)) {
    return Math.min(1, aSoft.length / bSoft.length);
  }
  if (aSoft.includes(bSoft)) {
    return Math.min(1, bSoft.length / aSoft.length);
  }

  // Second: hard containment (tolerate punctuation/whitespace differences).
  const aHard = normalizeForMatch(a, 'hard');
  const bHard = normalizeForMatch(b, 'hard');
  if (aHard && bHard) {
    if (bHard.includes(aHard)) {
      return Math.min(1, aHard.length / bHard.length);
    }
    if (aHard.includes(bHard)) {
      return Math.min(1, bHard.length / aHard.length);
    }
  }

  // Finally: token overlap (handles table/csv vs rendered table text cases).
  const overlap = tokenOverlapScore(a, b);
  // Scale overlap into a score-like range; keep it conservative.
  return overlap * 0.9;
}

async function enrichCopyActivity(activity: CopyActivity): Promise<CopyActivity> {
  flowTrace('enrichCopyActivity:start', {
    id: activity.id,
    conversationId: activity.conversationId,
    domain: activity.domain,
    turnSide: activity.turnSide || null,
    hasPairedPrompt: Boolean(activity.pairedPromptText)
  });
  if (!activity.conversationId) {
    return activity;
  }

  const convo = await StorageManager.getConversationById(activity.conversationId);
  if (!convo || !Array.isArray(convo.turns) || convo.turns.length === 0) {
    flowTrace('enrichCopyActivity:no-turns', {
      id: activity.id,
      conversationId: activity.conversationId
    });
    return activity;
  }

  const candidateRaw = activity.containerText || activity.copiedText;
  const candidate = normalizeText(candidateRaw);
  const candidatePrompt = normalizeText(activity.pairedPromptText || '');
  if (candidate.length < 4) {
    return activity;
  }

  const sidePrefs: Array<'prompt' | 'response'> = activity.turnSide ? [activity.turnSide] : ['prompt', 'response'];
  const turns = convo.turns.slice(-20).reverse();

  let bestTurn: ConversationTurn | null = null;
  let bestSide: 'prompt' | 'response' | null = null;
  let bestScore = 0;
  let bestPrimaryScore = 0;
  let bestPromptScore = 0;

  for (const turn of turns) {
    for (const side of sidePrefs) {
      const text = side === 'prompt' ? turn.prompt.text : turn.response.text;
      const primaryScore = containmentScore(candidate, text);
      let score = primaryScore;
      let promptScore = 0;

      // If we have an extracted paired prompt, use it to anchor response matching.
      // This avoids false matches to the newest turn in the thread when copying
      // older content from the same conversation.
      if (side === 'response' && candidatePrompt.length >= 4) {
        promptScore = containmentScore(candidatePrompt, turn.prompt.text || '');
        score = (primaryScore * 0.8) + (promptScore * 0.2);

        // Penalize near-zero prompt alignment unless response containment is very strong.
        if (promptScore < 0.12 && primaryScore < 0.75) {
          score *= 0.7;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestPrimaryScore = primaryScore;
        bestPromptScore = promptScore;
        bestTurn = turn;
        bestSide = side;
      }
    }
    // Strong enough; stop early.
    if (bestScore >= 0.92) {
      break;
    }
  }

  // Only accept a match if there's clear containment.
  if (!bestTurn || !bestSide) {
    if (!activity.copyCategory) {
      return { ...activity, copyCategory: 'pending' };
    }
    return activity;
  }

  const matchedText = bestSide === 'prompt' ? bestTurn.prompt.text : bestTurn.response.text;
  const minLen = Math.min(candidateRaw.length, matchedText.length);

  // Acceptance thresholds:
  // - Allow lower scores when matching long content that may have UI artifacts or truncation.
  // - Be stricter for very short texts to avoid false positives.
  const acceptThreshold = minLen < 80 ? 0.45 : minLen < 200 ? 0.28 : 0.20;

  if (bestScore < acceptThreshold) {
    // Mark pending so UI/export can see this needs categorization.
    if (!activity.copyCategory) {
      return { ...activity, copyCategory: 'pending' };
    }
    flowTrace('enrichCopyActivity:unmatched', {
      id: activity.id,
      conversationId: activity.conversationId,
      bestScore,
      acceptThreshold
    });
    return activity;
  }

  // Extra guard for response-side matching when paired prompt exists:
  // if prompt alignment is weak, require a strong direct response match.
  if (bestSide === 'response' && candidatePrompt.length >= 4) {
    const strongResponseMatch = bestPrimaryScore >= 0.72;
    const acceptablePromptAlignment = bestPromptScore >= 0.25;
    if (!strongResponseMatch && !acceptablePromptAlignment) {
      if (!activity.copyCategory) {
        return { ...activity, copyCategory: 'pending' };
      }
      return activity;
    }
  }

  flowTrace('enrichCopyActivity:matched', {
    id: activity.id,
    conversationId: activity.conversationId,
    turnId: bestTurn.id,
    turnSide: activity.turnSide || bestSide,
    bestScore,
    bestPrimaryScore,
    bestPromptScore
  });
  return {
    ...activity,
    turnId: bestTurn.id,
    turnSide: activity.turnSide || bestSide,
    copyCategory: bestTurn.category || 'pending',
    copyCategorySource: 'turn'
  };
}

function buildCopyCategoryPrompt(activity: CopyActivity): string {
  const containerText = activity.containerText || activity.copiedText;

  if (activity.turnSide === 'response') {
    const paired = activity.pairedPromptText?.trim();
    return [
      'Categorise this copy event.',
      'Return a single JSON object (RFC 8259) and nothing else.',
      'No markdown, no code fences, no leading/trailing text.',
      'The JSON MUST contain exactly this key: "category".',
      '"category" must be 1-5 short labels, pipe-separated using "|".',
      `user_prompt: ${paired || '[not available]'}`,
      `LLM_response: ${containerText}`,
      'Example (format only):',
      '{"category":"Request|Logging|Python"}'
    ].join('\n');
  }

  // Prompt-side copy: categorise the prompt alone.
  return [
    'Categorise this user prompt copy event.',
    'Return a single JSON object (RFC 8259) and nothing else.',
    'No markdown, no code fences, no leading/trailing text.',
    'The JSON MUST contain exactly this key: "category".',
    '"category" must be 1-5 short labels, pipe-separated using "|".',
    `user_prompt: ${containerText}`,
    'Example (format only):',
    '{"category":"Request|Research"}'
  ].join('\n');
}

function extractCategoryOnly(content: string): string | null {
  const json = tryParseJsonObjectFromText(content);
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>;
    const raw = record.category;
    if (typeof raw === 'string') {
      const c = raw.trim();
      return c.length ? c : null;
    }
    if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) {
      const c = (raw as string[]).map((s) => s.trim()).filter(Boolean).join('|');
      return c.length ? c : null;
    }
  }
  const fallback = extractCategoryFromContent(content);
  return fallback;
}

async function categorizeCopyActivity(activity: CopyActivity): Promise<void> {
  if (!activity.id) {
    return;
  }
  if (copyCategorizationInFlightByActivityId.has(activity.id)) {
    return;
  }

  const task = (async () => {
    try {
      const prompt = buildCopyCategoryPrompt(activity);
      const r = await fetch(LLM2_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': basicAuthHeader(LLM2_USER, LLM2_PASS)
        },
        body: JSON.stringify({
          prompt,
          n_predict: 60,
          temperature: 0.2
        })
      });

      const text = await r.text();
      if (!r.ok) {
        console.warn('[TrustButVerify] LLM-2 copy categorization request failed', {
          status: r.status,
          statusText: r.statusText,
          bodyPreview: text.slice(0, 400)
        });
        return;
      }

      let content: string | null = null;
      try {
        const parsed = JSON.parse(text) as { content?: unknown };
        if (typeof parsed.content === 'string') {
          content = parsed.content;
        }
      } catch {
        // ignore
      }

      const category = extractCategoryOnly(content ?? text);
      if (!category) {
        console.warn('[TrustButVerify] LLM-2 copy categorization missing category; leaving pending', {
          contentPreview: (content ?? text).slice(0, 400)
        });
        return;
      }

      await StorageManager.patchCopyActivityById(activity.id, {
        copyCategory: category,
        copyCategorySource: 'llm'
      });
    } catch (err) {
      console.warn('[TrustButVerify] LLM-2 copy categorization failed (non-fatal):', err);
    }
  })();

  copyCategorizationInFlightByActivityId.set(activity.id, task);
  try {
    await task;
  } finally {
    copyCategorizationInFlightByActivityId.delete(activity.id);
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
}, sender: chrome.runtime.MessageSender): Promise<MessageResponse> {
  try {
    flowTrace('handleUpsertConversationTurns:start', {
      threadId: payload.threadId,
      turnCount: payload.turns.length,
      firstPromptLength: payload.turns[0]?.prompt?.textLength ?? 0,
      firstResponseLength: payload.turns[0]?.response?.textLength ?? 0
    });
    // Attach readability metrics to each turn's response before persisting.
    const enrichedTurns = payload.turns.map(turn => {
      if (turn.response?.text && !turn.response.readability) {
        const result = computeReadability(turn.response.text);
        if (result) {
          return {
            ...turn,
            response: {
              ...turn.response,
              readability: result.metrics,
              complexity: result.complexity,
            },
          };
        }
      }
      return turn;
    });

    await StorageManager.upsertConversationTurns(payload.threadId, payload.threadInfo, enrichedTurns);

    // IMPORTANT (MV3): If we fire-and-forget, Chrome may suspend the service worker
    // before the fetch+storage write completes, leaving categories stuck at 'pending'.
    // Awaiting here keeps the message event alive until categorization finishes.
    const t0 = Date.now();
    await categorizeLatestPendingTurn(payload.threadId);
    const dt = Date.now() - t0;
    if (dt > 2500) {
      console.log('[TrustButVerify] Turn categorization finished (slow):', {
        threadId: payload.threadId,
        ms: dt
      });
    }

    flowTrace('handleUpsertConversationTurns:done', {
      threadId: payload.threadId,
      turnCount: payload.turns.length
    });

    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error upserting turns:', error);
    throw error;
  }
}

function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

function buildCategoryPrompt(turn: ConversationTurn): string {
  // Cap very long texts to reduce prompt bloat and improve compliance.
  const cap = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max));
  const userPrompt = cap(turn.prompt.text || '', 6000);
  const llmResponse = cap(turn.response.text || '', 12000);

  return [
    'You are a strict JSON generator.',
    'Task: Categorise this conversation.',
    'Return a single JSON object (RFC 8259) and nothing else.',
    'No markdown, no code fences, no leading/trailing text.',
    'The JSON MUST contain exactly these keys: "category", "summary".',
    '"category" must be 1-5 short labels, pipe-separated using "|" (NOT commas).',
    '"summary" must be 1-5 sentences.',
    'If unsure, still pick the best available category labels.',
    `user_prompt: ${userPrompt}`,
    `LLM_response: ${llmResponse}`,
    'Example (format only; do not copy values):',
    '{"category":"Request|Course Enrollment","summary":"The user wants to enroll in a closed course and needs help drafting an email requesting an exception."}'
  ].join('\n');
}

function parseLlmCompletionPayload(text: string): string {
  try {
    const parsed = JSON.parse(text) as { content?: unknown };
    if (typeof parsed.content === 'string') {
      return parsed.content;
    }
  } catch {
    // ignore
  }
  return text;
}

async function requestTurnCategorization(turn: ConversationTurn, opts?: { temperature?: number; n_predict?: number }): Promise<string | null> {
  try {
    const prompt = buildCategoryPrompt(turn);
    const r = await fetch(LLM2_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': basicAuthHeader(LLM2_USER, LLM2_PASS)
      },
      body: JSON.stringify({
        prompt,
        n_predict: opts?.n_predict ?? 120,
        temperature: opts?.temperature ?? 0.0
      })
    });

    const text = await r.text();
    if (!r.ok) {
      console.warn('[TrustButVerify] LLM-2 categorization request failed', {
        status: r.status,
        statusText: r.statusText,
        bodyPreview: text.slice(0, 400)
      });
      return null;
    }
    return parseLlmCompletionPayload(text);
  } catch (error) {
    console.warn('[TrustButVerify] LLM-2 categorization request threw network error', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function tryParseJsonObjectFromText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  // Be tolerant of leading newlines or other stray text.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function extractCategoryAndSummary(content: string): { category: string; summary: string } | null {
  const json = tryParseJsonObjectFromText(content);
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>;

    let category: string | null = null;
    const rawCategory = record.category;
    if (typeof rawCategory === 'string') {
      category = rawCategory.trim();
    } else if (Array.isArray(rawCategory) && rawCategory.every((v) => typeof v === 'string')) {
      category = (rawCategory as string[]).map((s) => s.trim()).filter(Boolean).join('|');
    }

    const rawSummary = record.summary;
    const summary = typeof rawSummary === 'string' ? rawSummary.trim() : null;

    if (category && summary) {
      return { category, summary };
    }
  }

  // Fallback for older prompt formats (category:/summary: lines)
  const category = extractCategoryFromContent(content);
  const summary = extractSummaryFromContent(content);
  if (!category || !summary) {
    return null;
  }
  return { category, summary };
}

function extractCategoryFromContent(content: string): string | null {
  const match = content.match(/\bcategory\s*:\s*(.+)$/im);
  if (!match) return null;
  const value = match[1].trim();
  return value.length ? value : null;
}

function extractSummaryFromContent(content: string): string | null {
  const match = content.match(/\bsummary\s*:\s*(.+)$/im);
  if (!match) return null;
  const value = match[1].trim();
  return value.length ? value : null;
}

async function categorizeLatestPendingTurn(threadId: string): Promise<void> {
  if (categorizationInFlightByThreadId.has(threadId)) {
    return;
  }

  const task = (async () => {
    try {
      const conversations = await StorageManager.getAllConversations();
      const convo = conversations.find(c => c.id === threadId);
      if (!convo || !Array.isArray(convo.turns) || convo.turns.length === 0) {
        return;
      }

      // Process a small batch of pending turns (oldest-first among the most recent ones)
      // so duplicates or multiple pending turns don't get stuck forever.
      const pending = convo.turns
        .map((t, idx) => ({ t, idx }))
        .filter((x) => x.t?.category === 'pending')
        .slice(-3);

      if (pending.length === 0) {
        return;
      }

      const maxToProcess = 2;
      const now = Date.now();

      for (const { t: turn, idx } of pending.slice(0, maxToProcess)) {
        if (!turn || turn.category !== 'pending') {
          continue;
        }

        let completion = await requestTurnCategorization(turn, { temperature: 0.0, n_predict: 120 });
        let extracted = completion ? extractCategoryAndSummary(completion) : null;

        // Retry once with slightly different sampling if the model returned non-JSON output.
        if (!extracted) {
          completion = await requestTurnCategorization(turn, { temperature: 0.1, n_predict: 140 });
          extracted = completion ? extractCategoryAndSummary(completion) : null;
        }

        if (!extracted) {
          console.warn('[TrustButVerify] LLM-2 response missing category/summary; marking uncategorized', {
            threadId,
            turnId: turn.id,
            contentPreview: (completion ?? '').slice(0, 400)
          });

          // Avoid leaving 'pending' forever. This preserves flow without breaking matching.
          convo.turns[idx].category = 'Uncategorized';
          convo.turns[idx].summary = 'LLM-2 returned invalid categorization format.';
          convo.lastUpdatedAt = now;
          continue;
        }

        convo.turns[idx].category = extracted.category;
        convo.turns[idx].summary = extracted.summary;
        convo.lastUpdatedAt = now;

        // Keep copy activities in sync when they reference this turn.
        await StorageManager.updateCopyCategoriesForTurn(convo.turns[idx].id, extracted.category);
      }

      await chrome.storage.local.set({ conversationLogs: conversations });
    } catch (err) {
      console.warn('[TrustButVerify] LLM-2 categorization failed (non-fatal):', err);
    }
  })();

  categorizationInFlightByThreadId.set(threadId, task);
  try {
    await task;
  } finally {
    categorizationInFlightByThreadId.delete(threadId);
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

/* ------------------------------------------------------------------ */
/*  Nudge event persistence                                            */
/* ------------------------------------------------------------------ */

async function handleSaveNudgeEvent(event: import('../types').NudgeEvent): Promise<MessageResponse> {
  try {
    await StorageManager.saveNudgeEvent(event);
    flowTrace('nudge:event-saved', {
      id: event.id,
      questionId: event.nudgeQuestionId,
      response: event.response,
      dismissedBy: event.dismissedBy,
      triggerType: event.triggerType
    });
    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error saving nudge event:', error);
    return { success: false, error: (error as Error).message };
  }
}

async function handleGetNudgeStats(): Promise<MessageResponse> {
  try {
    const stats = await StorageManager.getNudgeAggregateStats();
    return { success: true, data: stats };
  } catch (error) {
    console.error('[TrustButVerify] Error getting nudge stats:', error);
    return { success: false, error: (error as Error).message };
  }
}

/* ------------------------------------------------------------------ */
/*  Nudge trigger helpers                                              */
/* ------------------------------------------------------------------ */

/** Minimum copied-text length to trigger a copy nudge. */
const NUDGE_COPY_MIN_CHARS = 40;

/**
 * Send a SHOW_NUDGE message to the content script on the given tab.
 * Fire-and-forget — errors are logged but never propagated.
 */
function sendNudgeToTab(
  tabId: number,
  data: {
    triggerType: string;
    conversationId?: string;
    turnId?: string;
    copyActivityId?: string;
    timeoutMs?: number;
    position?: string;
    textPreview?: string;
    questions: {
      questionId: string;
      questionText: string;
      answerMode: string;
      ratingLabels?: { low: string; high: string };
      yesLabel?: string;
      questionTags?: string[];
    }[];
  }
): void {
  chrome.tabs.sendMessage(
    tabId,
    { type: 'SHOW_NUDGE', data },
    { frameId: 0 },
    () => {
      // Swallow "receiving end does not exist" errors gracefully.
      if (chrome.runtime.lastError) {
        console.debug('[TrustButVerify] Nudge send skipped:', chrome.runtime.lastError.message);
      }
    }
  );
}

const NUDGE_COOLDOWN_KEY = 'nudgeCooldownState';

interface NudgeCooldownState {
  continuousSkips: number;
  pausedUntil: number;
}

async function handleNudgeSessionComplete(data: { fullSkip: boolean, triggerType: import('../types').NudgeTriggerType }): Promise<MessageResponse> {
  if (data.triggerType !== 'copy') {
    return { success: true };
  }

  try {
    const stateObj = await chrome.storage.local.get(NUDGE_COOLDOWN_KEY);
    const state: NudgeCooldownState = stateObj[NUDGE_COOLDOWN_KEY] || { continuousSkips: 0, pausedUntil: 0 };

    if (data.fullSkip) {
      state.continuousSkips += 1;
      console.log(`[TrustButVerify] Continuous full skips: ${state.continuousSkips}`);
      if (state.continuousSkips >= 3) {
        state.pausedUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
        console.log('[TrustButVerify] Nudges paused for 10 minutes due to 3 continuous skips');
      }
    } else {
      if (state.continuousSkips > 0) {
        console.log('[TrustButVerify] User answered a question, resetting continuous skips count to 0');
      }
      state.continuousSkips = 0;
    }

    await chrome.storage.local.set({ [NUDGE_COOLDOWN_KEY]: state });
    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error handling nudge session complete:', error);
    return { success: false, error: String(error) };
  }
}

async function trySendCopyNudge(
  tabId: number | undefined,
  activity: CopyActivity
): Promise<void> {
  console.log('[TrustButVerify:DEBUG] trySendCopyNudge entered', { tabId, domain: activity.domain, textLength: activity.textLength });

  if (!tabId) {
    console.log('[TrustButVerify:DEBUG] trySendCopyNudge returning early - NO TAB ID');
    return;
  }
  try {
    const stateObj = await chrome.storage.local.get(NUDGE_COOLDOWN_KEY);
    const state: NudgeCooldownState = stateObj[NUDGE_COOLDOWN_KEY] || { continuousSkips: 0, pausedUntil: 0 };

    console.log('[TrustButVerify:DEBUG] Cooldown state:', state);

    if (Date.now() < state.pausedUntil) {
      console.log('[TrustButVerify] Nudges are currently paused due to cooldown.');
      return;
    }

    const questions = getActiveNudgeQuestions('copy');
    console.log('[TrustButVerify:DEBUG] Fetched questions array length:', questions?.length);

    if (!questions || questions.length === 0) {
      console.log('[TrustButVerify:DEBUG] trySendCopyNudge returning early - NO QUESTIONS');
      return;
    }

    flowTrace('nudge:copy-trigger', {
      tabId,
      questionCount: questions.length,
      copyActivityId: activity.id,
      textLength: activity.textLength
    });

    const formattedQuestions = questions.map(q => ({
      questionId: q.id,
      questionText: q.text,
      answerMode: q.answerMode,
      ratingLabels: q.ratingLabels,
      yesLabel: q.yesLabel,
      questionTags: q.tags ? Array.from(new Set(q.tags)) : []
    }));

    const previewWords = activity.copiedText.split(/\s+/).slice(0, 15).join(' ');
    const textPreview = previewWords.length < activity.copiedText.length ? previewWords + '...' : previewWords;

    sendNudgeToTab(tabId, {
      triggerType: 'copy',
      conversationId: activity.conversationId,
      turnId: activity.turnId,
      copyActivityId: activity.id,
      timeoutMs: 60_000,
      position: 'bottom-right',
      textPreview,
      questions: formattedQuestions
    });
  } catch (error) {
    console.debug('[TrustButVerify] Copy nudge failed:', error);
  }
}

// Extension installed/updated
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[TrustButVerify] Extension installed/updated:', details.reason);
  routePopup();

  // Schedule periodic auto-sync
  chrome.alarms.create(AUTO_SYNC_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: AUTO_SYNC_INTERVAL_MINUTES
  });

  // Re-inject content scripts into all matching tabs so existing pages
  // don't require a hard-reload after extension install/update.
  if (details.reason === 'install' || details.reason === 'update') {
    reinjectContentScripts();
  }
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[TrustButVerify] Extension started (browser startup)');
  reinjectContentScripts();
});

async function reinjectContentScripts(): Promise<void> {
  const LLM_PATTERNS = [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://claude.ai/*',
    'https://gemini.google.com/*',
    'https://grok.com/*',
    'https://x.ai/*',
    'https://deepseek.com/*',
    'https://chat.deepseek.com/*',
    'https://www.deepseek.com/*'
  ];

  try {
    const tabs = await chrome.tabs.query({ url: LLM_PATTERNS });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          files: ['content/content-script.js']
        });
        console.log('[TrustButVerify] Re-injected content script into tab:', tab.id, tab.url);
      } catch (err) {
        // Tab may be a special page or discarded — non-fatal.
        console.debug('[TrustButVerify] Could not re-inject into tab:', tab.id, err);
      }
    }
  } catch (err) {
    console.debug('[TrustButVerify] reinjectContentScripts failed:', err);
  }
}

// Also check on service-worker startup (browser restart).
// Delay to ensure storage APIs are ready after rapid reloads.
setTimeout(() => routePopup(), 500);

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

/* ------------------------------------------------------------------ */
/*  Popup routing: registration vs main                                */
/* ------------------------------------------------------------------ */

async function routePopup(): Promise<void> {
  try {
    const uuid = await StorageManager.getParticipantUuid();
    if (uuid) {
      chrome.action.setPopup({ popup: 'popup/popup.html' });
    } else {
      chrome.action.setPopup({ popup: 'registration/registration.html' });
    }
  } catch (err) {
    console.error('[TrustButVerify] routePopup error:', err);
    // Fallback to registration if unknown state
    chrome.action.setPopup({ popup: 'registration/registration.html' });
  }
}

/* ------------------------------------------------------------------ */
/*  Sync / participant handlers                                        */
/* ------------------------------------------------------------------ */

async function handleVerifyParticipant(
  data: { uuid: string }
): Promise<MessageResponse> {
  const uuid = (data?.uuid || '').trim();
  if (!uuid) {
    return { success: false, error: 'UUID is required' };
  }

  try {
    const result = await apiVerifyParticipant(uuid);
    if (result.valid) {
      await StorageManager.setParticipantUuid(uuid);
      // Switch action popup to the main dashboard
      chrome.action.setPopup({ popup: 'popup/popup.html' });
      flowTrace('participant verified', { uuid });
      return { success: true, data: { valid: true } };
    }
    return { success: true, data: { valid: false, error: 'UUID not recognized by the server' } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TrustButVerify] Verify participant failed:', msg);
    return { success: false, error: msg };
  }
}

async function handleTriggerSync(): Promise<MessageResponse> {
  const uuid = await StorageManager.getParticipantUuid();
  if (!uuid) {
    return { success: false, error: 'No participant UUID registered' };
  }

  try {
    // Gather all local data
    const conversations = await StorageManager.getAllConversations();
    const nudgeEvents = await StorageManager.getAllNudgeEvents();
    const lastSyncAt = await StorageManager.getLastSyncAt();

    const syncDecision = evaluateSyncNeed(conversations, nudgeEvents, lastSyncAt);
    if (!syncDecision.shouldSync) {
      await StorageManager.setSyncStatus('idle');
      flowTrace(`sync:skipped-${syncDecision.reason}`, { lastSyncAt });
      return {
        success: true,
        data: {
          success: true,
          newConversations: 0,
          updatedConversations: 0,
          newTurns: 0,
          newCopyActivities: 0,
          newNudgeEvents: 0,
          syncedAt: lastSyncAt || Date.now()
        } as SyncResult
      };
    }

    await StorageManager.setSyncStatus('syncing');

    // Build the sync payload — shape it to match backend SyncRequest
    const { conversations: syncConversations, nudgeEvents: syncNudgeEvents } =
      buildSyncPayload(conversations, nudgeEvents);

    flowTrace('sync:start', {
      conversations: syncConversations.length,
      nudgeEvents: syncNudgeEvents.length
    });

    // ── Checkpoint-based upload: resume from last successfully synced conversation ──
    // On interruption (worker killed / network error), the next sync run picks up
    // from the last saved checkpoint instead of restarting from scratch.
    const cpResult = await chrome.storage.local.get(SYNC_CHECKPOINT_KEY);
    const checkpointId = cpResult[SYNC_CHECKPOINT_KEY] as string | undefined;
    const startIdx = checkpointId
      ? Math.max(0, syncConversations.findIndex((c) => c.id === checkpointId) + 1)
      : 0;

    if (startIdx > 0) {
      flowTrace('sync:resuming-from-checkpoint', { checkpointId, startIdx });
    }

    // Accumulate totals across all partial uploads.
    let totalNewConversations = 0;
    let totalUpdatedConversations = 0;
    let totalNewTurns = 0;
    let totalNewCopyActivities = 0;
    let totalNewNudgeEvents = 0;

    startKeepalive();
    try {
      // Upload one conversation at a time so we can checkpoint after each.
      for (let i = startIdx; i < syncConversations.length; i++) {
        const partial = await apiSyncData(uuid, {
          conversations: [syncConversations[i]],
          nudgeEvents: []
        });
        totalNewConversations += (partial.newConversations || 0);
        totalUpdatedConversations += (partial.updatedConversations || 0);
        totalNewTurns += (partial.newTurns || 0);
        totalNewCopyActivities += (partial.newCopyActivities || 0);
        // Save checkpoint after each successful conversation upload.
        await chrome.storage.local.set({ [SYNC_CHECKPOINT_KEY]: syncConversations[i].id });
      }

      // All conversations synced — now sync nudge events.
      const nudgeResult = await apiSyncData(uuid, { conversations: [], nudgeEvents: syncNudgeEvents });
      totalNewNudgeEvents = (nudgeResult.newNudgeEvents || 0);

      // Success: clear the checkpoint.
      await chrome.storage.local.remove(SYNC_CHECKPOINT_KEY);
    } finally {
      stopKeepalive();
    }

    const syncedAt = Date.now();
    await StorageManager.setLastSyncAt(syncedAt);
    await StorageManager.setSyncStatus('success');
    await StorageManager.compactAfterSuccessfulSync();

    const syncResult: SyncResult = {
      success: true,
      newConversations: totalNewConversations,
      updatedConversations: totalUpdatedConversations,
      newTurns: totalNewTurns,
      newCopyActivities: totalNewCopyActivities,
      newNudgeEvents: totalNewNudgeEvents,
      syncedAt
    };

    flowTrace('sync:done', syncResult as unknown as Record<string, unknown>);
    return { success: true, data: syncResult };
  } catch (err: unknown) {
    await StorageManager.setSyncStatus('error');
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TrustButVerify] Sync failed:', msg);
    // Note: checkpoint is intentionally NOT cleared on error, so the next run can resume.
    return {
      success: false,
      data: {
        success: false,
        newConversations: 0,
        updatedConversations: 0,
        newTurns: 0,
        newCopyActivities: 0,
        newNudgeEvents: 0,
        syncedAt: 0,
        error: msg
      } as SyncResult,
      error: msg
    };
  }
}

async function handleGetSyncStatus(): Promise<MessageResponse> {
  try {
    const participantUuid = await StorageManager.getParticipantUuid();
    const lastSyncAt = await StorageManager.getLastSyncAt();
    const syncStatus = await StorageManager.getSyncStatus();

    return {
      success: true,
      data: { participantUuid, lastSyncAt, syncStatus }
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/* ------------------------------------------------------------------ */
/*  Sync payload builder — maps local types to backend schema          */
/* ------------------------------------------------------------------ */

interface SyncTurnPayload {
  id: string;
  previousTurnId: string | null;
  prompt: {
    text?: string;
    textLength: number;
    ts: number;
  };
  response: {
    text?: string;
    textLength: number;
    ts: number;
    readability?: Record<string, unknown>;
    complexity?: Record<string, unknown>;
  };
  responseTimeMs: number | null;
  category: string | null;
  summary: string | null;
  ts: number;
}

interface SyncCopyPayload {
  id: string;
  timestamp: number;
  domain: string;
  url: string;
  conversationId: string;
  turnId: string | null;
  turnSide: string | null;
  textLength: number;
  containerTextLength: number | null;
  copyCategory: string | null;
  copyCategorySource: string | null;
  readability?: Record<string, unknown>;
  complexity?: Record<string, unknown>;
}

interface SyncConversationPayload {
  id: string;
  platform: string;
  domain: string;
  url: string;
  title: string | null;
  createdAt: number;
  lastUpdatedAt: number;
  turns: SyncTurnPayload[];
  copyActivities: SyncCopyPayload[];
}

interface SyncNudgePayload {
  id: string;
  timestamp: number;
  domain: string;
  conversationId: string;
  turnId: string | null;
  copyActivityId: string | null;
  triggerType: string;
  nudgeQuestionId: string;
  nudgeQuestionText: string;
  questionTags: string[];
  response: string | number;
  responseTimeMs: number;
  dismissedBy: string;
}

function buildSyncPayload(
  conversations: ConversationLog[],
  nudgeEvents: import('../types').NudgeEvent[]
): { conversations: SyncConversationPayload[]; nudgeEvents: SyncNudgePayload[] } {
  const syncConversations: SyncConversationPayload[] = conversations.map((c) => ({
    id: c.id,
    platform: c.platform || derivePlatformFromDomain(c.domain),
    domain: c.domain,
    url: c.url,
    title: c.title ?? null,
    createdAt: c.createdAt,
    lastUpdatedAt: c.lastUpdatedAt,
    turns: c.turns.map((t): SyncTurnPayload => ({
      id: t.id,
      previousTurnId: t.previousTurnId ?? null,
      prompt: {
        textLength: t.prompt.textLength,
        ts: t.prompt.ts
      },
      response: {
        textLength: t.response.textLength,
        ts: t.response.ts,
        ...(t.response.readability ? { readability: t.response.readability as unknown as Record<string, unknown> } : {}),
        ...(t.response.complexity ? { complexity: t.response.complexity as unknown as Record<string, unknown> } : {})
      },
      responseTimeMs: t.responseTimeMs ?? null,
      category: (t.category && t.category !== 'pending') ? t.category : null,
      summary: (t.summary && t.summary !== 'pending') ? t.summary : null,
      ts: t.ts
    })),
    copyActivities: (c.copyActivities || []).map((a): SyncCopyPayload => ({
      id: a.id,
      timestamp: a.timestamp,
      domain: a.domain,
      url: a.url,
      conversationId: a.conversationId || c.id,
      turnId: a.turnId ?? null,
      turnSide: a.turnSide ?? null,
      textLength: a.textLength,
      containerTextLength: a.containerTextLength ?? null,
      copyCategory: a.copyCategory ?? null,
      copyCategorySource: a.copyCategorySource ?? null,
      ...(a.readability ? { readability: a.readability as unknown as Record<string, unknown> } : {}),
      ...(a.complexity ? { complexity: a.complexity as unknown as Record<string, unknown> } : {})
    }))
  }));

  const syncNudgeEvents: SyncNudgePayload[] = nudgeEvents.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    domain: e.domain,
    conversationId: e.conversationId,
    turnId: e.turnId ?? null,
    copyActivityId: e.copyActivityId ?? null,
    triggerType: e.triggerType,
    nudgeQuestionId: e.nudgeQuestionId,
    nudgeQuestionText: e.nudgeQuestionText,
    questionTags: e.questionTags ?? [],
    response: e.response,
    responseTimeMs: e.responseTimeMs,
    dismissedBy: e.dismissedBy
  }));

  return { conversations: syncConversations, nudgeEvents: syncNudgeEvents };
}

function derivePlatformFromDomain(domain: string): string {
  if (domain.includes('chatgpt') || domain.includes('openai')) return 'ChatGPT';
  if (domain.includes('deepseek')) return 'DeepSeek';
  if (domain.includes('claude')) return 'Claude';
  if (domain.includes('gemini')) return 'Gemini';
  if (domain.includes('grok') || domain === 'x.ai') return 'Grok';
  return 'Unknown';
}
