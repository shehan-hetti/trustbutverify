import type { ConversationLog, ConversationTurn } from '../types';

/**
 * Utility to detect and extract conversations from different LLM platforms
 */
export class ConversationDetector {
  private readonly domain: string;
  // TEMP DEBUG: keep true while validating capture flow; disable/remove after testing.
  private readonly flowTraceEnabled = true;
  private pendingPrompt: { text: string; timestamp: number; threadId: string } | null = null;
  private lastPromptCapturedAt = 0;
  private lastPromptIntentAt = 0;
  private lastPromptThreadId: string | null = null;
  private lastUserInteractionAt = 0;
  /** Tracks the last prompt text that was successfully consumed (paired turn). */
  private lastConsumedPromptText: string | null = null;
  private lastConsumedPromptAt = 0;
  private readonly processedElements = new WeakSet<Element>();
  private readonly processedMessageKeys = new Set<string>();
  // Elements currently being tracked by an active waitForContent chain.
  // Prevents duplicate detectMessage → waitForContent calls for the same element.
  private readonly activeWaitElements = new WeakSet<Element>();
  private readonly processedMessageKeyQueue: string[] = [];
  private readonly recentPrompts: Array<{ text: string; timestamp: number }> = [];
  private extensionContextInvalidated = false;
  /** Currently observed thread ID, updated by monitorThreadChanges. */
  private currentThreadId = '';
  /**
   * Previous thread ID from the most recent prompt-migration.
   * When a new-chat URL redirect changes the thread ID while a prompt is pending,
   * we store the OLD thread here. Elements detected on the old thread (stamped
   * with tbvDetectedThread before the URL changed) are still valid.
   * Cleared after 15 s or on genuine navigation.
   */
  private migratedFromThreadId: string | null = null;
  private migratedFromThreadAt = 0;
  /** Whether the DOM is still settling after SPA navigation (captures blocked). */
  private isDomSettling = false;
  /** Handle for the thread-change polling interval so we can clear on teardown. */
  private threadChangeIntervalId: ReturnType<typeof setInterval> | null = null;
  /** Handles for the DOM-settling machinery. */
  private settlingObserver: MutationObserver | null = null;
  private settlingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private settlingReseedInterval: ReturnType<typeof setInterval> | null = null;
  private settlingMaxTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Monotonically increasing counter incremented every time DOM settling starts.
   * waitForContent captures this value at creation time and bails if it no longer
   * matches — this automatically cancels stale timers that survived a navigation.
   */
  private settlingGeneration = 0;

  private async sendMessageToBackground(payload: unknown): Promise<void> {
    // If extension was actually reloaded/updated while this page is alive,
    // runtime id is unavailable and further attempts are futile.
    if (this.extensionContextInvalidated || !chrome?.runtime?.id) {
      this.extensionContextInvalidated = true;
      throw new Error('Extension context invalidated');
    }

    const send = async () => {
      await chrome.runtime.sendMessage(payload);
    };

    try {
      await send();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();

      // Transient worker/message channel issues should not permanently disable capture.
      const isTransientPortIssue =
        lower.includes('message port closed') ||
        lower.includes('receiving end does not exist') ||
        lower.includes('could not establish connection');

      if (isTransientPortIssue && chrome?.runtime?.id) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        await send();
        return;
      }

      if (lower.includes('extension context invalidated')) {
        this.extensionContextInvalidated = true;
      }

      throw error;
    }
  }

  constructor(domain: string) {
    this.domain = domain;
    this.logDebug('Detector constructed', { domain: this.domain });
    this.traceFlow('constructor', { domain: this.domain });
  }

  private traceFlow(event: string, detail?: Record<string, unknown>): void {
    if (!this.flowTraceEnabled) {
      return;
    }
    if (detail) {
      console.log('[TBV FLOW][Detector]', event, detail);
      return;
    }
    console.log('[TBV FLOW][Detector]', event);
  }

  /**
   * Initialize conversation monitoring
   */
  init(): void {
    this.logDebug('Conversation monitoring initialized');
    this.traceFlow('init', {
      domain: this.domain,
      threadId: this.getConversationId()
    });

    // Record the initial thread ID for SPA navigation detection.
    this.currentThreadId = this.getConversationId();

    // Block captures synchronously while the async init decides whether to
    // restore a persisted prompt or start full DOM settling.
    this.isDomSettling = true;
    this.asyncInitSettling();

    // Use MutationObserver to detect new messages
    this.observeConversations();

    // Listen for form submissions (prompts)
    this.observePromptSubmissions();

    // Poll for SPA navigation (URL-based thread changes) every 500ms
    this.monitorThreadChanges();
  }

  /**
   * Async continuation of init(): checks chrome.storage.session for a
   * persisted pending prompt (surviving full-page navigations on new-chat
   * redirects). If found and recent, restores prompt state and skips settling
   * so the first response gets captured. Otherwise falls through to normal
   * DOM settling.
   */
  private async asyncInitSettling(): Promise<void> {
    try {
      const result = await chrome.storage.session.get('tbvPendingPrompt');
      const stored = result?.tbvPendingPrompt as
        | { text: string; timestamp: number; domain: string }
        | undefined;

      if (
        stored &&
        stored.domain === this.domain &&
        Date.now() - stored.timestamp < 15_000
      ) {
        // Recent prompt exists — this is likely a new-conversation redirect.
        // Restore prompt state and DON'T settle so the response gets captured.
        this.pendingPrompt = {
          text: stored.text,
          timestamp: stored.timestamp,
          threadId: this.currentThreadId
        };
        this.lastPromptCapturedAt = stored.timestamp;
        this.lastPromptIntentAt = stored.timestamp;
        this.lastUserInteractionAt = stored.timestamp;
        this.lastPromptThreadId = this.currentThreadId;

        // Seed existing messages so history isn't re-captured, but don't block
        // future captures (no settling).
        this.seedExistingAssistantMessages();
        this.isDomSettling = false;

        await chrome.storage.session.remove('tbvPendingPrompt');

        this.traceFlow('init:restoredPrompt', {
          threadId: this.currentThreadId,
          promptLength: stored.text.length,
          promptPreview: stored.text.substring(0, 80),
          ageMs: Date.now() - stored.timestamp
        });
        return;
      }
    } catch {
      // chrome.storage.session may not be available in all contexts — fall through.
    }

    // Normal load: start full adaptive DOM settling.
    this.startDomSettling();
  }

  /**
   * Called during URL-change navigation: check chrome.storage.session for a
   * recently-stored prompt. If found and fresh, restore it and skip settling
   * so the first response on the new thread gets captured. Otherwise fall
   * through to normal DOM settling.
   */
  private async tryRestorePromptThenSettle(newThreadId: string): Promise<void> {
    try {
      const result = await chrome.storage.session.get('tbvPendingPrompt');
      const stored = result?.tbvPendingPrompt as
        | { text: string; timestamp: number; domain: string }
        | undefined;

      if (
        stored &&
        stored.domain === this.domain &&
        Date.now() - stored.timestamp < 15_000
      ) {
        // Recent prompt — restore state and skip settling.
        this.pendingPrompt = {
          text: stored.text,
          timestamp: stored.timestamp,
          threadId: newThreadId
        };
        this.lastPromptCapturedAt = stored.timestamp;
        this.lastPromptIntentAt = stored.timestamp;
        this.lastUserInteractionAt = stored.timestamp;
        this.lastPromptThreadId = newThreadId;

        this.seedExistingAssistantMessages();
        this.isDomSettling = false;

        await chrome.storage.session.remove('tbvPendingPrompt');

        this.traceFlow('tryRestorePromptThenSettle:restored', {
          threadId: newThreadId,
          promptLength: stored.text.length,
          promptPreview: stored.text.substring(0, 80),
          ageMs: Date.now() - stored.timestamp
        });
        return;
      }
    } catch {
      // chrome.storage.session may not be available — fall through.
    }

    // No stored prompt — normal settling.
    this.startDomSettling();

    this.traceFlow('monitorThreadChanges:stateReset', {
      newThreadId,
      isDomSettling: true
    });
  }

  /**
   * Seed currently-rendered assistant messages as processed on startup.
   * This prevents historical backfill on refresh/opening old conversations.
   */
  private seedExistingAssistantMessages(): void {
    const selectors = this.getMessageSelectors();
    const seenKeys = new Set<string>();
    let seededCount = 0;

    for (const selector of selectors) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }

      nodes.forEach((candidate) => {
        if (this.isUserAuthoredElement(candidate)) {
          return;
        }

        const messageKey = this.getMessageKey(candidate);
        if (!messageKey) {
          return;
        }

        if (seenKeys.has(messageKey)) {
          return;
        }

        seenKeys.add(messageKey);
        // Seed only by key. Do not mark the DOM element as permanently processed,
        // because some sites may reuse existing nodes for new responses.
        this.registerProcessedKey(messageKey);
        seededCount += 1;
      });
    }

    if (seededCount > 0) {
      this.logDebug('Seeded existing assistant messages on init', {
        seededCount,
        domain: this.domain
      });
    }
  }

  /**
   * Poll for SPA navigation by comparing the current thread ID to the last known one.
   * On thread change:
   *  - If a prompt was captured very recently (≤15 s), update its threadId to the new one
   *    (handles new-chat URL rewrite race).
   *  - Otherwise, reset capture state and start DOM-settling detection.
   */
  private monitorThreadChanges(): void {
    if (this.threadChangeIntervalId !== null) {
      clearInterval(this.threadChangeIntervalId);
    }

    const POLL_MS = 500;
    // Must be generous enough for slow redirects (ChatGPT takes ~9 s).
    // Aligned with the 15 s freshness check in asyncInitSettling /
    // tryRestorePromptThenSettle.
    const PROMPT_GRACE_MS = 15_000;

    this.threadChangeIntervalId = setInterval(() => {
      const newThreadId = this.getConversationId();
      if (newThreadId === this.currentThreadId) {
        return;
      }

      const oldThreadId = this.currentThreadId;
      this.currentThreadId = newThreadId;

      this.traceFlow('monitorThreadChanges:change', {
        from: oldThreadId,
        to: newThreadId,
        hasPendingPrompt: Boolean(this.pendingPrompt),
        timeSinceLastPromptMs: this.lastPromptCapturedAt ? Date.now() - this.lastPromptCapturedAt : null
      });

      // If a prompt was captured just before the URL changed (new-chat redirect),
      // update pendingPrompt's threadId so it pairs with the response on the new thread.
      if (
        this.pendingPrompt
        && this.lastPromptCapturedAt > 0
        && (Date.now() - this.lastPromptCapturedAt) <= PROMPT_GRACE_MS
      ) {
        this.traceFlow('monitorThreadChanges:updatePendingPromptThread', {
          from: this.pendingPrompt.threadId,
          to: newThreadId
        });
        // Remember the old thread ID so threadGate allows elements stamped
        // before the URL redirect.
        this.migratedFromThreadId = this.pendingPrompt.threadId;
        this.migratedFromThreadAt = Date.now();
        this.pendingPrompt.threadId = newThreadId;
        this.lastPromptThreadId = newThreadId;
        return;
      }

      // Otherwise this is a genuine navigation – clear stale state to prevent phantom captures.
      this.pendingPrompt = null;
      this.lastPromptCapturedAt = 0;
      this.lastPromptIntentAt = 0;
      this.lastPromptThreadId = null;
      this.lastUserInteractionAt = 0;
      this.recentPrompts.length = 0;
      this.migratedFromThreadId = null;
      this.migratedFromThreadAt = 0;

      // Before settling, check chrome.storage.session for a recently-stored
      // prompt. This handles the case where a new-chat prompt was persisted
      // just before the URL changed (e.g. Grok / → /c/<id> redirect) but the
      // grace window above didn't apply because pendingPrompt was already
      // cleared by an earlier cycle.
      this.tryRestorePromptThenSettle(newThreadId);
    }, POLL_MS);
  }

  /* ------------------------------------------------------------------ */
  /*  Adaptive DOM-settling detection                                    */
  /*                                                                     */
  /*  After SPA navigation, the chat container gets populated with       */
  /*  historical messages. We block all captures until the DOM has been  */
  /*  quiet (no childList mutations) for SETTLE_QUIET_MS. During the    */
  /*  settling window we periodically re-seed so late-arriving messages  */
  /*  get marked as processed.                                          */
  /*                                                                     */
  /*  SETTLE_QUIET_MS  — required quiet time before declaring settled   */
  /*  SETTLE_MAX_MS    — hard cap to avoid blocking forever             */
  /*  RESEED_INTERVAL  — how often to re-seed during settling           */
  /* ------------------------------------------------------------------ */

  private static readonly SETTLE_QUIET_MS = 2_000;
  private static readonly SETTLE_MAX_MS = 30_000;
  private static readonly SETTLE_RESEED_MS = 1_000;

  private startDomSettling(): void {
    // If already settling (rapid navigation), tear down the old session first.
    this.finishDomSettling(true /* silent — don't seed, we're about to restart */);

    this.isDomSettling = true;
    this.settlingGeneration++;

    // Immediate seed of whatever is already rendered.
    this.seedExistingAssistantMessages();

    this.traceFlow('startDomSettling', { threadId: this.currentThreadId });

    // ── Debounced settling observer ────────────────────────────────────
    const resetDebounce = () => {
      if (this.settlingDebounceTimer !== null) {
        clearTimeout(this.settlingDebounceTimer);
      }
      this.settlingDebounceTimer = setTimeout(() => {
        // DOM has been quiet for SETTLE_QUIET_MS → settled.
        this.traceFlow('domSettled:quiet', {
          threadId: this.currentThreadId,
          quietMs: ConversationDetector.SETTLE_QUIET_MS
        });
        this.finishDomSettling();
      }, ConversationDetector.SETTLE_QUIET_MS);
    };

    // Start the initial debounce timer.
    resetDebounce();

    // Observe body for any structural mutations (message elements being added).
    this.settlingObserver = new MutationObserver(() => {
      resetDebounce();
    });
    this.settlingObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // ── Periodic re-seed ───────────────────────────────────────────────
    this.settlingReseedInterval = setInterval(() => {
      if (this.isDomSettling) {
        this.seedExistingAssistantMessages();
      }
    }, ConversationDetector.SETTLE_RESEED_MS);

    // ── Hard safety cap ────────────────────────────────────────────────
    this.settlingMaxTimer = setTimeout(() => {
      if (this.isDomSettling) {
        this.traceFlow('domSettled:maxCap', {
          threadId: this.currentThreadId,
          maxMs: ConversationDetector.SETTLE_MAX_MS
        });
        this.finishDomSettling();
      }
    }, ConversationDetector.SETTLE_MAX_MS);
  }

  /**
   * Declare the DOM settled, run a final seed, and re-enable captures.
   * @param silent If true, skip the final seed (used when restarting settling).
   */
  private finishDomSettling(silent = false): void {
    if (this.settlingObserver) {
      this.settlingObserver.disconnect();
      this.settlingObserver = null;
    }
    if (this.settlingDebounceTimer !== null) {
      clearTimeout(this.settlingDebounceTimer);
      this.settlingDebounceTimer = null;
    }
    if (this.settlingReseedInterval !== null) {
      clearInterval(this.settlingReseedInterval);
      this.settlingReseedInterval = null;
    }
    if (this.settlingMaxTimer !== null) {
      clearTimeout(this.settlingMaxTimer);
      this.settlingMaxTimer = null;
    }

    if (!silent) {
      // One final seed to catch anything that arrived in the last quiet window.
      this.seedExistingAssistantMessages();
      this.traceFlow('finishDomSettling', { threadId: this.currentThreadId });
    }

    this.isDomSettling = false;
  }

  /**
   * Derive a stable conversation/thread ID from URL/DOM
   */
  getConversationId(): string {
    try {
      const url = new URL(window.location.href);
      const path = url.pathname;

      if (this.domain.includes('chatgpt') || this.domain.includes('openai')) {
        const m = path.match(/\/c\/([^/?#]+)/);
        if (m) return `${this.domain}::${m[1]}`;
      }

      if (this.domain.includes('gemini')) {
        // Gemini uses /app/<id>
        const m = path.match(/\/app\/([^/?#]+)/);
        if (m) return `${this.domain}::${m[1]}`;
      }

      if (this.domain.includes('grok') || this.domain.includes('x.ai')) {
        // Grok uses /c/<id> and may include rid query
        const m = path.match(/\/c\/([^/?#]+)/);
        if (m) return `${this.domain}::${m[1]}`;
      }

      if (this.domain.includes('claude')) {
        // Claude uses /chat/<id>
        const m = path.match(/\/chat\/([^\/?#]+)/);
        if (m) return `${this.domain}::${m[1]}`;
      }

      if (this.domain.includes('deepseek')) {
        // DeepSeek uses /a/chat/s/<id>
        const m = path.match(/\/a\/chat\/s\/([^\/?#]+)/);
        if (m) return `${this.domain}::${m[1]}`;
      }

      // Fallback to deterministic hash of origin+path
      const key = `${url.origin}${url.pathname}`;
      let hash = 0;
      for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
      }
      return `${this.domain}::h${hash.toString(36)}`;
    } catch {
      return `${this.domain}::unknown`;
    }
  }

  /**
   * Observe DOM changes to detect new messages
   */
  private observeConversations(): void {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            this.detectMessage(node as Element);
          }
        });
      });
    });

    // Start observing the document with configured parameters
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Observe prompt submissions
   */
  private observePromptSubmissions(): void {
    this.logDebug('observePromptSubmissions start');
    this.traceFlow('observePromptSubmissions:start', {
      threadId: this.getConversationId(),
      domain: this.domain
    });
    let cachedPrompt = '';
    let cacheTimestamp = 0;

    const markUserInteraction = () => {
      this.lastUserInteractionAt = Date.now();
    };

    // Track explicit, trusted user interactions only.
    // Also snapshot the composer text on pointerdown. This fires BEFORE
    // React/framework handlers on the send button, ensuring we capture the
    // prompt text even if the platform clears the composer synchronously
    // on its own click/pointerdown handler (ChatGPT does this).
    document.addEventListener('pointerdown', (event) => {
      if (event.isTrusted) {
        markUserInteraction();
        // Snapshot composer text — it may be cleared by the time mousedown fires.
        updateCachedPrompt();
      }
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.isTrusted) {
        markUserInteraction();
        const target = event.target as HTMLElement | null;
        const hasComposerContext = Boolean(
          target
          && (
            this.isComposerElement(target)
            || target.closest('textarea, [role="textbox"], div[contenteditable="true"], .ProseMirror')
          )
        );
        if (hasComposerContext) {
          this.lastPromptIntentAt = Date.now();
          this.lastPromptThreadId = this.getConversationId();
          // this.traceFlow('observePromptSubmissions:keydownIntent', {
          //   threadId: this.lastPromptThreadId,
          //   key: event.key,
          //   isTrusted: event.isTrusted
          // });
        }
      }
    }, true);

    const updateCachedPrompt = () => {
      const text = this.getComposerText();
      if (text && text !== cachedPrompt) {
        cachedPrompt = text;
        cacheTimestamp = Date.now();
        this.logDebug('Composer updated', cachedPrompt.substring(0, 60));
      }
    };

    // Observe composer mutations for streaming editors (ProseMirror etc.)
    const monitorComposer = () => {
      const composer = this.getComposerElement();
      if (!composer) {
        this.logDebug('Composer not found, retrying');
        setTimeout(monitorComposer, 1000);
        return;
      }

      this.logDebug('Monitoring composer element', `${composer.tagName}.${composer.className}`.trim());

      const observer = new MutationObserver(() => updateCachedPrompt());
      observer.observe(composer, {
        childList: true,
        subtree: true,
        characterData: true
      });
    };

    monitorComposer();

    // Poll occasionally in case observer misses updates
    setInterval(updateCachedPrompt, 300);

    // Capture on Enter (without Shift)
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        const target = event.target as HTMLElement;
        const hasComposerContext = Boolean(
          target
          && (
            this.isComposerElement(target)
            || target.closest('textarea, [role="textbox"], div[contenteditable="true"], .ProseMirror')
          )
        );
        if (hasComposerContext) {
          if (!event.isTrusted) {
            return;
          }
          this.lastPromptIntentAt = Date.now();
          updateCachedPrompt();
          this.traceFlow('observePromptSubmissions:enterDetected', {
            threadId: this.getConversationId(),
            hasCachedPrompt: Boolean(cachedPrompt),
            cachedPromptLength: cachedPrompt.length
          });
          if (cachedPrompt) {
            this.logDebug('Enter captured prompt', cachedPrompt.substring(0, 120));
            this.handlePrompt(cachedPrompt);
            this.traceFlow('observePromptSubmissions:enterCapturedPrompt', {
              threadId: this.getConversationId(),
              promptLength: cachedPrompt.length,
              promptPreview: cachedPrompt.substring(0, 80)
            });
            cachedPrompt = '';
          }
        }
      }
    }, true);

    // Capture on form submit (covers UIs that submit via form)
    document.addEventListener('submit', (event) => {
      if (!event.isTrusted) {
        return;
      }
      this.lastPromptIntentAt = Date.now();
      this.lastPromptThreadId = this.getConversationId();
      const target = event.target as HTMLElement | null;
      updateCachedPrompt();
      const immediatePrompt = this.getComposerText();
      if (immediatePrompt && immediatePrompt !== cachedPrompt) {
        cachedPrompt = immediatePrompt;
        cacheTimestamp = Date.now();
      }

      const hasFreshPrompt = Boolean(cachedPrompt) && (Date.now() - cacheTimestamp < 45000);
      if (!hasFreshPrompt) {
        this.traceFlow('observePromptSubmissions:submitNoFreshPrompt', {
          threadId: this.getConversationId(),
          cacheAgeMs: cacheTimestamp ? (Date.now() - cacheTimestamp) : null
        });
        return;
      }

      if (cachedPrompt && Date.now() - cacheTimestamp < 45000) {
        this.logDebug('Submit captured prompt', {
          targetTag: target?.tagName,
          targetClass: target ? (target as HTMLElement).className : undefined,
          promptPreview: cachedPrompt.substring(0, 120)
        });
        this.handlePrompt(cachedPrompt);
        this.traceFlow('observePromptSubmissions:submitCapturedPrompt', {
          threadId: this.getConversationId(),
          promptLength: cachedPrompt.length,
          promptPreview: cachedPrompt.substring(0, 80)
        });
        cachedPrompt = '';
      }
    }, true);

    // Capture on send-like click (covers non-button send controls too)
    document.addEventListener('mousedown', (event) => {
      if (!event.isTrusted) {
        return;
      }
      const target = event.target as HTMLElement;

      // First, try to match a button with explicit send/submit attributes.
      const sendSpecificSelector =
        '[aria-label*="Send" i],[aria-label*="Submit" i],' +
        '[data-testid*="send" i],[data-test-id*="send" i],' +
        '[data-testid*="submit" i],[data-test-id*="submit" i]';
      let clickable = target.closest(sendSpecificSelector) as HTMLElement | null;

      // If no send-specific match, fall back to generic button — but ONLY if
      // it sits inside the composer area (form or contenteditable container).
      // This prevents sidebar buttons, "see all", lightbox nav etc. from
      // being treated as prompt-send controls.
      if (!clickable) {
        const genericBtn = target.closest('button,[role="button"]') as HTMLElement | null;
        if (genericBtn) {
          const nearComposer = Boolean(
            genericBtn.closest('form') ||
            genericBtn.parentElement?.querySelector(
              'textarea, [role="textbox"], div[contenteditable="true"], .ProseMirror'
            )
          );
          if (nearComposer) {
            clickable = genericBtn;
          }
        }
      }
      if (!clickable) {
        return;
      }

      // Avoid obvious non-send controls
      const aria = (clickable.getAttribute('aria-label') || '').toLowerCase();
      const txt = (clickable.textContent || '').toLowerCase();
      if (aria.includes('copy') || txt.includes('copy')) {
        this.traceFlow('observePromptSubmissions:clickIgnoredNonSend', {
          threadId: this.getConversationId(),
          clickableAria: aria || null,
          clickableTextPreview: txt.substring(0, 60) || null
        });
        return;
      }

      // ── NOTE: prompt-send intent is ONLY set below, inside the block
      //    where we actually capture prompt text.  Setting it here for every
      //    matched button (sidebar, "see all", lightbox, etc.) was the #1 cause
      //    of phantom inferred turns.

      updateCachedPrompt();
      const immediatePrompt = this.getComposerText();
      if (immediatePrompt && immediatePrompt !== cachedPrompt) {
        cachedPrompt = immediatePrompt;
        cacheTimestamp = Date.now();
      }

      const hasFreshPrompt = Boolean(cachedPrompt) && (Date.now() - cacheTimestamp < 45000);
      if (!hasFreshPrompt) {
        this.traceFlow('observePromptSubmissions:clickNoFreshPrompt', {
          threadId: this.getConversationId(),
          clickableAria: clickable.getAttribute('aria-label') || null,
          cacheAgeMs: cacheTimestamp ? (Date.now() - cacheTimestamp) : null
        });
        return;
      }

      // Minimum prompt length: single-character composer leftovers are not prompts.
      if (cachedPrompt.trim().length < 2) {
        this.traceFlow('observePromptSubmissions:clickPromptTooShort', {
          threadId: this.getConversationId(),
          promptLength: cachedPrompt.trim().length
        });
        cachedPrompt = '';
        return;
      }

      if (cachedPrompt && Date.now() - cacheTimestamp < 45000) {
        // NOW record intent — only when we actually have a substantive prompt.
        this.lastPromptIntentAt = Date.now();
        this.lastPromptThreadId = this.getConversationId();

        this.logDebug('Click captured prompt', {
          clickableTag: clickable.tagName,
          clickableAria: clickable.getAttribute('aria-label') || undefined,
          clickableTestId: clickable.getAttribute('data-testid') || clickable.getAttribute('data-test-id') || undefined,
          promptPreview: cachedPrompt.substring(0, 120)
        });
        this.handlePrompt(cachedPrompt);
        this.traceFlow('observePromptSubmissions:clickCapturedPrompt', {
          threadId: this.getConversationId(),
          promptLength: cachedPrompt.length,
          promptPreview: cachedPrompt.substring(0, 80)
        });
        cachedPrompt = '';
      }
    }, true);
  }

  /**
   * Locate the active composer element across platforms
   */
  private getComposerElement(): HTMLElement | null {
    const selectors = this.getComposerSelectors();

    for (const selector of selectors) {
      const element = document.querySelector(selector) as HTMLElement | null;
      if (element && (element.textContent?.trim() || (element as HTMLTextAreaElement).value?.trim() || element === document.activeElement)) {
        return element;
      }
    }

    return document.querySelector(selectors[0]) as HTMLElement | null;
  }

  /**
   * Get composer selectors per domain
   */
  private getComposerSelectors(): string[] {
    const baseSelectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div.ProseMirror',
      'textarea#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      'textarea'
    ];

    if (this.domain.includes('grok') || this.domain.includes('x.ai')) {
      return [
        'div[contenteditable="true"][data-testid*="composer"]',
        'div[contenteditable="true"][aria-label*="Ask"]',
        'div.tiptap.ProseMirror',
        'textarea[data-testid*="composer"]',
        ...baseSelectors
      ];
    }

    if (this.domain.includes('deepseek')) {
      return [
        'textarea[data-testid*="chat-input"]',
        'textarea[placeholder*="Ask"]',
        'div[contenteditable="true"][data-placeholder*="message"]',
        'div[contenteditable="true"][aria-label*="Ask"]',
        'div[contenteditable="true"][data-testid*="composer"]',
        ...baseSelectors
      ];
    }

    if (this.domain.includes('claude')) {
      return [
        'div[contenteditable="true"][data-component="composer"]',
        'textarea[data-testid="composer-textarea"]',
        ...baseSelectors
      ];
    }

    if (this.domain.includes('gemini')) {
      return [
        'div[contenteditable="true"][aria-label*="Prompt"]',
        'textarea[aria-label*="Enter"]',
        ...baseSelectors
      ];
    }

    return baseSelectors;
  }

  /**
   * Determine if element is part of composer
   */
  private isComposerElement(element: HTMLElement | null): boolean {
    if (!element) {
      return false;
    }
    if (element === this.getComposerElement()) {
      return true;
    }

    // Many platforms use textarea for the composer.
    if (element.matches('textarea') || Boolean(element.closest('textarea'))) {
      return true;
    }

    return Boolean(
      element.closest('div[contenteditable="true"]') ||
      element.closest('[role="textbox"]') ||
      element.closest('.ProseMirror')
    );
  }

  /**
   * Extract text from composer element
   */
  private getComposerText(): string | '' {
    const composer = this.getComposerElement();
    if (!composer) {
      return '';
    }

    if ((composer as HTMLTextAreaElement).value !== undefined) {
      return (composer as HTMLTextAreaElement).value.trim();
    }

    return composer.textContent?.trim() || '';
  }

  /**
   * Detect if a new element is a conversation message
   */
  private detectMessage(element: Element): void {
    // this.traceFlow('detectMessage:start', {
    //   tag: element.tagName,
    //   className: (element as HTMLElement).className || '',
    //   id: (element as HTMLElement).id || ''
    // });
    // Platform-specific selectors
    const selectors = this.getMessageSelectors();

    for (const selector of selectors) {
      const candidates: Element[] = [];

      // Handle streaming UIs where mutations happen inside an existing
      // assistant wrapper (no new wrapper node added).
      try {
        const ancestor = element.closest(selector);
        if (ancestor) {
          candidates.push(ancestor);
        }
      } catch {
        // ignore invalid selector errors
      }

      if (element.matches(selector)) {
        candidates.push(element);
      }

      element.querySelectorAll(selector).forEach((matchedNode) => {
        if (!candidates.includes(matchedNode as Element)) {
          candidates.push(matchedNode as Element);
        }
      });

      if (!candidates.length) {
        continue;
      }

      candidates.forEach((candidate) => {
        const previousKey = candidate instanceof HTMLElement ? candidate.dataset.tbvKey : undefined;
        const messageKey = this.getMessageKey(candidate);

        if (candidate instanceof HTMLElement && messageKey) {
          candidate.dataset.tbvKey = messageKey;
        }

        if (messageKey && this.processedMessageKeys.has(messageKey)) {
          this.logDebug('Skipping already processed element', {
            selector,
            tag: candidate.tagName,
            class: (candidate as HTMLElement).className,
            id: (candidate as HTMLElement).id,
            messageKey,
            textPreview: (candidate.textContent || '').substring(0, 120)
          });
          this.markProcessed(candidate, messageKey);
          return;
        }

        if (this.processedElements.has(candidate)) {
          // Allow re-processing if the same DOM element now represents a different message.
          // This behavior is primarily needed for Gemini where DOM nodes are often reused.
          // On Claude it can cause multiple partial captures while a single response is still rendering.
          const allowKeyChangeReprocess = this.isGeminiDomain();
          if (!allowKeyChangeReprocess || !previousKey || !messageKey || previousKey === messageKey) {
            return;
          }

          this.logDebug('Re-processing previously seen element due to key change', {
            previousKey,
            messageKey,
            tag: candidate.tagName,
            class: (candidate as HTMLElement).className,
            id: (candidate as HTMLElement).id
          });
        }

        if (this.isUserAuthoredElement(candidate)) {
          this.capturePromptFromUserElement(candidate);
          this.traceFlow('detectMessage:userElement', {
            threadId: this.getConversationId(),
            messageKey,
            textLength: (candidate.textContent || '').trim().length
          });
          this.markProcessed(candidate, messageKey);
          this.logDebug('Skipping user-authored element', {
            selector,
            tag: candidate.tagName,
            class: (candidate as HTMLElement).className,
            id: (candidate as HTMLElement).id,
            messageKey,
            textPreview: (candidate.textContent || '').substring(0, 120)
          });
          return;
        }

        // ── ChatGPT tool-use / web-search widget filter ─────────────
        // ChatGPT renders MULTIPLE [data-message-author-role="assistant"]
        // elements per response when using tools (web search, DALL-E,
        // code interpreter).  The tool-output element has a
        // data-message-id like "agg_w_XXX:request-WEB:…".  These are
        // NOT the final text response and must be excluded, otherwise
        // the first element consumes pendingPrompt and the second falls
        // into the inferred-turn path — creating a phantom duplicate.
        if (this.isChatGPTDomain()) {
          const msgId = (candidate instanceof HTMLElement
            ? candidate.getAttribute('data-message-id') || ''
            : ''
          ).toLowerCase();
          if (
            msgId.includes('request-web') ||
            msgId.includes('request-dall') ||
            msgId.includes('request-code') ||
            msgId.includes('request-tool')
          ) {
            this.traceFlow('detectMessage:skippedToolElement', {
              threadId: this.getConversationId(),
              messageKey,
              msgId
            });
            this.markProcessed(candidate, messageKey);
            return;
          }
        }

        this.logDebug('Message selector matched', {
          selector,
          tag: candidate.tagName,
          class: (candidate as HTMLElement).className,
          id: (candidate as HTMLElement).id,
          messageKey,
          textPreview: (candidate.textContent || '').substring(0, 120)
        });

        // Skip if a waitForContent chain is already active for this element
        if (this.activeWaitElements.has(candidate)) {
          return;
        }

        // Wait for content to load (streaming responses)
        this.traceFlow('detectMessage:assistantCandidate', {
          threadId: this.getConversationId(),
          messageKey,
          selector
        });
        // Stamp the thread ID on the element so that waitForContent →
        // extractAndSaveMessage can verify the thread hasn't changed.
        if (candidate instanceof HTMLElement) {
          candidate.dataset.tbvDetectedThread = this.currentThreadId;
        }

        // During DOM settling, don't start new waitForContent chains — the
        // periodic re-seed in startDomSettling handles marking elements as
        // processed.  Starting timers here would only create stale captures
        // that fire after settling finishes.
        // IMPORTANT: Do NOT markProcessed here — elements blocked during
        // settling must remain eligible for detection after settling finishes.
        // The final seedExistingAssistantMessages() call + MutationObserver
        // will re-detect them.
        if (this.isDomSettling) {
          this.traceFlow('detectMessage:blockedDuringSettling', {
            threadId: this.getConversationId(),
            messageKey
          });
          return;
        }

        this.waitForContent(candidate);
      });
    }
  }

  /**
   * Wait for element to have content, then extract it
   */
  private waitForContent(element: Element): void {
    // Capture the settling generation at creation time.  If a navigation or
    // settling restart bumps the generation while this timer is in-flight,
    // finalizeIfReady will detect the mismatch and bail out.
    const capturedGeneration = this.settlingGeneration;

    if (this.processedElements.has(element)) {
      return;
    }

    // Mark element as actively being tracked to prevent duplicate chains
    this.activeWaitElements.add(element);

    const initialKey = this.getElementKey(element);
    if (initialKey && this.processedMessageKeys.has(initialKey)) {
      this.logDebug('Element already processed before waiting', {
        messageKey: initialKey,
        tag: element.tagName,
        class: (element as HTMLElement).className,
        id: (element as HTMLElement).id
      });
      this.markProcessed(element, initialKey);
      return;
    }

    let observer: MutationObserver | null = null;
    let platformSignalObserver: MutationObserver | null = null;
    let fallbackTimeout: number | null = null;
    let absoluteMaxTimeout: number | null = null;
    let stabilityTimer: number | null = null;
    let platformSettleTimer: number | null = null;
    let lastStableText = '';
    let retryCount = 0;
    let waitRetryCount = 0;
    let lastLoggedWaitRetryCount = 0;
    let waitRetryActive = false;
    let platformSignalFired = false;
    let lastWatchdogLogLength = 0;

    const STABILITY_DELAY = 3000;
    const PLATFORM_SETTLE_MS = 3000;   // settle time after platform signal fires
    const FALLBACK_DELAY = 180_000;
    const ABSOLUTE_MAX_WAIT_MS = 300_000;
    const PROMPT_WAIT_RETRY_MS = 150;
    const PROMPT_WAIT_MAX_RETRIES = 10;
    const WAIT_RETRY_MAX = 120;

    this.traceFlow('waitForContent:start', {
      stabilityDelay: STABILITY_DELAY,
      platformSettleMs: PLATFORM_SETTLE_MS,
      fallbackDelay: FALLBACK_DELAY,
      absoluteMax: ABSOLUTE_MAX_WAIT_MS,
      threadId: this.getConversationId(),
      key: this.getElementKey(element),
      tag: element.tagName
    });

    const cleanup = () => {
      // Remove from active tracking so element can be re-detected if needed
      this.activeWaitElements.delete(element);
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (platformSignalObserver) {
        platformSignalObserver.disconnect();
        platformSignalObserver = null;
      }
      if (fallbackTimeout !== null) {
        window.clearTimeout(fallbackTimeout);
        fallbackTimeout = null;
      }
      if (absoluteMaxTimeout !== null) {
        window.clearTimeout(absoluteMaxTimeout);
        absoluteMaxTimeout = null;
      }
      if (stabilityTimer !== null) {
        window.clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }
      if (platformSettleTimer !== null) {
        window.clearTimeout(platformSettleTimer);
        platformSettleTimer = null;
      }
    };

    const scheduleWaitRetry = () => {
      if (waitRetryCount >= WAIT_RETRY_MAX) {
        this.logDebug('Wait retry limit reached', {
          waitRetryCount,
          messageKey: this.getElementKey(element)
        });
        cleanup();
        this.markProcessed(element, this.getElementKey(element));
        return;
      }

      waitRetryCount += 1;

      if (!waitRetryActive) {
        waitRetryActive = true;
        const logDetails = {
          normalized: this.normalizeText(element.textContent || ''),
          waitRetryCount
        };

        if ((waitRetryCount <= 3 || waitRetryCount % 10 === 0) && waitRetryCount !== lastLoggedWaitRetryCount) {
          lastLoggedWaitRetryCount = waitRetryCount;
          this.logDebug('Placeholder/streaming detected, waiting for final content', logDetails);
        }

        window.setTimeout(() => {
          waitRetryActive = false;
          finalizeIfReady();
        }, STABILITY_DELAY);
      }
    };

    const finalizeIfReady = () => {
      if (this.processedElements.has(element)) {
        return;
      }

      // If the settling generation has advanced since this waitForContent was
      // created, a navigation/settling restart happened.  This timer is stale
      // and must not produce a capture.
      if (this.settlingGeneration !== capturedGeneration) {
        this.traceFlow('waitForContent:staleGeneration', {
          key: this.getElementKey(element),
          capturedGen: capturedGeneration,
          currentGen: this.settlingGeneration
        });
        cleanup();
        this.markProcessed(element, this.getElementKey(element));
        return;
      }

      const text = element.textContent?.trim() || '';
      if (text.length >= 2) {
        const normalizedText = this.normalizeText(text);

        // Check for placeholder/status text across all platforms
        if (this.isPlaceholderText(normalizedText)) {
          this.traceFlow('waitForContent:placeholderBlocked', {
            text: normalizedText.substring(0, 80),
            waitRetryCount,
            platformSignalFired,
            key: this.getElementKey(element)
          });
          scheduleWaitRetry();
          return;
        }

        // ─── Claude element-level gate ───
        // Claude's thinking/notification text (e.g. "Contemplating, stand by...")
        // appears in DOM elements that have NO [data-is-streaming] ancestor.
        // Real responses ALWAYS have a [data-is-streaming] ancestor.
        // Only finalize when the element's container explicitly has
        // data-is-streaming="false" (streaming complete for THIS element).
        if (this.domain.includes('claude')) {
          const streamContainer = element.closest('[data-is-streaming]');
          if (!streamContainer) {
            // No streaming ancestor → thinking bubble / notification, not a response
            this.traceFlow('waitForContent:claudeNoStreamAncestor', {
              key: this.getElementKey(element),
              textPreview: normalizedText.substring(0, 60),
              waitRetryCount
            });
            scheduleWaitRetry();
            return;
          }
          if (streamContainer.getAttribute('data-is-streaming') === 'true') {
            // Still actively streaming
            this.traceFlow('waitForContent:claudeStillStreaming', {
              key: this.getElementKey(element),
              waitRetryCount
            });
            scheduleWaitRetry();
            return;
          }
          // data-is-streaming="false" → this element's response is complete
        }

        // Check platform-specific streaming signals (DOM attributes)
        // IMPORTANT: If the platform signal observer already fired, trust it
        // over the poll. ChatGPT's .streaming-animation class can persist on
        // other DOM elements after the response element finishes streaming,
        // causing isPlatformStreamingDone() to incorrectly return false.
        if (!platformSignalFired && this.isPlatformStreaming(element)) {
          this.traceFlow('waitForContent:streamingBlocked', {
            domain: this.domain,
            waitRetryCount,
            platformSignalFired,
            key: this.getElementKey(element)
          });
          scheduleWaitRetry();
          return;
        }

        if (!this.pendingPrompt && retryCount < PROMPT_WAIT_MAX_RETRIES) {
          retryCount += 1;
          this.logDebug('No pending prompt, retrying', {
            retryCount,
            textPreview: text.substring(0, 120)
          });
          window.setTimeout(finalizeIfReady, PROMPT_WAIT_RETRY_MS);
          return;
        }

        cleanup();
        const messageKey = this.getElementKey(element);
        // Final check after cleanup — content may have changed
        if (this.isPlaceholderText(normalizedText)) {
          scheduleWaitRetry();
          return;
        }

        this.logDebug('Response ready for extraction', {
          textLength: text.length,
          hasPrompt: Boolean(this.pendingPrompt),
          retries: retryCount,
          messageKey,
          triggeredBySignal: platformSignalFired
        });
        this.markProcessed(element, messageKey);
        this.traceFlow('waitForContent:ready', {
          threadId: this.getConversationId(),
          key: messageKey,
          textLength: text.length,
          retryCount,
          platformSignalFired
        });
        this.extractAndSaveMessage(element);
        waitRetryCount = 0;
      }
    };

    const scheduleStabilityCheck = (text: string) => {
      if (text.length < 2) {
        return;
      }

      lastStableText = text;

      if (stabilityTimer !== null) {
        window.clearTimeout(stabilityTimer);
      }

      stabilityTimer = window.setTimeout(() => {
        const currentText = element.textContent?.trim() || '';
        if (currentText.length < 2) {
          return;
        }

        if (currentText === lastStableText) {
          // For platforms WITH a signal, also check if streaming is done
          // before finalizing via text-stability.  If signal says still
          // streaming, reschedule — the signal callback will pick it up.
          const signalState = this.isPlatformStreamingDone();
          if (signalState === false) {
            this.traceFlow('waitForContent:stabilityWaitingForSignal', {
              key: this.getElementKey(element),
              textLength: currentText.length
            });
            scheduleStabilityCheck(currentText);
            return;
          }
          // signalState === true (done) or null (no signal) → finalize
          finalizeIfReady();
        } else {
          scheduleStabilityCheck(currentText);
        }
      }, STABILITY_DELAY);
    };

    const immediateText = element.textContent?.trim() || '';
    if (immediateText.length >= 2) {
      this.logDebug('Immediate text found', immediateText.substring(0, 120));
      scheduleStabilityCheck(immediateText);
    }

    // ── Text content MutationObserver (existing, unchanged logic) ──
    observer = new MutationObserver(() => {
      const text = element.textContent?.trim() || '';
      if (!text) {
        return;
      }

      if (text !== lastStableText) {
        this.logDebug('Mutation observed', text.substring(0, 120));
        scheduleStabilityCheck(text);

        // Reset the activity watchdog — LLM is still generating.
        // The absolute max timer (ABSOLUTE_MAX_WAIT_MS) is never reset.
        if (fallbackTimeout !== null) {
          window.clearTimeout(fallbackTimeout);
          // Throttle: only log watchdogReset when textLength changes by ≥20 chars.
          // Claude streams character-by-character, so a delta-1 threshold still
          // produces 100+ log lines per response.
          if (Math.abs(text.length - lastWatchdogLogLength) >= 20 || lastWatchdogLogLength === 0) {
            lastWatchdogLogLength = text.length;
            this.traceFlow('waitForContent:watchdogReset', {
              key: this.getElementKey(element),
              textLength: text.length
            });
          }
        }
        fallbackTimeout = window.setTimeout(() => {
          const fbText = (element.textContent || '').trim();
          const fbNormalized = this.normalizeText(fbText);
          this.logDebug('Fallback timeout hit (reset)', {
            textPreview: fbText.substring(0, 120),
            normalized: fbNormalized
          });
          if (!fbNormalized) {
            window.setTimeout(finalizeIfReady, STABILITY_DELAY);
            return;
          }
          if (this.isPlaceholderText(fbNormalized)) {
            scheduleWaitRetry();
            return;
          }
          finalizeIfReady();
        }, FALLBACK_DELAY);
      }
    });

    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true
    });

    fallbackTimeout = window.setTimeout(() => {
      const fallbackText = (element.textContent || '').trim();
      const normalizedText = this.normalizeText(fallbackText);
      this.logDebug('Fallback timeout hit', {
        textPreview: fallbackText.substring(0, 120),
        normalized: normalizedText
      });

      if (!normalizedText) {
        window.setTimeout(finalizeIfReady, STABILITY_DELAY);
        return;
      }

      if (this.isPlaceholderText(normalizedText)) {
        scheduleWaitRetry();
        return;
      }

      finalizeIfReady();
    }, FALLBACK_DELAY);

    // ── Platform "streaming done" signal observer ──
    // This is the PRIMARY finalization trigger for platforms with reliable signals.
    // When the signal fires, we wait PLATFORM_SETTLE_MS to let final DOM rendering
    // complete (LaTeX, tables, widgets) then try to finalize.
    // If finalizeIfReady() can't proceed (placeholder text, streaming still active),
    // the text-stability timer above continues as a fallback.
    platformSignalObserver = this.observePlatformDoneSignal(() => {
      if (platformSignalFired) return;  // debounce — process only the first signal
      platformSignalFired = true;

      this.traceFlow('waitForContent:platformSignalReceived', {
        key: this.getElementKey(element),
        textLength: element.textContent?.trim().length || 0
      });

      // Wait for final rendering to settle, then try to finalize
      platformSettleTimer = window.setTimeout(() => {
        this.traceFlow('waitForContent:platformSettleComplete', {
          key: this.getElementKey(element),
          textLength: element.textContent?.trim().length || 0
        });
        finalizeIfReady();
      }, PLATFORM_SETTLE_MS);
    });

    if (platformSignalObserver) {
      this.traceFlow('waitForContent:platformSignalActive', {
        domain: this.domain,
        key: this.getElementKey(element)
      });
    }

    // Absolute safety cap — never reset, ensures cleanup even if watchdog keeps resetting.
    absoluteMaxTimeout = window.setTimeout(() => {
      if (this.processedElements.has(element)) return;
      this.logDebug('Absolute max wait reached, forcing finalization', {
        textPreview: (element.textContent || '').substring(0, 120)
      });
      cleanup();
      const messageKey = this.getElementKey(element);
      this.markProcessed(element, messageKey);
      const absText = element.textContent?.trim() || '';
      if (absText.length >= 2 && !this.isPlaceholderText(this.normalizeText(absText))) {
        this.extractAndSaveMessage(element);
      }
    }, ABSOLUTE_MAX_WAIT_MS);
  }

  /**
   * Get message selectors based on platform
   */
  private getMessageSelectors(): string[] {
    const domain = this.domain;

    // ChatGPT / OpenAI
    // NOTE: .agent-turn was removed — it wraps [data-message-author-role="assistant"]
    // and caused duplicate turns (same text, two elements, two waitForContent chains).
    if (domain.includes('chatgpt') || domain.includes('openai')) {
      return [
        '[data-message-author-role="assistant"]'
      ];
    }

    // Claude
    // NOTE: data-is-streaming="false" was previously a selector here but caused
    // duplicate turns — it matches the same element as .font-claude-response.
    // Now it's used as a streaming-done SIGNAL in isPlatformStreamingDone().
    if (domain.includes('claude')) {
      return [
        '.font-claude-response'
      ];
    }

    // Gemini
    if (domain.includes('gemini')) {
      return [
        '.model-response-text',
        'message-content.model-response-text',
        '.model-response'
      ];
    }

    // Grok
    // NOTE: div[id^="response-"] was removed — it wraps .response-content-markdown
    // and caused duplicate turns.
    if (domain.includes('grok') || domain.includes('x.ai')) {
      return [
        'div[id^="response-"] .response-content-markdown'
      ];
    }

    // DeepSeek
    if (domain.includes('deepseek')) {
      return [
        '.ds-markdown',
        '.ds-message:not([class*="user"])'
      ];
    }

    // Generic fallback
    return this.getGenericAssistantSelectors();
  }

  private getGenericAssistantSelectors(): string[] {
    return [
      '[data-role*="assistant"]',
      '[data-author*="assistant"]'
    ];
  }

  /**
   * Extract and save message content
   */
  private extractAndSaveMessage(element: Element): void {
    const text = this.extractText(element);
    const currentThreadId = this.getConversationId();

    // ── DOM-settling guard ─────────────────────────────────────────────
    // After SPA navigation, captures are blocked until the DOM stops
    // mutating (adaptive settling).  This replaces the old fixed cooldown.
    if (this.isDomSettling) {
      this.traceFlow('extractAndSaveMessage:domSettling', {
        threadId: currentThreadId,
        textPreview: (text || '').substring(0, 80)
      });
      this.logDebug('Skipping capture while DOM is still settling');
      return;
    }

    // ── Thread-gate guard ──────────────────────────────────────────────
    // If this element was detected on a different thread (waitForContent
    // timer survived a navigation), discard it — UNLESS it matches the
    // pre-migration thread (new-chat URL redirect race).
    if (element instanceof HTMLElement && element.dataset.tbvDetectedThread) {
      if (element.dataset.tbvDetectedThread !== currentThreadId) {
        // Allow elements from the pre-migration thread within 15 s of migration.
        const MIGRATION_GRACE_MS = 15_000;
        const isMigratedThread =
          this.migratedFromThreadId !== null &&
          element.dataset.tbvDetectedThread === this.migratedFromThreadId &&
          (Date.now() - this.migratedFromThreadAt) < MIGRATION_GRACE_MS;

        if (!isMigratedThread) {
          this.traceFlow('extractAndSaveMessage:threadGate', {
            detectedThread: element.dataset.tbvDetectedThread,
            currentThread: currentThreadId,
            textPreview: (text || '').substring(0, 80)
          });
          this.logDebug('Discarding stale capture from different thread', {
            detectedThread: element.dataset.tbvDetectedThread,
            currentThread: currentThreadId
          });
          return;
        }

        // Element is from the pre-migration thread — allow it through.
        this.traceFlow('extractAndSaveMessage:threadGateMigrated', {
          detectedThread: element.dataset.tbvDetectedThread,
          migratedFrom: this.migratedFromThreadId,
          currentThread: currentThreadId
        });
      }
    }

    this.traceFlow('extractAndSaveMessage:start', {
      threadId: currentThreadId,
      textLength: text?.length || 0,
      hasPendingPrompt: Boolean(this.pendingPrompt),
      pendingPromptThreadId: this.pendingPrompt?.threadId || null
    });

    if (!text || text.length < 2) {
      this.logDebug('Extracted text too short', text);
      return;
    }

    const normalizedResponse = this.normalizeText(text);

    if (normalizedResponse) {
      const recentPromptIndex = this.recentPrompts.findIndex((entry) => entry.text === normalizedResponse);
      if (recentPromptIndex !== -1) {
        this.logDebug('Skipping element matching recent prompt history', {
          matchIndex: recentPromptIndex,
          textPreview: normalizedResponse.substring(0, 120)
        });
        this.recentPrompts.splice(recentPromptIndex, 1);
        return;
      }
    }

    if (this.pendingPrompt) {
      const normalizedPrompt = this.normalizeText(this.pendingPrompt.text);
      if (normalizedPrompt && normalizedResponse && normalizedPrompt === normalizedResponse) {
        this.logDebug('Skipping element identical to prompt', {
          promptPreview: normalizedPrompt.substring(0, 120),
          elementTag: element.tagName
        });
        const index = this.recentPrompts.findIndex((entry) => entry.text === normalizedPrompt);
        if (index !== -1) {
          this.recentPrompts.splice(index, 1);
        }
        return;
      }
    }

    // Check if this is a response to a pending prompt
    const pendingPromptMatchesThread = Boolean(this.pendingPrompt)
      && (
        this.pendingPrompt!.threadId === currentThreadId
        || this.canMapFallbackPromptThreadToCurrentThread(this.pendingPrompt!.threadId, currentThreadId)
      );

    if (
      this.pendingPrompt
      && pendingPromptMatchesThread
      && Date.now() - this.pendingPrompt.timestamp < 600_000
    ) {
      const responseTime = Date.now() - this.pendingPrompt.timestamp;
      const threadId = currentThreadId;
      const promptTs = this.pendingPrompt.timestamp;
      const responseTs = Date.now();
      const turn: ConversationTurn = {
        id: `${responseTs}-turn`,
        ts: responseTs,
        responseTimeMs: responseTime,
        prompt: {
          text: this.pendingPrompt.text,
          textLength: this.pendingPrompt.text.length,
          ts: promptTs
        },
        response: {
          text,
          textLength: text.length,
          ts: responseTs
        }
      };

      this.upsertTurnsToBackground(threadId, [turn]);
      this.traceFlow('extractAndSaveMessage:pairedTurn', {
        threadId,
        promptLength: turn.prompt.textLength,
        responseLength: turn.response.textLength,
        responseTimeMs: responseTime
      });
      this.logDebug('Turn constructed', {
        promptPreview: turn.prompt.text.substring(0, 120),
        responsePreview: turn.response.text.substring(0, 120),
        responseTime
      });
      const normalizedPrompt = this.normalizeText(this.pendingPrompt.text);
      if (normalizedPrompt) {
        const index = this.recentPrompts.findIndex((entry) => entry.text === normalizedPrompt);
        if (index !== -1) {
          this.recentPrompts.splice(index, 1);
        }
      }

      // Track the consumed prompt so duplicate inferred turns can be detected.
      this.lastConsumedPromptText = normalizedPrompt || this.normalizeText(this.pendingPrompt!.text);
      this.lastConsumedPromptAt = Date.now();

      this.pendingPrompt = null;

      // Clear persisted prompt now that it has been successfully consumed.
      try { chrome.storage.session.remove('tbvPendingPrompt'); } catch { /* non-fatal */ }
    } else {
      // Cold-load safety: if no prompt interaction was captured recently,
      // do not infer prompt/response pairs from historical DOM.
      const RECENT_PROMPT_WINDOW_MS = 600_000;
      const RECENT_INTERACTION_WINDOW_MS = 600_000;
      const latestPromptSignalAt = Math.max(this.lastPromptCapturedAt, this.lastPromptIntentAt);
      const hasRecentPromptIntent = latestPromptSignalAt > 0
        && (Date.now() - latestPromptSignalAt) <= RECENT_PROMPT_WINDOW_MS;
      const hasRecentUserInteraction = this.lastUserInteractionAt > 0
        && (Date.now() - this.lastUserInteractionAt) <= RECENT_INTERACTION_WINDOW_MS;
      const lastPromptThreadId = this.lastPromptThreadId;
      const isPromptThreadCompatible = Boolean(lastPromptThreadId)
        && (
          lastPromptThreadId === currentThreadId
          || this.canMapFallbackPromptThreadToCurrentThread(lastPromptThreadId!, currentThreadId)
        );

      if (!hasRecentPromptIntent || !hasRecentUserInteraction || !isPromptThreadCompatible) {
        this.logDebug('Skipping inferred turn on cold load (no recent prompt intent)', {
          elementTag: element.tagName,
          textPreview: (text || '').substring(0, 120),
          hasRecentPromptIntent,
          hasRecentUserInteraction,
          isPromptThreadCompatible,
          currentThreadId,
          lastPromptThreadId: this.lastPromptThreadId
        });
        return;
      }

      // Fallback: derive prompt text from DOM when prompt submission capture fails.
      const inferredPromptElement = this.findNearestUserMessageElement(element);
      const inferredPromptText = inferredPromptElement ? this.extractText(inferredPromptElement) : '';
      const normalizedInferredPrompt = this.normalizeText(inferredPromptText);

      if (normalizedInferredPrompt && normalizedInferredPrompt.length >= 2) {
        // ── Duplicate-inferred-turn guard ────────────────────────
        // When ChatGPT uses web search it renders MULTIPLE assistant
        // elements for a single prompt.  The first one consumes
        // pendingPrompt (paired turn); the second arrives with no
        // pending prompt and falls here.  If the inferred prompt text
        // matches the one we just consumed within 30 s, skip it.
        const DUPLICATE_INFERRED_WINDOW_MS = 30_000;
        if (
          this.lastConsumedPromptText
          && this.lastConsumedPromptAt > 0
          && (Date.now() - this.lastConsumedPromptAt) < DUPLICATE_INFERRED_WINDOW_MS
          && normalizedInferredPrompt === this.lastConsumedPromptText
        ) {
          this.traceFlow('extractAndSaveMessage:skippedDuplicateInferred', {
            threadId: currentThreadId,
            promptPreview: inferredPromptText.substring(0, 80)
          });
          return;
        }

        const threadId = currentThreadId;
        const responseTs = Date.now();
        const promptTs = responseTs;

        // Avoid creating degenerate turns where prompt equals response.
        if (this.normalizeText(text) !== normalizedInferredPrompt) {
          const turn: ConversationTurn = {
            id: `${responseTs}-turn`,
            ts: responseTs,
            prompt: {
              text: inferredPromptText,
              textLength: inferredPromptText.length,
              ts: promptTs,
              meta: { inferred: true }
            },
            response: {
              text,
              textLength: text.length,
              ts: responseTs
            }
          };

          this.upsertTurnsToBackground(threadId, [turn]);
          this.traceFlow('extractAndSaveMessage:inferredTurn', {
            threadId,
            promptLength: turn.prompt.textLength,
            responseLength: turn.response.textLength
          });
          this.logDebug('Turn constructed (inferred prompt)', {
            promptPreview: turn.prompt.text.substring(0, 120),
            responsePreview: turn.response.text.substring(0, 120)
          });
          return;
        }
      }

      this.logDebug('No pending prompt to pair with response');
    }
  }

  /**
   * Handle user prompt submission
   */
  private handlePrompt(promptText: string): void {
    this.logDebug('Prompt stored', promptText.substring(0, 120));
    const timestamp = Date.now();
    const threadId = this.getConversationId();
    this.lastPromptCapturedAt = timestamp;
    this.lastPromptThreadId = threadId;

    // If the user is actively sending a prompt the page is loaded enough to
    // interact with — immediately finish DOM settling so the response gets captured.
    if (this.isDomSettling) {
      this.traceFlow('handlePrompt:earlySettle', { threadId });
      this.finishDomSettling();
    }

    this.pendingPrompt = {
      text: promptText,
      timestamp,
      threadId
    };
    this.traceFlow('handlePrompt:stored', {
      threadId,
      promptLength: promptText.length,
      promptPreview: promptText.substring(0, 80)
    });

    // Persist prompt to chrome.storage.session so it survives full-page
    // navigations (e.g. ChatGPT/Claude/Grok new-chat redirects).
    try {
      chrome.storage.session.set({
        tbvPendingPrompt: {
          text: promptText,
          timestamp,
          domain: this.domain
        }
      });
    } catch {
      // non-fatal — storage may not be available in all contexts
    }

    const normalized = this.normalizeText(promptText);
    if (normalized) {
      this.recentPrompts.push({ text: normalized, timestamp });
      if (this.recentPrompts.length > 50) {
        this.recentPrompts.splice(0, this.recentPrompts.length - 50);
      }
    }

    this.pruneRecentPrompts(timestamp);
  }

  private capturePromptFromUserElement(element: Element): void {
    const text = this.extractText(element);
    const normalized = this.normalizeText(text);
    if (!normalized || normalized.length < 2) {
      return;
    }

    const now = Date.now();
    const RECENT_WINDOW_MS = 30_000;
    const hasRecentIntent = this.lastPromptIntentAt > 0 && (now - this.lastPromptIntentAt) <= RECENT_WINDOW_MS;
    const threadId = this.getConversationId();
    const lastPromptThreadId = this.lastPromptThreadId;
    const intentMatchesThread = Boolean(lastPromptThreadId)
      && (
        lastPromptThreadId === threadId
        || this.canMapFallbackPromptThreadToCurrentThread(lastPromptThreadId!, threadId)
      );

    // Only capture user DOM prompts when we have recent prompt intent tied to this thread.
    // This prevents passive navigation/opening old chats from creating inferred turns.
    if (!hasRecentIntent || !intentMatchesThread) {
      return;
    }

    if (this.pendingPrompt) {
      const sameText = this.normalizeText(this.pendingPrompt.text) === normalized;
      const sameThread = this.pendingPrompt.threadId === threadId
        || this.canMapFallbackPromptThreadToCurrentThread(this.pendingPrompt.threadId, threadId);
      const freshPending = (now - this.pendingPrompt.timestamp) <= RECENT_WINDOW_MS;
      if (sameText && sameThread && freshPending) {
        return;
      }
    }

    this.lastPromptCapturedAt = now;
    this.lastPromptThreadId = threadId;
    this.pendingPrompt = {
      text,
      timestamp: now,
      threadId
    };
    this.traceFlow('capturePromptFromUserElement:stored', {
      threadId,
      promptLength: text.length,
      promptPreview: normalized.substring(0, 80)
    });

    this.recentPrompts.push({ text: normalized, timestamp: now });
    if (this.recentPrompts.length > 50) {
      this.recentPrompts.splice(0, this.recentPrompts.length - 50);
    }
    this.pruneRecentPrompts(now);

    this.logDebug('Prompt captured from user DOM message', {
      threadId,
      promptPreview: normalized.substring(0, 120)
    });
  }

  /**
   * Extract text content from element
   */
  private extractText(element: Element): string {
    // Remove code blocks and other non-text elements for cleaner extraction
    const clone = element.cloneNode(true) as Element;

    // Remove script and style elements
    clone.querySelectorAll('script, style').forEach(el => el.remove());

    if (this.isGeminiDomain()) {
      clone.querySelectorAll('button, [role="button"], [data-test-id*="thinking"], [data-testid*="thinking"]').forEach(el => el.remove());
    }

    let text = clone.textContent?.trim() || '';

    if (this.isGeminiDomain()) {
      text = this.cleanGeminiText(text);
    }

    if (this.domain.includes('chatgpt') || this.domain.includes('openai')) {
      text = text
        .replace(/^\s*chatgpt\s+said:\s*/i, '')
        .replace(/\s*is this conversation helpful so far\?\s*$/i, '')
        .replace(/\s*do you like this personality\?\s*$/i, '')
        .trim();
    }

    return text;
  }

  /**
   * Get conversation title (if available)
   */
  private getConversationTitle(): string | undefined {
    // Try to find conversation title in common locations
    const selectors = [
      'h1',
      '[class*="title"]',
      '[class*="conversation-name"]',
      'header h2'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent) {
        return element.textContent.trim();
      }
    }

    return undefined;
  }

  // /**
  //  * Count messages in current conversation
  //  */
  // private getMessageCount(): number {
  //   const selectors = this.getMessageSelectors();
  //   let count = 0;

  //   for (const selector of selectors) {
  //     count += document.querySelectorAll(selector).length;
  //   }

  //   return count;
  // }

  /**
   * Send conversation log to background script
   */
  private async upsertTurnsToBackground(threadId: string, turns: ConversationTurn[]): Promise<void> {
    try {
      this.traceFlow('upsertTurnsToBackground:start', {
        threadId,
        turnCount: turns.length,
        firstPromptLength: turns[0]?.prompt?.textLength ?? 0,
        firstResponseLength: turns[0]?.response?.textLength ?? 0
      });
      const threadInfo: Partial<ConversationLog> = {
        id: threadId,
        url: window.location.href,
        domain: this.domain,
        platform: this.getPlatformName(),
        title: this.getConversationTitle(),
        // metadata: {
        //   messageCount: this.getMessageCount()
        // }
      };
      await this.sendMessageToBackground({
        type: 'UPSERT_CONVERSATION_TURNS',
        data: { threadId, threadInfo, turns }
      });

      // Notify content script that a chat turn was actually recorded.
      // This is used to lazily reveal popup UI after first real activity.
      try {
        window.dispatchEvent(new CustomEvent('tbv:chat-activity'));
      } catch {
        // non-fatal
      }

      this.logDebug('Turns upserted', { threadId, count: turns.length });
      this.traceFlow('upsertTurnsToBackground:success', {
        threadId,
        count: turns.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.toLowerCase().includes('extension context invalidated')
      ) {
        this.extensionContextInvalidated = true;
        console.debug('[TrustButVerify] Extension context invalidated; disabling further turn upserts');
        return;
      }

      console.error('[TrustButVerify] Error upserting turns:', error);
      this.traceFlow('upsertTurnsToBackground:error', {
        threadId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private getPlatformName(): string | undefined {
    const d = this.domain;
    if (d.includes('chatgpt') || d.includes('openai')) return 'ChatGPT';
    if (d.includes('gemini')) return 'Gemini';
    if (d.includes('grok') || d.includes('x.ai')) return 'Grok';
    if (d.includes('claude')) return 'Claude';
    if (d.includes('deepseek')) return 'DeepSeek';
    return undefined;
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Generate session ID based on URL and timestamp
   */
  // sessionId removed: conversation continuity now keyed by deterministic threadId

  /**
   * Conditional debug logger to keep console clean in production
   */
  private logDebug(message: string, detail?: unknown): void {
    if (!this.isDebugEnabled()) {
      return;
    }

    if (detail !== undefined) {
      console.debug('[TrustButVerify]', message, detail);
    } else {
      console.debug('[TrustButVerify]', message);
    }
  }

  private isDebugEnabled(): boolean {
    try {
      const windowFlag = (window as unknown as { __TBV_DEBUG__?: boolean }).__TBV_DEBUG__;
      if (windowFlag) {
        return true;
      }

      const docFlag = document.documentElement?.getAttribute('data-tbv-debug');
      if (docFlag && docFlag.toLowerCase() === 'true') {
        return true;
      }

      const storageFlag = window.localStorage?.getItem('TBV_DEBUG');
      if (storageFlag && storageFlag.toLowerCase() === 'true') {
        return true;
      }
    } catch (error) {
      // Ignore errors accessing debug flags
    }

    return false;
  }

  private isUserAuthoredElement(element: Element): boolean {
    const selectors = this.getUserMessageSelectors();
    return selectors.some((selector) => {
      if (!selector) {
        return false;
      }

      try {
        return element.matches(selector) || Boolean(element.closest(selector));
      } catch (error) {
        return false;
      }
    });
  }

  private getUserMessageSelectors(): string[] {
    const domain = this.domain;

    if (domain.includes('chatgpt') || domain.includes('openai')) {
      return [
        '[data-message-author-role="user"]',
        '[class*="user-turn"]',
        '[class*="UserMessage"]',
        '[class*="userMessage"]'
      ];
    }

    if (domain.includes('grok') || domain.includes('x.ai')) {
      return [
        '[data-testid="user-message"]',
        '[class*="userMessage"]',
        '[class*="user-bubble"]',
        '[class*="userBubble"]',
        'div[id^="response-"].items-end'
      ];
    }

    if (domain.includes('deepseek')) {
      return [
        '[data-role="user"]',
        '[class*="message-user"]',
        '[class*="user-message"]',
        '[data-testid*="user-message"]',
        '.message-content[data-role="user"]',
        '[class*="user"]:not([class*="assistant"])'
      ];
    }

    if (domain.includes('gemini')) {
      return [
        '[data-test-id*="user" i]',
        '[data-testid*="user" i]',
        '[class*="user" i]',
        '[class*="query" i]',
        '[role="article"] [role="heading"]'
      ];
    }

    if (domain.includes('claude')) {
      return [
        '[class*="HumanMessage"]',
        '[data-testid*="human" i]',
        '[class*="human" i]',
        '[data-role="user"]',
        '[data-testid="user-message"]'
      ];
    }

    return [
      '[data-role="user"]',
      '[data-author="user"]',
      '[class*="user-message"]',
      '[class*="userBubble"]',
      '[class*="user-turn"]',
      '[class*="message--user"]'
    ];
  }

  private pruneRecentPrompts(currentTime: number): void {
    const MAX_AGE_MS = 5 * 60 * 1000;
    const cutoff = currentTime - MAX_AGE_MS;

    while (this.recentPrompts.length > 0 && this.recentPrompts[0].timestamp < cutoff) {
      this.recentPrompts.shift();
    }
  }

  private getElementKey(element: Element): string | undefined {
    if (element instanceof HTMLElement) {
      const datasetKey = element.dataset.tbvKey;
      if (datasetKey) {
        return datasetKey;
      }
    }

    return this.getMessageKey(element);
  }

  private getMessageKey(element: Element): string | undefined {
    if (!(element instanceof HTMLElement)) {
      return undefined;
    }

    const threadScope = this.getConversationId();

    const id = element.id?.trim();
    if (id) {
      return `${threadScope}::${id}`;
    }

    const dataMessageId = element.getAttribute('data-message-id')?.trim();
    if (dataMessageId) {
      return `${threadScope}::${dataMessageId}`;
    }

    const dataMessageUuid = element.getAttribute('data-message-uuid')?.trim();
    if (dataMessageUuid) {
      return `${threadScope}::${dataMessageUuid}`;
    }

    // data-testid is frequently the same for many messages (e.g. "assistant-message").
    // Only use it when it's unique in the DOM.
    const testId = element.getAttribute('data-testid')?.trim();
    if (testId) {
      try {
        const escaped = (globalThis as unknown as { CSS?: { escape?: (value: string) => string } }).CSS?.escape
          ? (globalThis as unknown as { CSS: { escape: (value: string) => string } }).CSS.escape(testId)
          : testId.replace(/[^a-zA-Z0-9_-]/g, '');
        const matches = escaped ? document.querySelectorAll(`[data-testid="${escaped}"]`).length : 0;
        if (matches === 1) {
          return `${threadScope}::${testId}`;
        }
      } catch {
        // ignore
      }
    }

    const text = this.normalizeText(element.textContent || '');
    if (text.length >= 4) {
      const sample = text.substring(0, 500);
      const hash = this.hashText(sample);
      return `${threadScope}::t${hash.toString(36)}::${text.length}`;
    }

    return undefined;
  }

  private hashText(text: string): number {
    // FNV-1a 32-bit
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  private safeMatches(element: Element, selector: string): boolean {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  }

  private findNearestUserMessageElement(from: Element): Element | null {
    const selectors = this.getUserMessageSelectors().filter(Boolean);
    if (!selectors.length) {
      return null;
    }

    const isUser = (el: Element): boolean => selectors.some((sel) => this.safeMatches(el, sel));

    // Walk up a few levels, scanning previous siblings for a user message.
    let cursor: Element | null = from;
    for (let depth = 0; depth < 8 && cursor; depth += 1) {
      let sib: Element | null = cursor.previousElementSibling;
      while (sib) {
        if (isUser(sib)) {
          return sib;
        }

        // Also check inside sibling subtree (common when message wrapper differs).
        for (const sel of selectors) {
          try {
            const found = sib.querySelector(sel);
            if (found) {
              return found;
            }
          } catch {
            // ignore invalid selector
          }
        }

        sib = sib.previousElementSibling;
      }

      cursor = cursor.parentElement;
    }

    return null;
  }

  private markProcessed(element: Element, messageKey?: string): void {
    this.processedElements.add(element);

    if (messageKey) {
      this.registerProcessedKey(messageKey);
    }

    if (element instanceof HTMLElement && messageKey) {
      element.dataset.tbvKey = messageKey;
    }
  }

  private registerProcessedKey(messageKey: string): void {
    if (this.processedMessageKeys.has(messageKey)) {
      return;
    }

    this.processedMessageKeys.add(messageKey);
    this.processedMessageKeyQueue.push(messageKey);

    if (this.processedMessageKeyQueue.length > 500) {
      const oldest = this.processedMessageKeyQueue.shift();
      if (oldest) {
        this.processedMessageKeys.delete(oldest);
      }
    }
  }

  private isGeminiDomain(): boolean {
    return this.domain.includes('gemini');
  }

  private isChatGPTDomain(): boolean {
    return this.domain.includes('chatgpt') || this.domain.includes('openai');
  }

  /**
   * When starting a brand-new Grok chat, prompt capture can happen before URL
   * changes to /c/<id>. In that case prompt threadId is the fallback hash and
   * response threadId is the concrete /c/<id> id. Treat them as compatible once.
   */
  private canMapFallbackPromptThreadToCurrentThread(
    promptThreadId: string,
    currentThreadId: string
  ): boolean {
    // Only allow fallback→concrete mapping within 10s of the last prompt capture.
    // This prevents stale home-page fallback hashes from mapping to any thread.
    const MAX_MAPPING_AGE_MS = 10_000;
    if (!this.lastPromptCapturedAt || (Date.now() - this.lastPromptCapturedAt) > MAX_MAPPING_AGE_MS) {
      return false;
    }

    const promptDomain = (promptThreadId.split('::')[0] || '').trim();
    const currentDomain = (currentThreadId.split('::')[0] || '').trim();
    if (!promptDomain || !currentDomain || promptDomain !== currentDomain) {
      return false;
    }

    const promptPart = (promptThreadId.split('::')[1] || '').trim();
    const currentPart = (currentThreadId.split('::')[1] || '').trim();

    const isPromptFallback = promptPart === 'unknown' || /^h[0-9a-z]+$/i.test(promptPart);
    const isCurrentConcrete = Boolean(currentPart)
      && currentPart !== 'unknown'
      && !/^h[0-9a-z]+$/i.test(currentPart);

    return isPromptFallback && isCurrentConcrete;
  }

  /**
   * Detect transient placeholder/status text across all LLM platforms.
   * Returns true if the text looks like a temporary status message rather
   * than a real response.  Used by waitForContent to keep waiting.
   */
  private isPlaceholderText(text: string): boolean {
    if (!text) {
      return true;
    }

    const normalized = text
      .toLowerCase()
      .replace(/\u2026/g, '...')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return true;
    }

    if (normalized === '...') {
      return true;
    }

    const placeholderPhrases = new Set([
      // Gemini
      'just a second',
      'one moment',
      'one sec',
      'just a moment',
      'give me a moment',
      'show thinking',
      'gemini said',
      'you said',
      // Claude
      'pondering, stand by...',
      'pondering stand by...',
      'pondering, stand by',
      'pondering stand by',
      'ruminating on it, stand by...',
      'ruminating on it stand by...',
      'ruminating on it, stand by',
      'ruminating on it stand by',
      'ruminating on it...',
      'ruminating on it',
      'mulling it over, stand by...',
      'mulling it over stand by...',
      'mulling it over, stand by',
      'mulling it over stand by',
      'mulling it over...',
      'mulling it over',
      'searched the web',
      'searching the web',
      'searching',
      'scanning',
      'analyzing',
      'analyzing...',
      // ChatGPT
      'browsing the web',
      'searching the web...',
      'searching...',
      'thought for',
      'thinkinganswer now',
      'answer now',
      'ranking the contenders',
      'ranking the contenders...',
      // DeepSeek
      'deep thinking',
      'deep thinking...',
      // Cross-platform
      'thinking',
      'thinking...',
      'loading',
      'loading...',
    ]);

    if (placeholderPhrases.has(normalized)) {
      return true;
    }

    // Strip known prefixes and re-check — handles composite text like
    // "Show thinking\nJust a second" on Gemini.
    const stripped = normalized
      .replace(/^show thinking/, '')
      .replace(/^searched the web/, '')
      .replace(/^thought for[^]*/, '')  // "thought for 30 seconds" etc.
      .replace(/^thinkinganswer now/, '')
      .replace(/^answer now/, '')
      .replace(/^ranking the contenders\.{0,3}/, '')
      .replace(/^gemini said/, '')
      .replace(/^you said/, '')
      .replace(/^just a second/, '')
      .replace(/^thinking\.{0,3}/, '')
      .replace(/^loading\.{0,3}/, '')
      .replace(/^one moment/, '')
      .replace(/^one sec/, '')
      .replace(/^just a moment/, '')
      .replace(/^give me a moment/, '')
      .replace(/^pondering,? stand by\.{0,3}/, '')
      .replace(/^ruminating on it,? stand by\.{0,3}/, '')
      .replace(/^ruminating on it\.{0,3}/, '')
      .replace(/^mulling it over,? stand by\.{0,3}/, '')
      .replace(/^mulling it over\.{0,3}/, '')
      .replace(/^search(ing|ed) the web\.{0,3}/, '')
      .replace(/^browsing the web\.{0,3}/, '')
      .replace(/^scanning\.{0,3}/, '')
      .replace(/^analyzing\.{0,3}/, '')
      .replace(/^deep thinking\.{0,3}/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!stripped) {
      return true;
    }

    if (placeholderPhrases.has(stripped)) {
      return true;
    }

    return false;
  }

  /**
   * Check platform-specific DOM signals to determine if the LLM is still
   * actively streaming/generating.  This supplements text-based placeholder
   * detection with structural DOM checks.
   */
  private isPlatformStreaming(element: Element): boolean {
    const done = this.isPlatformStreamingDone();
    if (done === false) return true;   // platform confirms still streaming
    if (done === true) return false;   // platform confirms done

    // Legacy element-level checks as fallback
    if (this.domain.includes('claude')) {
      const container = element.closest('[data-is-streaming]');
      if (container?.getAttribute('data-is-streaming') === 'true') {
        return true;
      }
    }
    if (this.domain.includes('chatgpt') || this.domain.includes('openai')) {
      if (element.closest('.result-streaming') || element.querySelector('.result-streaming')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Poll-based check: is the platform's streaming-done signal present NOW?
   * Returns true  = confirmed done.
   * Returns false = confirmed still streaming.
   * Returns null  = this platform has no reliable signal (use timer).
   */
  private isPlatformStreamingDone(): boolean | null {
    const domain = this.domain;

    // Claude: data-is-streaming attribute on response container
    if (domain.includes('claude')) {
      const el = document.querySelector('[data-is-streaming]');
      if (!el) return null;  // no streaming element exists yet
      return el.getAttribute('data-is-streaming') === 'false';
    }

    // ChatGPT: stop button removed = done
    if (domain.includes('chatgpt') || domain.includes('openai')) {
      const stopBtn = document.querySelector('button[data-testid="stop-button"]');
      if (stopBtn) return false;  // stop button present = still streaming
      // Secondary: streaming-animation class on response div
      const streamingDiv = document.querySelector('.streaming-animation');
      if (streamingDiv) return false;
      // No stop button and no streaming class = done (or not started)
      // Check if send button is present as confirmation
      const sendBtn = document.querySelector('button[data-testid="send-button"]');
      return sendBtn !== null ? true : null;
    }

    // Gemini: send button label toggles "Stop response" ↔ "Send message"
    if (domain.includes('gemini')) {
      const stopBtn = document.querySelector('button[aria-label="Stop response"]');
      if (stopBtn) return false;
      const sendBtn = document.querySelector('button[aria-label="Send message"]');
      return sendBtn !== null ? true : null;
    }

    // Grok: stop button present vs voice mode button present
    if (domain.includes('grok') || domain.includes('x.ai')) {
      const stopBtn = document.querySelector('button[aria-label="Stop model response"]');
      if (stopBtn) return false;
      const voiceBtn = document.querySelector('button[aria-label*="Enter voice mode"]');
      return voiceBtn !== null ? true : null;
    }

    // DeepSeek and unknown: no reliable signal
    return null;
  }

  /**
   * Event-based observer: watches for the platform-specific "streaming done"
   * signal and calls onDone() once when it fires.
   * Returns the MutationObserver (for cleanup), or null if no signal available.
   */
  private observePlatformDoneSignal(onDone: () => void): MutationObserver | null {
    const domain = this.domain;
    let doneObserver: MutationObserver;

    // ─── Claude: data-is-streaming attribute change to "false" ───
    if (domain.includes('claude')) {
      doneObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'data-is-streaming') {
            const el = m.target as Element;
            if (el.getAttribute('data-is-streaming') === 'false') {
              this.traceFlow('platformSignal:done', {
                platform: 'claude',
                signal: 'data-is-streaming=false'
              });
              // Disconnect immediately to prevent repeated fires for all
              // existing [data-is-streaming="false"] elements in the conversation
              doneObserver.disconnect();
              onDone();
              return;
            }
          }
        }
      });
      doneObserver.observe(document.body, {
        attributes: true,
        subtree: true,
        attributeFilter: ['data-is-streaming']
      });
      return doneObserver;
    }

    // ─── ChatGPT: stop button removed OR streaming-animation class removed ───
    if (domain.includes('chatgpt') || domain.includes('openai')) {
      doneObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          // Stop button removed from DOM
          if (m.type === 'childList') {
            for (const node of Array.from(m.removedNodes)) {
              if (node instanceof Element) {
                if (node.getAttribute?.('data-testid') === 'stop-button' ||
                    node.querySelector?.('[data-testid="stop-button"]')) {
                  this.traceFlow('platformSignal:done', {
                    platform: 'chatgpt',
                    signal: 'stop-button-removed'
                  });
                  onDone();
                  return;
                }
              }
            }
          }
          // streaming-animation class removed
          if (m.type === 'attributes' && m.attributeName === 'class') {
            const el = m.target as Element;
            const oldVal = m.oldValue || '';
            const newVal = el.className || '';
            if (oldVal.includes('streaming-animation') && !newVal.includes('streaming-animation')) {
              this.traceFlow('platformSignal:done', {
                platform: 'chatgpt',
                signal: 'streaming-animation-removed'
              });
              onDone();
              return;
            }
          }
        }
      });
      doneObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class']
      });
      return doneObserver;
    }

    // ─── Gemini: aria-label changes from "Stop response" to "Send message" ───
    if (domain.includes('gemini')) {
      doneObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'aria-label') {
            const el = m.target as Element;
            const oldVal = m.oldValue || '';
            const newVal = el.getAttribute('aria-label') || '';
            if (oldVal === 'Stop response' && newVal === 'Send message') {
              this.traceFlow('platformSignal:done', {
                platform: 'gemini',
                signal: 'stop-to-send'
              });
              onDone();
              return;
            }
          }
        }
      });
      doneObserver.observe(document.body, {
        attributes: true,
        subtree: true,
        attributeOldValue: true,
        attributeFilter: ['aria-label']
      });
      return doneObserver;
    }

    // ─── Grok: voice mode button appears (replaces stop button) ───
    // Check both the added node itself AND its descendants, because
    // the button may appear inside a container element.
    if (domain.includes('grok') || domain.includes('x.ai')) {
      doneObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'childList') {
            for (const node of Array.from(m.addedNodes)) {
              if (node instanceof Element) {
                // Check the added node itself
                const label = node.getAttribute?.('aria-label') || '';
                if (label.includes('Enter voice mode')) {
                  this.traceFlow('platformSignal:done', {
                    platform: 'grok',
                    signal: 'voice-mode-button-added'
                  });
                  onDone();
                  return;
                }
                // Also search descendants of the added node
                const voiceBtn = node.querySelector?.('button[aria-label*="Enter voice mode"]');
                if (voiceBtn) {
                  this.traceFlow('platformSignal:done', {
                    platform: 'grok',
                    signal: 'voice-mode-button-added-descendant'
                  });
                  onDone();
                  return;
                }
              }
            }
          }
        }
      });
      doneObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
      return doneObserver;
    }

    // DeepSeek / unknown: no signal available
    return null;
  }

  private cleanGeminiText(text: string): string {
    let cleaned = text
      .replace(/^\s*gemini said\s*/i, ' ')
      .replace(/^\s*you said\s*/i, ' ')
      .replace(/Show thinking/gi, ' ')
      .replace(/Just a second(?:\u2026|\.\.\.)?/gi, ' ')
      .replace(/\s{2,}/g, ' ');

    return cleaned.trim();
  }

  private normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
}
