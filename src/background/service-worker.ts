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
const LLM2_URL = 'https://llm.trustbutverify.dev/completion';
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
// Reference-counted: multiple concurrent fire-and-forget operations can each
// call startKeepalive/stopKeepalive without stomping on each other.
const KEEPALIVE_ALARM = 'tbv:keepalive';
let keepaliveRefCount = 0;

function startKeepalive(): void {
  keepaliveRefCount++;
  if (keepaliveRefCount === 1) {
    try {
      // Fire every ~24 s (< 30 s Chrome suspension timer).
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
    } catch {
      // Alarms unavailable — best-effort only.
    }
  }
}

function stopKeepalive(): void {
  keepaliveRefCount = Math.max(0, keepaliveRefCount - 1);
  if (keepaliveRefCount === 0) {
    try {
      chrome.alarms.clear(KEEPALIVE_ALARM);
    } catch {
      // ignore
    }
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

    case 'SAVE_NUDGE_EVENTS_BATCH':
      return handleSaveNudgeEventsBatch(message.data as import('../types').NudgeEvent[]);

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
    console.log('[TBV CAT][1] handleCopyEvent:ENTRY', {
      copyId: activity.id,
      convId: activity.conversationId,
      domain: activity.domain,
      turnSide: activity.turnSide,
      textLen: activity.textLength,
      strategy: activity.trigger?.extractionStrategy || null,
      method: activity.trigger?.method || activity.trigger?.type || null,
      hasPairedPrompt: Boolean(activity.pairedPromptText),
      copiedTextPreview: (activity.copiedText || '').slice(0, 80)
    });
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
      console.log('[TBV CAT][1] handleCopyEvent:SKIP non-response', { copyId: activity.id, turnSide: activity.turnSide || null });
      flowTrace('handleCopyEvent:skip-non-response', {
        id: activity.id,
        turnSide: activity.turnSide || null,
        domain: activity.domain,
        extractionStrategy: activity.trigger?.extractionStrategy || null
      });
      return { success: true };
    }

    console.log('[TBV CAT][2] enrichCopyActivity:FIRST-ATTEMPT', { copyId: activity.id });
    let enriched = await enrichCopyActivity(activity);
    console.log('[TBV CAT][2] enrichCopyActivity:FIRST-RESULT', {
      copyId: enriched.id,
      turnId: enriched.turnId || null,
      copyCategory: enriched.copyCategory || null,
      copyCategorySource: enriched.copyCategorySource || null
    });

    // Recovery path: if turn capture missed but copy contains a paired prompt + full response,
    // infer and upsert a turn from copy metadata, then rematch.
    let backfilledConvId: string | undefined;
    if (!enriched.turnId) {
      console.log('[TBV CAT][3] BACKFILL-PATH:ENTER — no turnId, trying backfill', { copyId: enriched.id, convId: enriched.conversationId });
      backfilledConvId = enriched.conversationId;
      await tryBackfillTurnFromCopy(enriched);
      console.log('[TBV CAT][3] enrichCopyActivity:SECOND-ATTEMPT (post-backfill)', { copyId: enriched.id });
      enriched = await enrichCopyActivity(enriched);
      console.log('[TBV CAT][3] enrichCopyActivity:SECOND-RESULT', {
        copyId: enriched.id,
        turnId: enriched.turnId || null,
        copyCategory: enriched.copyCategory || null,
        copyCategorySource: enriched.copyCategorySource || null
      });
    } else {
      console.log('[TBV CAT][3] BACKFILL-PATH:SKIP — turnId already found', { copyId: enriched.id, turnId: enriched.turnId });
    }

    // Compute readability metrics for response-side copies.
    if (enriched.turnSide === 'response' && !enriched.readability) {
      const textForMetrics = enriched.copiedText || enriched.containerText || '';
      const result = computeReadability(textForMetrics);
      if (result) {
        enriched = { ...enriched, readability: result.metrics, complexity: result.complexity };
      }
    }

    console.log('[TBV CAT][4] PRE-SAVE state', {
      copyId: enriched.id,
      turnId: enriched.turnId || null,
      copyCategory: enriched.copyCategory || null,
      copyCategorySource: enriched.copyCategorySource || null
    });
    await StorageManager.saveActivity(enriched);
    console.log('[TBV CAT][4] SAVED to storage', { copyId: enriched.id });

    // If we couldn't match to a stored turn, queue LLM-2 fallback (debounced).
    // This avoids firing network calls immediately on every copy.
    if (!enriched.turnId && (!enriched.copyCategory || enriched.copyCategory === 'pending')) {
      console.log('[TBV CAT][5] QUEUE-PATH:ENTER — no turnId + no final category, enqueueing for LLM-2', { copyId: enriched.id, copyCategory: enriched.copyCategory || null });
      void enqueueCopyCategorizationIfNeeded(enriched);
    } else if (enriched.turnId && (!enriched.copyCategory || enriched.copyCategory === 'pending')) {
      console.log('[TBV CAT][5] WAIT-FOR-TURN-CAT — has turnId but category pending, will propagate later', {
        copyId: enriched.id,
        turnId: enriched.turnId,
        copyCategory: enriched.copyCategory || null
      });
    } else {
      console.log('[TBV CAT][5] FINAL-CATEGORY-SET at save time', {
        copyId: enriched.id,
        turnId: enriched.turnId || null,
        copyCategory: enriched.copyCategory,
        copyCategorySource: enriched.copyCategorySource
      });
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
    console.debug('[TrustButVerify] Copy activity saved:', {
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

    // ── Background categorisation for backfilled turns ──
    // Fired AFTER copy is saved so categorizeLatestPendingTurn can find and
    if (backfilledConvId) {
      console.log('[TBV CAT][6] BACKFILL-CATEGORIZE:FIRE — fire-and-forget turn categorization', { copyId: enriched.id, backfilledConvId });
      void (async () => {
        startKeepalive();
        try {
          await categorizeLatestPendingTurn(backfilledConvId!);
        } catch (err) {
          console.warn('[TrustButVerify] Background backfill categorization failed (non-fatal):', err);
        } finally {
          stopKeepalive();
        }
      })();
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

  // Categorisation is deferred to handleCopyEvent (after copy is saved)
  // so that categorizeLatestPendingTurn can patch the linked copy activity.
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
    console.log('[TBV CAT][Q] enqueue:SKIP — no activity id');
    return;
  }

  // If already categorized, don't enqueue.
  if (activity.copyCategorySource || (activity.copyCategory && activity.copyCategory !== 'pending')) {
    console.log('[TBV CAT][Q] enqueue:SKIP — already categorized', {
      copyId: activity.id,
      copyCategory: activity.copyCategory,
      copyCategorySource: activity.copyCategorySource
    });
    return;
  }

  const current = await chrome.storage.local.get(COPY_CATEGORIZATION_QUEUE_KEY);
  const queue = (current[COPY_CATEGORIZATION_QUEUE_KEY] as PendingCopyCategorizationItem[] | undefined) ?? [];
  if (!queue.some((q) => q.id === activity.id)) {
    queue.push({ id: activity.id, attempts: 0, enqueuedAt: Date.now() });
    await chrome.storage.local.set({ [COPY_CATEGORIZATION_QUEUE_KEY]: queue });
    console.log('[TBV CAT][Q] enqueue:ADDED to queue', { copyId: activity.id, queueLen: queue.length });
  } else {
    console.log('[TBV CAT][Q] enqueue:ALREADY-IN-QUEUE', { copyId: activity.id });
  }

  // Debounce by (re-)scheduling a run a few seconds out.
  console.log('[TBV CAT][Q] enqueue:SCHEDULING alarm in', COPY_CATEGORIZATION_DELAY_MS, 'ms');
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
      console.log('[TBV CAT][QP] processQueue:EMPTY — nothing to process');
      return;
    }

    console.log('[TBV CAT][QP] processQueue:START', {
      queueLen: queue.length,
      ids: queue.map(q => q.id),
      attempts: queue.map(q => q.attempts)
    });

    // Work oldest-first.
    queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

    const batch = queue.slice(0, COPY_CATEGORIZATION_BATCH_LIMIT);
    const remaining = queue.slice(COPY_CATEGORIZATION_BATCH_LIMIT);

    for (const item of batch) {
      if (!item?.id) {
        console.log('[TBV CAT][QP] processQueue:SKIP — null item');
        continue;
      }
      if (item.attempts >= COPY_CATEGORIZATION_MAX_ATTEMPTS) {
        console.log('[TBV CAT][QP] processQueue:SKIP — max attempts reached', { copyId: item.id, attempts: item.attempts });
        continue;
      }

      const activity = await StorageManager.getCopyActivityById(item.id);
      if (!activity) {
        console.log('[TBV CAT][QP] processQueue:SKIP — activity not found in storage', { copyId: item.id });
        continue;
      }

      // Skip if it got linked/categorized while waiting.
      if (activity.turnId || activity.copyCategorySource || (activity.copyCategory && activity.copyCategory !== 'pending')) {
        console.log('[TBV CAT][QP] processQueue:SKIP — already categorized while waiting', {
          copyId: item.id,
          turnId: activity.turnId || null,
          copyCategory: activity.copyCategory || null,
          copyCategorySource: activity.copyCategorySource || null
        });
        continue;
      }

      // Per requirement: don't categorize response copies if we don't have paired prompt.
      // Re-match against turns right before fallback categorization.
      // Turns may arrive after the copy event.
      console.log('[TBV CAT][QP] processQueue:RE-ENRICH attempt', { copyId: item.id, attempt: item.attempts + 1 });
      const rematched = await enrichCopyActivity(activity);
      if (rematched.turnId && rematched.copyCategorySource === 'turn') {
        console.log('[TBV CAT][QP] processQueue:LATE-TURN-MATCH — turn arrived after copy, patching from turn', {
          copyId: item.id,
          turnId: rematched.turnId,
          copyCategory: rematched.copyCategory,
          copyCategorySource: rematched.copyCategorySource
        });
        await StorageManager.patchCopyActivityById(activity.id, {
          turnId: rematched.turnId,
          turnSide: rematched.turnSide,
          copyCategory: rematched.copyCategory,
          copyCategorySource: rematched.copyCategorySource
        });
        continue;
      }

      // Check if re-enrich found turnId but turn category is still pending
      if (rematched.turnId && !rematched.copyCategorySource) {
        console.log('[TBV CAT][QP] processQueue:TURN-FOUND-BUT-PENDING — turn matched but category still pending, sending to LLM-2', {
          copyId: item.id,
          turnId: rematched.turnId,
          copyCategory: rematched.copyCategory || null
        });
      } else {
        console.log('[TBV CAT][QP] processQueue:NO-TURN-MATCH — sending to LLM-2 direct copy categorization', { copyId: item.id });
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
        console.log('[TBV CAT][QP] processQueue:RETRY — still pending after processing, re-queuing', {
          copyId: q.id,
          nextAttempt: q.attempts + 1
        });
        updated.push({ ...q, attempts: q.attempts + 1 });
      } else if (stillPending) {
        console.log('[TBV CAT][QP] processQueue:GIVE-UP — max attempts exhausted, dropping', { copyId: q.id, attempts: q.attempts + 1 });
      } else {
        console.log('[TBV CAT][QP] processQueue:DONE — categorized successfully, removing from queue', {
          copyId: q.id,
          copyCategory: a?.copyCategory || null,
          copyCategorySource: a?.copyCategorySource || null,
          turnId: a?.turnId || null
        });
      }
    }

    // Keep any leftover items we didn't touch this run.
    for (const r of remaining) {
      if (!updated.some((u) => u.id === r.id)) {
        updated.push(r);
      }
    }

    await chrome.storage.local.set({ [COPY_CATEGORIZATION_QUEUE_KEY]: updated });
    console.log('[TBV CAT][QP] processQueue:END', { remainingInQueue: updated.length });

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

/**
 * One-directional containment: does `inner` appear inside `outer`?
 * Returns a score in [0..1].
 *
 * Unlike the symmetric containmentScore(), this only checks one direction:
 * whether inner is a substring of outer. This prevents false positives where
 * a very short turn response is trivially "contained" in a long copy container.
 * Falls back to directional token overlap when substring containment fails.
 */
function directionalContainment(inner: string, outer: string): number {
  const innerSoft = normalizeForMatch(inner, 'soft');
  const outerSoft = normalizeForMatch(outer, 'soft');
  if (!innerSoft || !outerSoft) return 0;
  if (innerSoft === outerSoft) return 1.0;

  // Soft substring check: is inner contained in outer?
  if (outerSoft.includes(innerSoft)) {
    return Math.min(1, innerSoft.length / outerSoft.length);
  }

  // Hard substring check (strip punctuation/whitespace)
  const innerHard = normalizeForMatch(inner, 'hard');
  const outerHard = normalizeForMatch(outer, 'hard');
  if (innerHard && outerHard && outerHard.includes(innerHard)) {
    return Math.min(1, innerHard.length / outerHard.length);
  }

  // Token overlap fallback — but only count how much of inner's
  // tokens appear in outer (directional coverage, not max of both).
  const innerTokens = tokenizeForOverlap(inner);
  const outerTokens = new Set(tokenizeForOverlap(outer));
  if (innerTokens.length === 0) return 0;
  let common = 0;
  for (const t of innerTokens) {
    if (outerTokens.has(t)) common++;
  }
  // Scaled down: token overlap is a weaker signal than substring containment.
  return (common / innerTokens.length) * 0.85;
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
    console.log('[TBV CAT][E] enrich:SKIP — no conversationId', { copyId: activity.id });
    return activity;
  }

  const convo = await StorageManager.getConversationById(activity.conversationId);
  if (!convo || !Array.isArray(convo.turns) || convo.turns.length === 0) {
    console.log('[TBV CAT][E] enrich:NO-TURNS — conversation has no stored turns', {
      copyId: activity.id,
      convId: activity.conversationId,
      convoExists: Boolean(convo)
    });
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
    console.log('[TBV CAT][E] enrich:SKIP — candidate text too short', { copyId: activity.id, candidateLen: candidate.length });
    return activity;
  }

  console.log('[TBV CAT][E] enrich:MATCHING', {
    copyId: activity.id,
    convId: activity.conversationId,
    turnsInConvo: convo.turns.length,
    candidateLen: candidate.length,
    candidatePromptLen: candidatePrompt.length,
    candidatePreview: candidate.slice(0, 60)
  });

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
      if (!text || text.length < 4) continue;

      // ── Length ratio guard ─────────────────────────────────────────
      // The candidate (containerText) should be similar in length to the
      // turn's text. If the turn is much shorter, it can't be the source.
      // If the turn is much longer, the container extraction likely missed
      // content — still allow but require strong containment.
      const ratio = Math.min(text.length, candidate.length)
                  / Math.max(text.length, candidate.length);
      if (ratio < 0.08) {
        continue; // Extreme mismatch — skip entirely
      }

      // ── Directional containment ────────────────────────────────────
      // Primary check: is candidate contained IN the turn's text?
      // (copy is a subset of turn — the normal case)
      const forwardScore = directionalContainment(candidate, text);

      // Secondary: is turn's text contained in candidate?
      // Only meaningful when lengths are similar (ratio ≥ 0.3),
      // otherwise this just means a short turn shares some words
      // with a long container — which is a false positive.
      const reverseScore = ratio >= 0.3
        ? directionalContainment(text, candidate)
        : 0;

      let primaryScore = Math.max(forwardScore, reverseScore);
      let promptScore = 0;

      // ── Prompt alignment ───────────────────────────────────────────
      // Use paired prompt as a qualifying gate, not just a bonus.
      // If we have a prompt to compare and it doesn't match at all,
      // penalize heavily — unless response match is near-perfect.
      if (side === 'response' && candidatePrompt.length >= 4) {
        promptScore = containmentScore(candidatePrompt, turn.prompt.text || '');

        if (promptScore < 0.10 && primaryScore < 0.80) {
          primaryScore *= 0.4; // Heavy penalty: unrelated prompt + weak response
        }
      }

      // Composite score — prompt is tiebreaker, not inflator
      const score = candidatePrompt.length >= 4
        ? (primaryScore * 0.85) + (promptScore * 0.15)
        : primaryScore;

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
    console.log('[TBV CAT][E] enrich:NO-CANDIDATE — no turn scored above 0', { copyId: activity.id });
    if (!activity.copyCategory) {
      return { ...activity, copyCategory: 'pending' };
    }
    return activity;
  }

  const matchedText = bestSide === 'prompt' ? bestTurn.prompt.text : bestTurn.response.text;
  const maxLen = Math.max(candidateRaw.length, matchedText.length);

  // Acceptance thresholds (based on the longer text — harder to match long content):
  // - Allow lower scores when matching long content that may have UI artifacts or truncation.
  // - Be stricter for very short texts to avoid false positives.
  const acceptThreshold = maxLen < 80 ? 0.50 : maxLen < 200 ? 0.35 : maxLen < 500 ? 0.25 : 0.20;

  if (bestScore < acceptThreshold) {
    console.log('[TBV CAT][E] enrich:BELOW-THRESHOLD — best score too low', {
      copyId: activity.id,
      bestTurnId: bestTurn.id,
      bestSide,
      bestScore: bestScore.toFixed(3),
      acceptThreshold,
      maxLen,
      turnCategory: bestTurn.category || null
    });
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

  flowTrace('enrichCopyActivity:matched', {
    id: activity.id,
    conversationId: activity.conversationId,
    turnId: bestTurn.id,
    turnSide: activity.turnSide || bestSide,
    bestScore,
    bestPrimaryScore,
    bestPromptScore,
    turnCategory: bestTurn.category || 'pending'
  });

  // Don't inherit "pending" — the turn's LLM-2 categorization hasn't finished.
  // Leave copyCategory undefined so enqueueCopyCategorizationIfNeeded() picks it
  // up for deferred re-categorization once the turn has a real category.
  const hasFinalCategory = bestTurn.category && bestTurn.category !== 'pending';

  console.log('[TBV CAT][E] enrich:MATCHED', {
    copyId: activity.id,
    matchedTurnId: bestTurn.id,
    matchedSide: bestSide,
    bestScore: bestScore.toFixed(3),
    primaryScore: bestPrimaryScore.toFixed(3),
    promptScore: bestPromptScore.toFixed(3),
    turnCategory: bestTurn.category || null,
    hasFinalCategory,
    resultCopyCategory: hasFinalCategory ? bestTurn.category : '(undefined — pending turn)',
    resultCopyCategorySource: hasFinalCategory ? 'turn' : '(undefined)'
  });

  return {
    ...activity,
    turnId: bestTurn.id,
    turnSide: activity.turnSide || bestSide,
    copyCategory: hasFinalCategory ? bestTurn.category : undefined,
    copyCategorySource: hasFinalCategory ? 'turn' : undefined
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
      if (!c.length) return null;
      // Cap at 5 labels — LLM-2 sometimes ignores the "1-5 labels" instruction.
      const labels = c.split('|').map(l => l.trim()).filter(Boolean);
      return labels.slice(0, 5).join('|') || null;
    }
    if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) {
      // Cap at 5 labels — same guard for array-form categories.
      const labels = (raw as string[]).map((s) => s.trim()).filter(Boolean);
      return labels.slice(0, 5).join('|') || null;
    }
  }
  const fallback = extractCategoryFromContent(content);
  return fallback;
}

async function categorizeCopyActivity(activity: CopyActivity): Promise<void> {
  if (!activity.id) {
    console.log('[TBV CAT][LLM-COPY] SKIP — no activity id');
    return;
  }
  if (copyCategorizationInFlightByActivityId.has(activity.id)) {
    console.log('[TBV CAT][LLM-COPY] SKIP — already in-flight', { copyId: activity.id });
    return;
  }

  console.log('[TBV CAT][LLM-COPY] START — sending copy to LLM-2 for direct categorization', {
    copyId: activity.id,
    turnId: activity.turnId || null,
    turnSide: activity.turnSide || null,
    textLen: activity.textLength,
    hasPairedPrompt: Boolean(activity.pairedPromptText)
  });

  const task = (async () => {
    try {
      const prompt = buildCopyCategoryPrompt(activity);
      const correlationId = `copy:${activity.id}`;
      const r = await fetch(LLM2_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': basicAuthHeader(LLM2_USER, LLM2_PASS)
        },
        body: JSON.stringify({
          prompt,
          n_predict: 60,
          temperature: 0.2,
          tbv_correlation_id: correlationId
        })
      });

      const text = await r.text();
      if (!r.ok) {
        console.warn('[TBV CAT][LLM-COPY] FAIL — LLM-2 HTTP error', {
          copyId: activity.id,
          status: r.status,
          statusText: r.statusText,
          bodyPreview: text.slice(0, 400)
        });
        return;
      }

      // Validate echoed correlation ID (safety-net log, not a hard gate).
      try {
        const respJson = JSON.parse(text) as Record<string, unknown>;
        const echoedId = respJson?.tbv_correlation_id;
        if (echoedId && echoedId !== correlationId) {
          console.warn('[TBV CAT][LLM-COPY] CORRELATION-MISMATCH', { copyId: activity.id, expected: correlationId, got: echoedId });
        }
      } catch { /* ignore — extractCategoryOnly handles parsing */
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
        console.warn('[TBV CAT][LLM-COPY] NO-CATEGORY — LLM-2 returned no parseable category; leaving pending', {
          copyId: activity.id,
          contentPreview: (content ?? text).slice(0, 400)
        });
        return;
      }

      console.log('[TBV CAT][LLM-COPY] SUCCESS — patching copy with LLM-2 category', {
        copyId: activity.id,
        category,
        copyCategorySource: 'llm'
      });
      await StorageManager.patchCopyActivityById(activity.id, {
        copyCategory: category,
        copyCategorySource: 'llm'
      });
    } catch (err) {
      console.warn('[TBV CAT][LLM-COPY] ERROR — LLM-2 copy categorization failed (non-fatal):', { copyId: activity.id, err });
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
    console.debug('[TrustButVerify] All activities cleared');

    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error clearing activities:', error);
    throw error;
  }
}



async function handleUpsertConversationTurns(payload: {
  threadId: string;
  threadInfo?: Partial<ConversationLog>;
  turns: ConversationTurn[];
}, sender: chrome.runtime.MessageSender): Promise<MessageResponse> {
  try {
    console.log('[TBV CAT][T] upsertTurns:ENTRY', {
      threadId: payload.threadId,
      turnCount: payload.turns.length,
      turnIds: payload.turns.map(t => t.id || '(new)'),
      firstPromptPreview: (payload.turns[0]?.prompt?.text || '').slice(0, 60)
    });
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
    console.log('[TBV CAT][T] upsertTurns:SAVED — turns persisted, firing background categorization', { threadId: payload.threadId });

    // Fire-and-forget: categorise in background with keepalive.
    // The turn is already saved above; no need to block the message handler.
    const tid = payload.threadId;
    void (async () => {
      startKeepalive();
      try {
        const t0 = Date.now();
        await categorizeLatestPendingTurn(tid);
        const dt = Date.now() - t0;
        console.log('[TBV CAT][T] upsertTurns:CATEGORIZE-DONE', { threadId: tid, ms: dt });
      } catch (err) {
        console.warn('[TrustButVerify] Background turn categorization failed (non-fatal):', err);
      } finally {
        stopKeepalive();
      }
    })();

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
    const correlationId = `turn:${turn.id}`;
    const r = await fetch(LLM2_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': basicAuthHeader(LLM2_USER, LLM2_PASS)
      },
      body: JSON.stringify({
        prompt,
        n_predict: opts?.n_predict ?? 120,
        temperature: opts?.temperature ?? 0.0,
        tbv_correlation_id: correlationId
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

    // Validate echoed correlation ID (safety-net log, not a hard gate).
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const echoedId = parsed?.tbv_correlation_id;
      if (echoedId && echoedId !== correlationId) {
        console.warn('[TrustButVerify] Correlation ID mismatch', { expected: correlationId, got: echoedId });
      }
    } catch { /* ignore parse errors — parseLlmCompletionPayload handles them */ }

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
    console.log('[TBV CAT][LLM-TURN] SKIP — already in-flight for thread', { threadId });
    return;
  }

  const task = (async () => {
    try {
      const conversations = await StorageManager.getAllConversations();
      const convo = conversations.find(c => c.id === threadId);
      if (!convo || !Array.isArray(convo.turns) || convo.turns.length === 0) {
        console.log('[TBV CAT][LLM-TURN] SKIP — no conversation or turns found', { threadId, convoExists: Boolean(convo) });
        return;
      }

      // Process a small batch of pending turns (oldest-first among the most recent ones)
      // so duplicates or multiple pending turns don't get stuck forever.
      const pending = convo.turns
        .map((t, idx) => ({ t, idx }))
        .filter((x) => x.t?.category === 'pending')
        .slice(-3);

      if (pending.length === 0) {
        console.log('[TBV CAT][LLM-TURN] SKIP — no pending turns', { threadId, totalTurns: convo.turns.length });
        return;
      }

      console.log('[TBV CAT][LLM-TURN] START', {
        threadId,
        pendingCount: pending.length,
        pendingTurnIds: pending.map(p => p.t.id),
        totalTurns: convo.turns.length
      });

      const maxToProcess = 2;

      // Collect categorization results first, then batch-write to storage.
      // This avoids holding a stale snapshot during multi-second LLM calls.
      const results: Array<{
        turnId: string;
        category: string;
        summary: string;
      }> = [];

      for (const { t: turn } of pending.slice(0, maxToProcess)) {
        if (!turn || turn.category !== 'pending') {
          continue;
        }

        console.log('[TBV CAT][LLM-TURN] REQUESTING LLM-2 categorization (attempt 1)', {
          threadId,
          turnId: turn.id,
          promptPreview: (turn.prompt.text || '').slice(0, 60)
        });

        let completion = await requestTurnCategorization(turn, { temperature: 0.0, n_predict: 120 });
        let extracted = completion ? extractCategoryAndSummary(completion) : null;

        // Retry once with slightly different sampling if the model returned non-JSON output.
        if (!extracted) {
          console.log('[TBV CAT][LLM-TURN] RETRY — first attempt failed, trying temp=0.1', { threadId, turnId: turn.id });
          completion = await requestTurnCategorization(turn, { temperature: 0.1, n_predict: 140 });
          extracted = completion ? extractCategoryAndSummary(completion) : null;
        }

        if (!extracted) {
          console.warn('[TBV CAT][LLM-TURN] UNCATEGORIZED — both LLM-2 attempts failed', {
            threadId,
            turnId: turn.id,
            contentPreview: (completion ?? '').slice(0, 400)
          });
          results.push({
            turnId: turn.id,
            category: 'Uncategorized',
            summary: 'LLM-2 returned invalid categorization format.'
          });
          continue;
        }

        console.log('[TBV CAT][LLM-TURN] LLM-2 returned category', {
          threadId,
          turnId: turn.id,
          category: extracted.category,
          summaryPreview: extracted.summary.slice(0, 80)
        });

        results.push({
          turnId: turn.id,
          category: extracted.category,
          summary: extracted.summary
        });
      }

      // ── Atomic re-read → patch → write ──────────────────────────────
      // Re-read the LATEST state from storage to avoid overwriting any
      // concurrent writes (new turns, copy activities, etc.) that happened
      // while the LLM calls were in flight.
      if (results.length > 0) {
        console.log('[TBV CAT][LLM-TURN] PATCH-PHASE — re-reading storage for atomic write', { threadId, resultCount: results.length });
        const freshConversations = await StorageManager.getAllConversations();
        const freshConvo = freshConversations.find(c => c.id === threadId);
        if (!freshConvo || !Array.isArray(freshConvo.turns)) {
          console.log('[TBV CAT][LLM-TURN] PATCH-ABORT — conversation disappeared from storage', { threadId });
          return;
        }

        const now = Date.now();
        let anyPatched = false;

        for (const result of results) {
          const turnIndex = freshConvo.turns.findIndex(t => t.id === result.turnId);
          if (turnIndex === -1) {
            console.log('[TBV CAT][LLM-TURN] PATCH-SKIP — turn not found in fresh data', { threadId, turnId: result.turnId });
            continue;
          }

          // Only patch if the turn is still pending — another code path
          // (e.g. copy enrichment) may have already categorized it.
          const currentCategory = freshConvo.turns[turnIndex].category;
          if (currentCategory && currentCategory !== 'pending') {
            console.log('[TBV CAT][LLM-TURN] PATCH-SKIP — turn already categorized by another path', {
              threadId,
              turnId: result.turnId,
              currentCategory,
              wouldHaveBeen: result.category
            });
            flowTrace('categorizeLatestPendingTurn:skipAlreadyCategorized', {
              threadId,
              turnId: result.turnId,
              currentCategory
            });
            continue;
          }

          freshConvo.turns[turnIndex].category = result.category;
          freshConvo.turns[turnIndex].summary = result.summary;
          freshConvo.lastUpdatedAt = now;
          anyPatched = true;

          console.log('[TBV CAT][LLM-TURN] TURN-PATCHED', {
            threadId,
            turnId: result.turnId,
            category: result.category
          });

          // Patch linked copy activities IN THE SAME in-memory data
          if (result.category !== 'Uncategorized') {
            let copyPatchCount = 0;
            const patchedCopyIds: string[] = [];
            for (const convo of freshConversations) {
              if (!convo.copyActivities || convo.copyActivities.length === 0) continue;
              for (let i = 0; i < convo.copyActivities.length; i++) {
                if (convo.copyActivities[i].turnId === result.turnId) {
                  const prevCategory = convo.copyActivities[i].copyCategory;
                  const prevSource = convo.copyActivities[i].copyCategorySource;
                  convo.copyActivities[i] = {
                    ...convo.copyActivities[i],
                    copyCategory: result.category,
                    copyCategorySource: 'turn'
                  };
                  patchedCopyIds.push(convo.copyActivities[i].id);
                  copyPatchCount++;
                  console.log('[TBV CAT][LLM-TURN] COPY-PROPAGATED', {
                    copyId: convo.copyActivities[i].id,
                    turnId: result.turnId,
                    prevCategory: prevCategory || null,
                    prevSource: prevSource || null,
                    newCategory: result.category,
                    newSource: 'turn'
                  });
                }
              }
            }
            console.log('[TBV CAT][LLM-TURN] COPY-PROPAGATION-SUMMARY', {
              turnId: result.turnId,
              category: result.category,
              copyPatchCount,
              patchedCopyIds
            });
          } else {
            console.log('[TBV CAT][LLM-TURN] COPY-PROPAGATION-SKIPPED — category is Uncategorized', {
              turnId: result.turnId
            });
          }
        }

        if (anyPatched) {
          await chrome.storage.local.set({ conversationLogs: freshConversations });
          console.log('[TBV CAT][LLM-TURN] STORAGE-WRITE — patched conversations written', { threadId });
        } else {
          console.log('[TBV CAT][LLM-TURN] STORAGE-WRITE-SKIPPED — nothing to patch', { threadId });
        }
      }
    } catch (err) {
      console.warn('[TBV CAT][LLM-TURN] ERROR — categorization failed (non-fatal):', err);
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

async function handleSaveNudgeEventsBatch(events: import('../types').NudgeEvent[]): Promise<MessageResponse> {
  try {
    await StorageManager.saveNudgeEventsBatch(events);
    flowTrace('nudge:batch-saved', {
      count: events.length,
      ids: events.map((e) => e.id)
    });
    return { success: true };
  } catch (error) {
    console.error('[TrustButVerify] Error saving nudge events batch:', error);
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
        state.pausedUntil = Date.now() + 1 * 60 * 1000; // 1 minute
        console.debug('[TrustButVerify] Nudges paused for 1 minute due to 3 continuous skips');
      }
    } else {
      if (state.continuousSkips > 0) {
        console.debug('[TrustButVerify] User answered a question, resetting continuous skips count to 0');
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
  console.debug('[TrustButVerify] trySendCopyNudge entered', { tabId, domain: activity.domain, textLength: activity.textLength });

  if (!tabId) {
    console.debug('[TrustButVerify] trySendCopyNudge returning early - NO TAB ID');
    return;
  }
  try {
    const stateObj = await chrome.storage.local.get(NUDGE_COOLDOWN_KEY);
    const state: NudgeCooldownState = stateObj[NUDGE_COOLDOWN_KEY] || { continuousSkips: 0, pausedUntil: 0 };

    console.debug('[TrustButVerify] Cooldown state:', state);

    if (Date.now() < state.pausedUntil) {
      console.debug('[TrustButVerify] Nudges are currently paused due to cooldown.');
      return;
    }

    // Pause expired → reset the skip counter so the user gets a fresh 3-skip allowance.
    if (state.continuousSkips >= 3) {
      state.continuousSkips = 0;
      state.pausedUntil = 0;
      await chrome.storage.local.set({ [NUDGE_COOLDOWN_KEY]: state });
      console.debug('[TrustButVerify] Cooldown expired — reset continuousSkips to 0');
    }

    const questions = getActiveNudgeQuestions('copy');
    console.debug('[TrustButVerify] Fetched questions array length:', questions?.length);

    if (!questions || questions.length === 0) {
      console.debug('[TrustButVerify] trySendCopyNudge returning early - NO QUESTIONS');
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
      timeoutMs: 120_000,
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
