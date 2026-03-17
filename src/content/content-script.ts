import type {
  CopyActivity,
  CopyActivityTrigger,
  NudgeAnswerMode,
  NudgeTriggerType
} from '../types';
import { ConversationDetector } from '../utils/conversation-detector';
import {
  NudgeOverlay,
  type NudgeOverlayPayload,
  type NudgeOverlayResolution,
  type NudgeOverlayPosition
} from './nudge-overlay';

/**
 * Content script that tracks copy events and conversations on LLM/Gen AI websites
 */
class ActivityTracker {
  private readonly domain: string;
  private conversationDetector: ConversationDetector;
  private nudgeOverlay: NudgeOverlay | null = null;
  private lastInteractedElement: HTMLElement | null = null;
  private extensionContextInvalidated = false;
  private readonly copySignatureCache = new Map<string, number>();
  private readonly nudgeEventIdCollisions = new Map<string, number>();
  private static readonly COPY_SIGNATURE_TTL = 2500;
  private static readonly PROGRAMMATIC_COPY_MESSAGE = 'TBV_PROGRAMMATIC_COPY';
  private static readonly MAX_CONTAINER_TEXT_CHARS = 20000;
  private static readonly MAX_PAIRED_PROMPT_CHARS = 20000;
  private static readonly CHAT_ACTIVITY_EVENT = 'tbv:chat-activity';
  private static readonly NUDGE_TIMEOUT_MS = 60_000;

  private readonly handleRuntimeMessage = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): boolean | void => {
    const payload = (message || {}) as {
      type?: string;
      data?: {
        questionId?: string;
        questionText?: string;
        answerMode?: NudgeAnswerMode;
        triggerType?: NudgeTriggerType;
        conversationId?: string;
        turnId?: string;
        copyActivityId?: string;
        timeoutMs?: number;
        position?: NudgeOverlayPosition;
        ratingLabels?: { low: string; high: string };
        yesLabel?: string;
        questionTags?: string[];
      };
    };

    if (!payload?.type) {
      return;
    }

    if (payload.type === 'SHOW_NUDGE' || payload.type === 'TBV_SHOW_NUDGE') {
      // Only handle nudge messages in the top frame to avoid invisible iframe overlays
      if (window.top !== window.self) {
        return;
      }

      const data = payload.data;
      if (!data || !data.questionId || !data.questionText || !data.answerMode || !data.triggerType) {
        console.warn('[TrustButVerify] Invalid nudge payload:', data);
        sendResponse({ success: false, error: 'Invalid nudge payload' });
        return;
      }

      this.showNudgeOverlay({
        questionId: data.questionId,
        questionText: data.questionText,
        answerMode: data.answerMode,
        triggerType: data.triggerType,
        conversationId: data.conversationId,
        turnId: data.turnId,
        copyActivityId: data.copyActivityId,
        timeoutMs: data.timeoutMs,
        position: data.position,
        ratingLabels: data.ratingLabels,
        yesLabel: data.yesLabel,
        questionTags: data.questionTags
      });
      sendResponse({ success: true });
      return;
    }

    if (payload.type === 'HIDE_NUDGE' || payload.type === 'TBV_HIDE_NUDGE') {
      if (window.top !== window.self) {
        return;
      }
      this.nudgeOverlay?.hide();
      sendResponse({ success: true });
      return;
    }
  };

  private readonly handleBridgeMessage = (event: MessageEvent) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') {
      return;
    }

    const data = event.data as {
      source?: string;
      type?: string;
      payload?: {
        text?: string;
        method?: string;
        element?: {
          tag?: string;
          classes?: string;
          role?: string;
          ariaLabel?: string;
          dataTestId?: string;
          textPreview?: string;
        };
      };
    };

    if (data.source !== 'trust-but-verify' || data.type !== ActivityTracker.PROGRAMMATIC_COPY_MESSAGE) {
      return;
    }

    const payload = data.payload;
    if (!payload || typeof payload.text !== 'string') {
      return;
    }

    const triggerMetadata: Partial<CopyActivityTrigger> | undefined = payload.element
      ? {
          elementTag: payload.element.tag,
          elementClasses: payload.element.classes,
          elementRole: payload.element.role,
          elementAriaLabel: payload.element.ariaLabel,
          dataTestId: payload.element.dataTestId,
          elementTextPreview: payload.element.textPreview
        }
      : undefined;

    this.handleProgrammaticCopy(payload.text, payload.method || 'navigator.clipboard.writeText', {
      context: payload.element?.textPreview,
      trigger: triggerMetadata
    });
  };



  constructor() {
    this.domain = window.location.hostname;
    this.conversationDetector = new ConversationDetector(this.domain);
    this.init();
  }

  /**
   * Initialize tracking
   */
  private init(): void {
    console.log('[TrustButVerify] Activity tracking initialized on:', this.domain);
    
    this.trackInteractionTargets();

    // Initialize copy tracking
    document.addEventListener('copy', this.handleCopy.bind(this));
    this.setupProgrammaticCopyTracking();
    
    // Initialize conversation tracking
    this.conversationDetector.init();

    // Initialize nudge UI layer (hidden until explicitly requested).
    this.initNudgeOverlay();
    chrome.runtime.onMessage.addListener(this.handleRuntimeMessage);

    window.addEventListener('beforeunload', () => {
      window.removeEventListener('message', this.handleBridgeMessage);
      chrome.runtime.onMessage.removeListener(this.handleRuntimeMessage);
      this.nudgeOverlay?.dispose();
      this.nudgeOverlay = null;
    });
  }

  private initNudgeOverlay(): void {
    if (this.nudgeOverlay) {
      return;
    }

    try {
      this.nudgeOverlay = new NudgeOverlay();
      this.nudgeOverlay.setOnResolve((result) => this.handleNudgeResolution(result));
    } catch (error) {
      console.debug('[TrustButVerify] Nudge overlay init failed:', error);
      this.nudgeOverlay = null;
    }
  }

  private showNudgeOverlay(data: NudgeOverlayPayload): void {
    this.initNudgeOverlay();
    if (!this.nudgeOverlay) {
      console.warn('[TrustButVerify] Nudge overlay not available, cannot show nudge');
      return;
    }

    console.log('[TrustButVerify] Showing nudge overlay:', data.questionId, data.questionText);
    this.nudgeOverlay.show({
      ...data,
      timeoutMs: data.timeoutMs ?? ActivityTracker.NUDGE_TIMEOUT_MS
    });
  }

  private handleNudgeResolution(result: NudgeOverlayResolution): void {
    console.debug('[TrustButVerify] Nudge resolved:', {
      questionId: result.questionId,
      response: result.response,
      responseTimeMs: result.responseTimeMs,
      dismissedBy: result.dismissedBy,
      triggerType: result.triggerType,
      conversationId: result.conversationId,
      turnId: result.turnId,
      copyActivityId: result.copyActivityId
    });

    const timestamp = Date.now();

    // Persist the nudge event via service worker
    const nudgeEvent = {
      id: this.buildNudgeEventId(result.questionId, timestamp),
      timestamp,
      conversationId: result.conversationId || '',
      turnId: result.turnId,
      copyActivityId: result.copyActivityId,
      domain: this.domain,
      triggerType: result.triggerType,
      nudgeQuestionId: result.questionId,
      nudgeQuestionText: result.questionText,
      questionTags: result.questionTags,
      response: result.response,
      responseTimeMs: result.responseTimeMs,
      dismissedBy: result.dismissedBy
    };

    try {
      chrome.runtime.sendMessage(
        { type: 'SAVE_NUDGE_EVENT', data: nudgeEvent },
        () => {
          if (chrome.runtime.lastError) {
            console.debug('[TrustButVerify] Nudge event save failed:', chrome.runtime.lastError.message);
          }
        }
      );
    } catch {
      // Extension context may be invalidated — safe to ignore
    }
  }

  private buildNudgeEventId(questionId: string, timestampMs: number): string {
    const sanitizedQuestionId = (questionId || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
    const baseId = `nudge-${sanitizedQuestionId}-${timestampMs}`;
    const seenCount = (this.nudgeEventIdCollisions.get(baseId) || 0) + 1;
    this.nudgeEventIdCollisions.set(baseId, seenCount);

    // Keep this in-memory map bounded; collisions are only relevant short-term.
    if (this.nudgeEventIdCollisions.size > 500) {
      this.nudgeEventIdCollisions.clear();
    }

    return seenCount === 1 ? baseId : `${baseId}-${seenCount}`;
  }

  /**
   * Handle copy event
   */
  private async handleCopy(event: ClipboardEvent): Promise<void> {
    try {
      const selection = window.getSelection();
      let copiedText = selection?.toString()?.trim() || '';

      if (!copiedText && event.clipboardData) {
        copiedText = event.clipboardData.getData('text/plain')?.trim() || '';
      }

      if (!copiedText) {
        return;
      }

      const expanded = this.expandCopySelection(selection);
      const hasExplicitSelection = Boolean(
        selection
        && selection.rangeCount > 0
        && !selection.isCollapsed
        && copiedText.length > 0
      );

      // IMPORTANT: when user explicitly highlights text, keep that exact text
      // as copiedText. Only expand to full message/container when there is no
      // explicit selection (e.g., copy buttons, programmatic wrappers).
      const finalText = hasExplicitSelection
        ? copiedText
        : (expanded?.text?.trim() || copiedText);

      const didExpand = Boolean(
        !hasExplicitSelection
        && expanded
        && expanded.text
        && expanded.text.trim() !== copiedText
      );
      const extractionStrategy = hasExplicitSelection
        ? `${expanded?.strategy || 'selection'}:explicit`
        : (expanded?.strategy || 'selection:fallback');

      const { context, element } = this.extractSelectionContext(selection);
      const fallbackElement = (element as HTMLElement | null)
        || (event.target as HTMLElement | null)
        || this.lastInteractedElement
        || (document.activeElement as HTMLElement | null)
        || null;

      const recordElement = expanded?.element || fallbackElement;
      const recordContext = hasExplicitSelection
        ? (context || this.buildContextFromElement(recordElement, finalText))
        : (expanded?.context || context || this.buildContextFromElement(recordElement, finalText));

      const containerText = expanded?.containerText || finalText;
      const containerTextLength = expanded?.containerTextLength ?? containerText.length;

      await this.recordCopy(finalText, recordContext, {
        type: 'selection',
        method: event.clipboardData ? 'copy-event' : 'copy-event-selection',
        expanded: didExpand,
        extractionStrategy,
        ...this.describeElement(recordElement)
      }, {
        turnSide: expanded?.turnSide,
        containerText: this.capText(containerText, ActivityTracker.MAX_CONTAINER_TEXT_CHARS),
        containerTextLength,
        pairedPromptText: expanded?.pairedPromptText
          ? this.capText(expanded.pairedPromptText, ActivityTracker.MAX_PAIRED_PROMPT_CHARS)
          : undefined
      });

      console.log('[TrustButVerify] Copy event tracked:', {
        domain: this.domain,
        length: finalText.length,
        method: 'copy',
        expanded: didExpand,
        strategy: extractionStrategy,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TrustButVerify] Error tracking copy:', error);
    }
  }

  private expandCopySelection(selection: Selection | null): {
    text: string;
    context?: string;
    element?: HTMLElement | null;
    strategy?: string;
    turnSide?: 'prompt' | 'response';
    containerText?: string;
    containerTextLength?: number;
    pairedPromptText?: string;
  } | null {
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const getAnchorElement = (): HTMLElement | null => {
      try {
        const range = selection.getRangeAt(0);
        const node = range.commonAncestorContainer;
        if (node.nodeType === Node.ELEMENT_NODE) {
          return node as HTMLElement;
        }
        return node.parentElement;
      } catch {
        return selection.anchorNode && selection.anchorNode.nodeType === Node.ELEMENT_NODE
          ? (selection.anchorNode as HTMLElement)
          : selection.anchorNode?.parentElement || null;
      }
    };

    const anchor = getAnchorElement();
    if (!anchor) {
      return null;
    }

    const domain = this.domain;
    const normalizeText = (value: string | undefined | null) => (value || '').replace(/\s+$/g, '').trim();
    const getText = (el: Element | null) => normalizeText((el as HTMLElement | null)?.innerText || (el as HTMLElement | null)?.textContent || '');
    const isInsideCodeBlock = (el: HTMLElement) => Boolean(el.closest('pre, code, .code-block__code'));

    // Prefer code-block copies when selection is inside code.
    if (isInsideCodeBlock(anchor)) {
      const codeRoot = (anchor.closest('pre.code-block__code') as HTMLElement | null)
        || (anchor.closest('pre') as HTMLElement | null)
        || recallClosestCodeContainer(anchor);

      if (codeRoot) {
        const codeText = getText(codeRoot);
        if (codeText) {
          const resolved = this.resolveTurnContainer(codeRoot);
          const containerTextRaw = resolved?.wrapper ? getText(resolved.wrapper) : '';
          const pairedPromptText = resolved?.side === 'response' && resolved.wrapper
            ? this.findPairedPromptText(resolved.wrapper, resolved.side)
            : undefined;
          return {
            text: codeText,
            context: codeText.substring(0, 200),
            element: codeRoot,
            strategy: 'code-block',
            turnSide: resolved?.side,
            containerText: containerTextRaw || codeText,
            containerTextLength: (containerTextRaw || codeText).length,
            pairedPromptText
          };
        }
      }
    }

    if (domain.includes('claude')) {
      const userRoot = anchor.closest('[data-testid="user-message"]') as HTMLElement | null;
      const assistantRoot = anchor.closest('.font-claude-response') as HTMLElement | null;
      const root = userRoot || assistantRoot;
      if (root) {
        const text = getText(root);
        if (text) {
          const turnSide = userRoot ? 'prompt' : 'response';
          const pairedPromptText = turnSide === 'response'
            ? this.findPairedPromptText(root, turnSide)
            : undefined;
          return {
            text,
            context: text.substring(0, 200),
            element: root,
            strategy: userRoot ? 'claude:user-message' : 'claude:assistant-message',
            turnSide,
            containerText: text,
            containerTextLength: text.length,
            pairedPromptText
          };
        }
      }
    }

    if (domain.includes('chatgpt') || domain.includes('openai')) {
      const turn = anchor.closest('article[data-testid^="conversation-turn-"]') as HTMLElement | null;
      const nestedTurnMessage = turn
        ? (turn.querySelector('div[data-message-author-role="assistant"], div[data-message-author-role="user"]') as HTMLElement | null)
        : null;
      const message = (anchor.closest('div[data-message-author-role]') as HTMLElement | null) || nestedTurnMessage;
      const textMessage = anchor.closest('div.text-message') as HTMLElement | null;
      const root = message || textMessage || turn;
      if (root) {
        const role = message?.getAttribute('data-message-author-role') || undefined;
        const turnSide = role === 'user' ? 'prompt' : role === 'assistant' ? 'response' : undefined;
        const strategy = message
          ? `chatgpt:message:${role || 'unknown'}`
          : textMessage
            ? 'chatgpt:text-message'
            : 'chatgpt:conversation-turn';
        const text = this.sanitizeCapturedText(getText(root), turnSide, strategy);
        if (text) {
          const pairedPromptText = turnSide === 'response'
            ? this.findPairedPromptText(message || root, turnSide)
            : undefined;
          return {
            text,
            context: text.substring(0, 200),
            element: root,
            strategy,
            turnSide,
            containerText: text,
            containerTextLength: text.length,
            pairedPromptText
          };
        }
      }
    }

    if (domain.includes('gemini')) {
      const userQuery = anchor.closest('user-query') as HTMLElement | null;
      const userText = userQuery ? (userQuery.querySelector('.query-text') as HTMLElement | null) : null;
      if (userText) {
        const text = getText(userText);
        if (text) {
          return {
            text,
            context: text.substring(0, 200),
            element: userText,
            strategy: 'gemini:user-query',
            turnSide: 'prompt',
            containerText: text,
            containerTextLength: text.length
          };
        }
      }

      const assistant = anchor.closest('message-content') as HTMLElement | null;
      const assistantText = assistant
        ? (assistant.querySelector('.markdown.markdown-main-panel') as HTMLElement | null)
        : null;

      if (assistantText) {
        // Exclude visible “thinking” blocks when present.
        try {
          assistantText.querySelectorAll('model-thoughts, .model-thoughts').forEach((n) => n.remove());
        } catch {
          // ignore
        }

        const text = getText(assistantText);
        if (text) {
          const pairedPromptText = this.findPairedPromptText(assistantText, 'response');
          return {
            text,
            context: text.substring(0, 200),
            element: assistantText,
            strategy: 'gemini:assistant-message',
            turnSide: 'response',
            containerText: text,
            containerTextLength: text.length,
            pairedPromptText
          };
        }
      }

      const container = anchor.closest('div.conversation-container') as HTMLElement | null;
      if (container) {
        const text = getText(container);
        if (text) {
          return {
            text,
            context: text.substring(0, 200),
            element: container,
            strategy: 'gemini:conversation-container'
          };
        }
      }
    }

    if (domain.includes('grok') || domain.includes('x.ai')) {
      const response = anchor.closest('div[id^="response-"]') as HTMLElement | null;
      if (response) {
        const isUser = response.classList.contains('items-end');
        const content = (response.querySelector('.response-content-markdown') as HTMLElement | null) || response;
        const text = getText(content);
        if (text) {
          const turnSide = isUser ? 'prompt' : 'response';
          const pairedPromptText = turnSide === 'response'
            ? this.findPairedPromptText(content, turnSide)
            : undefined;
          return {
            text,
            context: text.substring(0, 200),
            element: content,
            strategy: isUser ? 'grok:user' : 'grok:response',
            turnSide,
            containerText: text,
            containerTextLength: text.length,
            pairedPromptText
          };
        }
      }
    }

    if (domain.includes('deepseek')) {
      const msg = anchor.closest('.ds-message') as HTMLElement | null;
      if (msg) {
        const assistant = msg.querySelector('.ds-markdown') as HTMLElement | null;
        const user = msg.querySelector('.fbb737a4') as HTMLElement | null;
        const root = assistant || user || msg;
        const text = getText(root);
        if (text) {
          const turnSide = assistant ? 'response' : user ? 'prompt' : undefined;
          const pairedPromptText = turnSide === 'response' ? this.findPairedPromptText(root, 'response') : undefined;
          return {
            text,
            context: text.substring(0, 200),
            element: root,
            strategy: assistant ? 'deepseek:assistant' : user ? 'deepseek:user' : 'deepseek:message',
            turnSide,
            containerText: text,
            containerTextLength: text.length,
            pairedPromptText
          };
        }
      }
    }

    return null;

    function recallClosestCodeContainer(element: HTMLElement): HTMLElement | null {
      // Claude/Gemini/Grok often wrap code blocks; this is a safe fallback.
      return (element.closest('div[class*="group/copy"]') as HTMLElement | null)
        || (element.closest('div[class*="code"]') as HTMLElement | null)
        || null;
    }
  }

  private trackInteractionTargets(): void {
    const updateTarget = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target) {
        this.lastInteractedElement = target;
      }
    };

    document.addEventListener('pointerdown', updateTarget, true);
    document.addEventListener('focusin', updateTarget, true);
    document.addEventListener('keydown', updateTarget, true);
  }

  private setupProgrammaticCopyTracking(): void {
    this.patchClipboardWriteText();
    this.patchClipboardWrite();
    window.addEventListener('message', this.handleBridgeMessage);
    this.injectClipboardBridgeScript();
  }

  private patchClipboardWriteText(): void {
    const clipboard = navigator.clipboard as Clipboard & { __TBV_WRITE_PATCHED__?: boolean };
    if (!clipboard || typeof clipboard.writeText !== 'function' || clipboard.__TBV_WRITE_PATCHED__) {
      return;
    }

    const original = clipboard.writeText.bind(clipboard);
    const tracker = this;

    const patched = async function patchedWriteText(...args: Parameters<Clipboard['writeText']>) {
      const [text] = args;
      try {
        tracker.handleProgrammaticCopy(typeof text === 'string' ? text : String(text), 'navigator.clipboard.writeText');
      } catch (error) {
        console.debug('[TrustButVerify] clipboard writeText hook error:', error);
      }
      return original(...args);
    };

    try {
      Object.defineProperty(clipboard, 'writeText', {
        value: patched,
        configurable: true
      });
    } catch {
      (clipboard as Clipboard & { writeText: typeof patched }).writeText = patched;
    }

    clipboard.__TBV_WRITE_PATCHED__ = true;
  }

  private patchClipboardWrite(): void {
    const clipboard = navigator.clipboard as Clipboard & { __TBV_WRITE_PATCHED__?: boolean } & { __TBV_WRITE_DATA_PATCHED__?: boolean };
    if (!clipboard || typeof clipboard.write !== 'function' || clipboard.__TBV_WRITE_DATA_PATCHED__) {
      return;
    }

    const original = clipboard.write.bind(clipboard);
    const tracker = this;

    const patched = async function patchedWrite(...args: Parameters<Clipboard['write']>) {
      const [items] = args;
      if (Array.isArray(items)) {
        items.forEach(item => {
          if (!item || typeof item !== 'object') {
            return;
          }
          if ('types' in item && Array.isArray(item.types) && item.types.includes('text/plain')) {
            try {
              item.getType('text/plain')
                .then(blob => blob.text())
                .then(text => tracker.handleProgrammaticCopy(text, 'navigator.clipboard.write'))
                .catch(() => undefined);
            } catch (error) {
              console.debug('[TrustButVerify] clipboard write hook error:', error);
            }
          }
        });
      }

      return original(...args);
    };

    try {
      Object.defineProperty(clipboard, 'write', {
        value: patched,
        configurable: true
      });
    } catch {
      (clipboard as Clipboard & { write: typeof patched }).write = patched;
    }

    clipboard.__TBV_WRITE_DATA_PATCHED__ = true;
  }

  private injectClipboardBridgeScript(): void {
    try {
      if (document.querySelector('script[data-tbv-clipboard-bridge="true"]')) {
        return;
      }

      const script = document.createElement('script');
      script.setAttribute('data-tbv-clipboard-bridge', 'true');
      script.src = chrome.runtime.getURL('content/clipboard-bridge.js');
      script.onload = () => {
        script.remove();
      };
      script.onerror = (error) => {
        console.debug('[TrustButVerify] Clipboard bridge failed to load:', error);
      };

      (document.documentElement || document.head || document.body)?.appendChild(script);
    } catch (error) {
      console.debug('[TrustButVerify] Failed to inject clipboard bridge script:', error);
    }
  }

  private handleProgrammaticCopy(
    text: string,
    method: string,
    metadata?: { context?: string | null; trigger?: Partial<CopyActivityTrigger> | undefined }
  ): void {
    const trimmed = text?.trim();
    if (!trimmed) {
      return;
    }

    const element = this.lastInteractedElement || (document.activeElement as HTMLElement | null);
    const expanded = this.expandCopyFromElement(element, trimmed);

    const candidateContext = metadata?.context?.trim() ? metadata.context.trim() : '';
    const context = candidateContext
      && !this.looksLikeScriptNoise(candidateContext)
      && !this.looksLikeUselessContext(candidateContext)
        ? candidateContext.substring(0, 200)
        : expanded?.context || this.buildContextFromElement(expanded?.element || element, trimmed);

    const fallbackMetadata = this.describeElement(expanded?.element || element) || {};
    const combinedMetadata = this.mergeTriggerMetadata(fallbackMetadata, metadata?.trigger);

    const trigger: CopyActivityTrigger = {
      type: 'programmatic',
      method,
      expanded: false,
      extractionStrategy: expanded?.strategy || 'programmatic:fallback',
      ...combinedMetadata
    };

    const containerText = expanded?.containerText || trimmed;
    const containerTextLength = expanded?.containerTextLength ?? containerText.length;

    this.recordCopy(trimmed, context, trigger, {
      turnSide: expanded?.turnSide,
      containerText: this.capText(containerText, ActivityTracker.MAX_CONTAINER_TEXT_CHARS),
      containerTextLength,
      pairedPromptText: expanded?.pairedPromptText
        ? this.capText(expanded.pairedPromptText, ActivityTracker.MAX_PAIRED_PROMPT_CHARS)
        : undefined
    }).catch((error) => {
      console.error('[TrustButVerify] Error tracking programmatic copy:', error);
    });

    console.log('[TrustButVerify] Copy event tracked:', {
      domain: this.domain,
      length: trimmed.length,
      method,
      strategy: expanded?.strategy || 'programmatic:fallback',
      timestamp: new Date().toISOString()
    });
  }

  private expandCopyFromElement(
    element: HTMLElement | null,
    copiedText?: string
  ): {
    element: HTMLElement;
    context: string;
    strategy: string;
    turnSide?: 'prompt' | 'response';
    containerText?: string;
    containerTextLength?: number;
    pairedPromptText?: string;
  } | null {
    if (!element) {
      return null;
    }

    const anchor = element;
    const domain = this.domain;
    const normalizeText = (value: string | undefined | null) => (value || '').replace(/\s+$/g, '').trim();
    const getText = (el: Element | null) => normalizeText((el as HTMLElement | null)?.innerText || (el as HTMLElement | null)?.textContent || '');

    const codeRoot = (anchor.closest('pre.code-block__code') as HTMLElement | null)
      || (anchor.closest('pre') as HTMLElement | null)
      || (anchor.closest('code') as HTMLElement | null);

    if (codeRoot) {
      const text = getText(codeRoot);
      if (text) {
        return this.buildExpandedCopyResult(codeRoot, text, 'code-block');
      }
    }

    const nearbyCode = this.findNearbyCodeBlock(anchor);
    if (nearbyCode) {
      const text = getText(nearbyCode);
      if (text) {
        return this.buildExpandedCopyResult(nearbyCode, text, 'code-block-nearby');
      }
    }

    if (domain.includes('claude')) {
      const root = (anchor.closest('[data-testid="user-message"]') as HTMLElement | null)
        || (anchor.closest('.font-claude-response') as HTMLElement | null);
      if (root) {
        const text = getText(root);
        if (text) {
          const side = root.matches('[data-testid="user-message"]') ? 'prompt' : 'response';
          return this.buildExpandedCopyResult(root, text, side === 'prompt' ? 'claude:user-message' : 'claude:assistant-message', side);
        }
      }
    }

    if (domain.includes('chatgpt') || domain.includes('openai')) {
      const turn = anchor.closest('article[data-testid^="conversation-turn-"]') as HTMLElement | null;
      const nestedTurnMessage = turn
        ? (turn.querySelector('div[data-message-author-role="assistant"], div[data-message-author-role="user"]') as HTMLElement | null)
        : null;
      const root = (anchor.closest('div[data-message-author-role]') as HTMLElement | null)
        || nestedTurnMessage
        || turn;
      if (root) {
        let role = root.matches('div[data-message-author-role]')
          ? (root.getAttribute('data-message-author-role') || 'unknown')
          : 'unknown';

        // Fallback: if role is unknown (e.g. copy button outside the role
        // wrapper but inside the turn article), infer from nested children.
        if (role === 'unknown' && turn) {
          const nestedAssistant = turn.querySelector('div[data-message-author-role="assistant"]');
          const nestedUser = turn.querySelector('div[data-message-author-role="user"]');
          if (nestedAssistant && nestedUser) {
            role = 'unknown';
          } else if (nestedAssistant) {
            role = 'assistant';
          } else if (nestedUser) {
            role = 'user';
          }
        }

        const side = role === 'user' ? 'prompt' : role === 'assistant' ? 'response' : undefined;
        const strategy = root.matches('div[data-message-author-role]') ? `chatgpt:message:${role}` : 'chatgpt:conversation-turn';
        const text = this.sanitizeCapturedText(getText(root), side, strategy);
        if (text) {
          return this.buildExpandedCopyResult(
            root,
            text,
            strategy,
            side
          );
        }
      }
    }

    if (domain.includes('gemini')) {
      const userQuery = anchor.closest('user-query') as HTMLElement | null;
      const userText = userQuery ? (userQuery.querySelector('.query-text') as HTMLElement | null) : null;
      if (userText) {
        const text = getText(userText);
        if (text) {
          return this.buildExpandedCopyResult(userText, text, 'gemini:user-query', 'prompt');
        }
      }

      const assistant = anchor.closest('message-content') as HTMLElement | null;
      const assistantText = assistant ? (assistant.querySelector('.markdown.markdown-main-panel') as HTMLElement | null) : null;
      if (assistantText) {
        const text = getText(assistantText);
        if (text) {
          return this.buildExpandedCopyResult(assistantText, text, 'gemini:assistant-message', 'response');
        }
      }

      // Fallback: copy button may be outside message-content but inside
      // model-response. Walk up to broader container.
      const modelResponse = anchor.closest('model-response') as HTMLElement | null;
      if (modelResponse) {
        const nested = (modelResponse.querySelector('.markdown.markdown-main-panel') as HTMLElement | null)
          || (modelResponse.querySelector('message-content') as HTMLElement | null);
        const target = nested || modelResponse;
        const text = getText(target);
        if (text) {
          return this.buildExpandedCopyResult(target as HTMLElement, text, 'gemini:model-response', 'response');
        }
      }

      const container = anchor.closest('div.conversation-container') as HTMLElement | null;
      if (container) {
        const text = getText(container);
        if (text) {
          return this.buildExpandedCopyResult(container, text, 'gemini:conversation-container');
        }
      }
    }

    if (domain.includes('grok') || domain.includes('x.ai')) {
      const responseDiv = anchor.closest('div[id^="response-"]') as HTMLElement | null;
      if (responseDiv) {
        // Grok wraps BOTH user and assistant messages in div[id^="response-"].
        // User messages have .items-end; assistant messages have .items-start.
        const isUser = responseDiv.classList.contains('items-end');
        const content = (responseDiv.querySelector('.response-content-markdown') as HTMLElement | null) || responseDiv;
        const text = getText(content);
        if (text) {
          const side = isUser ? 'prompt' as const : 'response' as const;
          return this.buildExpandedCopyResult(content, text, isUser ? 'grok:user' : 'grok:response', side);
        }
      }
    }

    if (domain.includes('deepseek')) {
      const msg = anchor.closest('.ds-message') as HTMLElement | null;
      if (msg) {
        const assistant = msg.querySelector('.ds-markdown') as HTMLElement | null;
        const user = msg.querySelector('.fbb737a4') as HTMLElement | null;
        const root = assistant || user || msg;
        const text = getText(root);
        if (text) {
          const side = assistant ? 'response' : user ? 'prompt' : undefined;
          return this.buildExpandedCopyResult(root, text, assistant ? 'deepseek:assistant' : user ? 'deepseek:user' : 'deepseek:message', side);
        }
      }
    }

    // Last-resort fallback for programmatic copies when site-specific side
    // resolution fails. Keep this at the end so stronger platform heuristics
    // run first.
    if (copiedText) {
      const matched = this.findBestMatchByText(anchor, copiedText);
      if (matched) {
        const text = getText(matched.element);
        if (text) {
          return this.buildExpandedCopyResult(
            matched.element,
            text,
            'matched-by-text',
            matched.side
          );
        }
      }
    }

    return null;
  }

  private buildExpandedCopyResult(
    element: HTMLElement,
    extractedText: string,
    strategy: string,
    turnSide?: 'prompt' | 'response'
  ): {
    element: HTMLElement;
    context: string;
    strategy: string;
    turnSide?: 'prompt' | 'response';
    containerText?: string;
    containerTextLength?: number;
    pairedPromptText?: string;
  } {
    const resolved = this.resolveTurnContainer(element);
    const side = turnSide || resolved?.side;

    let containerText = extractedText;
    if (resolved?.wrapper) {
      const raw = (resolved.wrapper.innerText || resolved.wrapper.textContent || '').trim();
      if (raw) {
        containerText = raw;
      }
    }

    const pairedPromptText = side === 'response' && (resolved?.wrapper || element)
      ? this.findPairedPromptText(resolved?.wrapper || element, side)
      : undefined;

    return {
      element,
      context: extractedText.substring(0, 200),
      strategy,
      turnSide: side,
      containerText,
      containerTextLength: containerText.length,
      pairedPromptText
    };
  }

  private resolveTurnContainer(element: HTMLElement): { wrapper: HTMLElement; side: 'prompt' | 'response' } | null {
    const domain = this.domain;

    if (domain.includes('chatgpt') || domain.includes('openai')) {
      const message = element.closest('div[data-message-author-role]') as HTMLElement | null;
      const role = message?.getAttribute('data-message-author-role');
      if (message && (role === 'user' || role === 'assistant')) {
        return { wrapper: message, side: role === 'user' ? 'prompt' : 'response' };
      }

      // Fallback: copy buttons sit outside div[data-message-author-role] but
      // inside the turn article. Check for nested role elements.
      const turn = element.closest('article[data-testid^="conversation-turn-"]') as HTMLElement | null;
      if (turn) {
        const assistantMsg = turn.querySelector('div[data-message-author-role="assistant"]') as HTMLElement | null;
        const userMsg = turn.querySelector('div[data-message-author-role="user"]') as HTMLElement | null;
        if (assistantMsg && userMsg) {
          // Ambiguous turn-level fallback: avoid assuming response side.
          return null;
        }
        if (assistantMsg) return { wrapper: assistantMsg, side: 'response' };
        if (userMsg) return { wrapper: userMsg, side: 'prompt' };
      }
      return null;
    }

    if (domain.includes('claude')) {
      const user = element.closest('[data-testid="user-message"]') as HTMLElement | null;
      if (user) return { wrapper: user, side: 'prompt' };
      const assistant = element.closest('.font-claude-response') as HTMLElement | null;
      if (assistant) return { wrapper: assistant, side: 'response' };
      return null;
    }

    if (domain.includes('gemini')) {
      const userQuery = element.closest('user-query') as HTMLElement | null;
      const userText = userQuery ? (userQuery.querySelector('.query-text') as HTMLElement | null) : null;
      if (userText) return { wrapper: userText, side: 'prompt' };

      const assistant = element.closest('message-content') as HTMLElement | null;
      const assistantText = assistant ? (assistant.querySelector('.markdown.markdown-main-panel') as HTMLElement | null) : null;
      if (assistantText) return { wrapper: assistantText, side: 'response' };

      // Fallback: copy buttons on Gemini may sit outside message-content but
      // inside a broader response container. Walk up to model-response or
      // similar wrapper and check for nested message-content.
      const modelResponse = element.closest('model-response') as HTMLElement | null;
      if (modelResponse) {
        const nested = modelResponse.querySelector('.markdown.markdown-main-panel') as HTMLElement | null;
        if (nested) return { wrapper: nested, side: 'response' };
        const nestedMsg = modelResponse.querySelector('message-content') as HTMLElement | null;
        if (nestedMsg) return { wrapper: nestedMsg, side: 'response' };
        return { wrapper: modelResponse, side: 'response' };
      }

      return null;
    }

    if (domain.includes('grok') || domain.includes('x.ai')) {
      const responseDiv = (element.closest('div[id^="response-"]') as HTMLElement | null)
        || (element.closest('[data-testid="assistant-message"]') as HTMLElement | null)
        || (element.closest('[data-testid="response-message"]') as HTMLElement | null);
      if (responseDiv) {
        // Grok wraps BOTH user and assistant messages in div[id^="response-"].
        // User messages have .items-end; assistant messages have .items-start.
        const isUser = responseDiv.classList.contains('items-end');
        const content = (responseDiv.querySelector('.response-content-markdown') as HTMLElement | null) || responseDiv;
        return { wrapper: content, side: isUser ? 'prompt' : 'response' };
      }

      const user = (element.closest('[data-testid="user-message"]') as HTMLElement | null)
        || (element.closest('[class*="userMessage"]') as HTMLElement | null)
        || (element.closest('[class*="userBubble"]') as HTMLElement | null)
        || (element.closest('[class*="user-bubble"]') as HTMLElement | null);
      if (user) return { wrapper: user, side: 'prompt' };
      return null;
    }

    if (domain.includes('deepseek')) {
      const msg = element.closest('.ds-message') as HTMLElement | null;
      if (msg) {
        const assistant = msg.querySelector('.ds-markdown') as HTMLElement | null;
        const user = msg.querySelector('.fbb737a4') as HTMLElement | null;
        if (assistant && user) {
          // Ambiguous mixed message container; do not guess side.
          return null;
        }
        if (assistant) return { wrapper: assistant, side: 'response' };
        if (user) return { wrapper: user, side: 'prompt' };
        return null;
      }
      return null;
    }

    return null;
  }

  private findPairedPromptText(fromElement: HTMLElement, side: 'prompt' | 'response'): string | undefined {
    if (side !== 'response') {
      return undefined;
    }

    const domain = this.domain;
    const root = (fromElement.closest('main') as HTMLElement | null)
      || (fromElement.closest('[role="main"]') as HTMLElement | null)
      || document.body;

    const getText = (el: Element | null) => (el as HTMLElement | null)?.innerText?.trim()
      || (el as HTMLElement | null)?.textContent?.trim()
      || '';

    const lastBefore = (selectors: string[], current: Element): HTMLElement | null => {
      let best: HTMLElement | null = null;
      for (const sel of selectors) {
        let list: HTMLElement[] = [];
        try {
          list = Array.from(root.querySelectorAll(sel)) as HTMLElement[];
        } catch {
          continue;
        }

        for (const node of list) {
          if (node === current) continue;
          const pos = node.compareDocumentPosition(current);
          const isBefore = Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING);
          if (isBefore) {
            best = node;
          }
        }
      }

      return best;
    };

    if (domain.includes('chatgpt') || domain.includes('openai')) {
      const current = (fromElement.closest('div[data-message-author-role]') as HTMLElement | null) || fromElement;
      const userEl = lastBefore(['div[data-message-author-role="user"]'], current);
      const text = getText(userEl);
      return text || undefined;
    }

    if (domain.includes('claude')) {
      const current = (fromElement.closest('.font-claude-response') as HTMLElement | null) || fromElement;
      const userEl = lastBefore(['[data-testid="user-message"]'], current);
      const text = getText(userEl);
      return text || undefined;
    }

    if (domain.includes('gemini')) {
      const current = (fromElement.closest('message-content') as HTMLElement | null) || fromElement;
      const userQuery = lastBefore(['user-query'], current);
      const userText = userQuery ? (userQuery.querySelector('.query-text') as HTMLElement | null) : null;
      const text = getText(userText || userQuery);
      return text || undefined;
    }

    if (domain.includes('deepseek')) {
      const currentMsg = (fromElement.closest('.ds-message') as HTMLElement | null);
      if (!currentMsg) return undefined;

      const messages = Array.from(root.querySelectorAll('.ds-message')) as HTMLElement[];
      const idx = messages.indexOf(currentMsg);
      if (idx <= 0) return undefined;

      for (let i = idx - 1; i >= 0; i--) {
        const msg = messages[i];
        const userText = (msg.querySelector('.fbb737a4') as HTMLElement | null)
          || (msg.querySelector('[data-role="user"]') as HTMLElement | null)
          || null;
        const text = getText(userText || msg);
        if (text) {
          return text;
        }
      }

      return undefined;
    }

    if (domain.includes('grok') || domain.includes('x.ai')) {
      const current = (fromElement.closest('div[id^="response-"]') as HTMLElement | null) || fromElement;
      const userEl = lastBefore([
        'div[id^="response-"].items-end',
        '[data-testid="user-message"]',
        '[class*="userMessage"]',
        '[class*="userBubble"]',
        '[class*="user-bubble"]'
      ], current);
      // Extract text from markdown content inside user bubble, not from the
      // full container (which includes action-button labels like "Edit","Copy").
      const md = userEl?.querySelector('.response-content-markdown') as HTMLElement | null;
      const text = getText(md || userEl);
      return text || undefined;
    }

    return undefined;
  }

  private capText(text: string, maxChars: number): string {
    const t = (text || '').trim();
    if (t.length <= maxChars) {
      return t;
    }
    return t.slice(0, maxChars);
  }

  private findBestMatchByText(
    anchor: HTMLElement,
    copiedText: string
  ): { element: HTMLElement; side?: 'prompt' | 'response' } | null {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const needle = normalize(copiedText).slice(0, 80);
    if (!needle) return null;

    // Restrict search to a reasonable container to avoid scanning the whole page.
    const container = (anchor.closest('article[data-testid^="conversation-turn-"]') as HTMLElement | null)
      || (anchor.closest('div[data-message-author-role]') as HTMLElement | null)
      || (anchor.closest('main') as HTMLElement | null)
      || (anchor.closest('section') as HTMLElement | null)
      || document.body;

    const candidateGroups: Array<{ selector: string; side?: 'prompt' | 'response' }> = [
      // Generic code targets (side often inferred from surrounding container).
      { selector: 'pre.code-block__code, pre, code' },

      // Response-side candidates.
      { selector: '.font-claude-response', side: 'response' },
      { selector: 'div[id^="response-"].items-start .response-content-markdown', side: 'response' },
      { selector: '.ds-markdown', side: 'response' },
      { selector: 'div[data-message-author-role="assistant"]', side: 'response' },
      { selector: 'message-content .markdown.markdown-main-panel', side: 'response' },

      // Prompt-side candidates.
      { selector: '[data-testid="user-message"]', side: 'prompt' },
      { selector: 'div[data-message-author-role="user"]', side: 'prompt' },
      { selector: 'user-query .query-text', side: 'prompt' },
      { selector: '.fbb737a4', side: 'prompt' },
      { selector: 'div[id^="response-"].items-end .response-content-markdown', side: 'prompt' }
    ];

    let best: { element: HTMLElement; side?: 'prompt' | 'response'; score: number } | null = null;
    let bestSideAmbiguous = false;
    for (const group of candidateGroups) {
      const candidates = Array.from(container.querySelectorAll(group.selector)) as HTMLElement[];
      for (const el of candidates) {
        const hay = normalize(el.innerText || el.textContent || '');
        if (!hay) continue;

        let score = 0;
        if (hay === normalize(copiedText)) score += 1000;
        if (hay.startsWith(needle)) score += 400;
        if (hay.includes(needle)) score += 200;

        // Small boost for code containers.
        if (el.tagName.toLowerCase() === 'pre' || el.tagName.toLowerCase() === 'code') score += 50;

        if (!best || score > best.score) {
          best = { element: el, side: group.side, score };
          bestSideAmbiguous = false;
          continue;
        }

        if (best && score === best.score) {
          const candidateSide = group.side;
          const currentBestSide = best.side;
          if (candidateSide !== currentBestSide) {
            // Equal-score disagreement between prompt/response/unknown.
            // Be conservative and avoid forcing a side.
            bestSideAmbiguous = true;
          }
        }
      }
    }

    if (best && best.score >= 200) {
      return {
        element: best.element,
        side: bestSideAmbiguous ? undefined : best.side
      };
    }
    return null;
  }

  private mergeTriggerMetadata(
    fallback: Partial<CopyActivityTrigger>,
    incoming: Partial<CopyActivityTrigger> | undefined
  ): Partial<CopyActivityTrigger> {
    if (!incoming) {
      return fallback;
    }

    // Ignore obviously unhelpful page-side descriptors (commonly BODY/HTML).
    const tag = (incoming.elementTag || '').toLowerCase();
    const looksUseless = tag === 'body' || tag === 'html';

    if (looksUseless) {
      return fallback;
    }

    // Otherwise, let incoming fill gaps but don't clobber richer fallback.
    return {
      ...incoming,
      ...fallback,
      method: incoming.method || fallback.method,
      type: fallback.type
    };
  }

  private looksLikeScriptNoise(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (t.length > 120 && (t.startsWith('!function') || t.startsWith('(()=>') || t.startsWith('((a,b,c') || t.startsWith('var '))) {
      return true;
    }
    if (t.includes('localStorage.getItem') || t.includes('document.documentElement') || t.includes('function(){try')) {
      return true;
    }
    return false;
  }

  private looksLikeUselessContext(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t) return true;
    if (t.length <= 3) return true;
    if (t === 'copy' || t === 'copy code' || t === 'copy to clipboard') return true;
    if (t === 'copied' || t === 'copied!' || t === 'copying…') return true;
    return false;
  }

  private findNearbyCodeBlock(element: HTMLElement): HTMLElement | null {
    // Heuristic for copy-button toolbars not nested inside <pre>/<code>.
    // Walk up a few ancestors and search for a nearby <pre> in the same UI block.
    const findPre = (root: ParentNode | null): HTMLElement | null => {
      if (!root) return null;
      const pre = root.querySelector('pre.code-block__code, pre');
      return (pre as HTMLElement | null) || null;
    };

    const findPreInSiblings = (node: HTMLElement): HTMLElement | null => {
      let sib: Element | null = node;

      // Look backward a few siblings.
      sib = node.previousElementSibling;
      for (let i = 0; i < 4 && sib; i++) {
        const pre = findPre(sib);
        if (pre) return pre;
        sib = sib.previousElementSibling;
      }

      // Look forward a few siblings.
      sib = node.nextElementSibling;
      for (let i = 0; i < 4 && sib; i++) {
        const pre = findPre(sib);
        if (pre) return pre;
        sib = sib.nextElementSibling;
      }

      return null;
    };

    let current: HTMLElement | null = element;
    for (let i = 0; i < 8 && current; i++) {
      // Descendant <pre>.
      const direct = findPre(current);
      if (direct) return direct;

      // Sibling <pre> (common for toolbars).
      const sibling = findPreInSiblings(current);
      if (sibling) return sibling;

      // Parent container <pre> (common for ChatGPT blocks).
      const parentEl: HTMLElement | null = current.parentElement;
      const inParent = findPre(parentEl);
      if (inParent) return inParent;

      current = parentEl;
    }

    return null;
  }

  private async recordCopy(
    copiedText: string,
    context: string,
    trigger: CopyActivityTrigger,
    extras?: {
      turnSide?: 'prompt' | 'response';
      containerText?: string;
      containerTextLength?: number;
      pairedPromptText?: string;
    }
  ): Promise<void> {
    const conversationId = this.conversationDetector.getConversationId();
    const cleanedCopiedText = this.sanitizeCapturedText(copiedText, extras?.turnSide, trigger.extractionStrategy);
    const trimmed = cleanedCopiedText.trim();
    if (!trimmed) {
      return;
    }

    // ── Share-link filter ────────────────────────────────────────────────
    // Platforms like Gemini/Grok auto-copy share URLs to the clipboard
    // when the user clicks "Share". Skip these — they're not user-selected
    // content from a conversation.
    if (this.looksLikeShareLink(trimmed)) {
      console.log('[TrustButVerify] Skipping share-link copy:', trimmed.substring(0, 80));
      return;
    }

    // ── Response-only copy filter ─────────────────────────────────────────
    // Store copy activity only when it is confidently from the LLM response.
    // Keep pairedPromptText capture for response-side copies unchanged.
    if (extras?.turnSide !== 'response') {
      console.log('[TrustButVerify] Skipping non-response copy activity', {
        turnSide: extras?.turnSide || null,
        domain: this.domain,
        strategy: trigger.extractionStrategy || null
      });
      return;
    }

    const signature = `${conversationId}:${extras?.turnSide || 'unknown'}:${this.normalizeCopySignature(trimmed)}`;
    if (!this.shouldRecordSignature(signature)) {
      return;
    }

    const cleanedContainerText = extras?.containerText
      ? this.sanitizeCapturedText(extras.containerText, extras.turnSide, trigger.extractionStrategy)
      : undefined;

    const cleanedContext = context
      ? this.sanitizeCapturedText(context, extras?.turnSide, trigger.extractionStrategy).substring(0, 200)
      : undefined;

    const activity: CopyActivity = {
      id: this.generateId(),
      timestamp: Date.now(),
      url: window.location.href,
      domain: this.domain,
      conversationId,
      copiedText: trimmed,
      textLength: trimmed.length,
      turnSide: extras?.turnSide,
      containerText: cleanedContainerText,
      containerTextLength: cleanedContainerText?.length ?? extras?.containerTextLength,
      pairedPromptText: extras?.pairedPromptText,
      selectionContext: cleanedContext,
      trigger: this.cleanTriggerMetadata(trigger)
    };

    await this.sendToBackground(activity);
  }

  private cleanTriggerMetadata(trigger: CopyActivityTrigger): CopyActivityTrigger {
    const cleaned: CopyActivityTrigger = { type: trigger.type };
    if (trigger.method) {
      cleaned.method = trigger.method;
    }
    if (typeof trigger.expanded === 'boolean') {
      cleaned.expanded = trigger.expanded;
    }
    if (trigger.extractionStrategy) {
      cleaned.extractionStrategy = trigger.extractionStrategy;
    }
    if (trigger.elementTag) {
      cleaned.elementTag = trigger.elementTag;
    }
    if (trigger.elementClasses) {
      cleaned.elementClasses = trigger.elementClasses;
    }
    if (trigger.elementRole) {
      cleaned.elementRole = trigger.elementRole;
    }
    if (trigger.elementAriaLabel) {
      cleaned.elementAriaLabel = trigger.elementAriaLabel;
    }
    if (trigger.dataTestId) {
      cleaned.dataTestId = trigger.dataTestId;
    }
    if (trigger.elementTextPreview) {
      cleaned.elementTextPreview = trigger.elementTextPreview.substring(0, 120);
    }
    return cleaned;
  }

  private shouldRecordSignature(signature: string): boolean {
    const now = Date.now();
    const last = this.copySignatureCache.get(signature);
    if (last && now - last < ActivityTracker.COPY_SIGNATURE_TTL) {
      return false;
    }

    this.copySignatureCache.set(signature, now);
    if (this.copySignatureCache.size > 100) {
      this.pruneSignatureCache(now);
    }
    return true;
  }

  private normalizeCopySignature(text: string): string {
    return text
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim()
      .slice(0, 800);
  }

  /**
   * Detect if text is a share link (URL-only content).
   * Platforms like Gemini/Grok auto-copy share URLs to clipboard.
   */
  private looksLikeShareLink(text: string): boolean {
    const stripped = text.trim();
    // Must be a single line (no newlines) — multi-line content is never a share link.
    if (stripped.includes('\n')) return false;
    try {
      const url = new URL(stripped);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private sanitizeCapturedText(
    text: string,
    turnSide?: 'prompt' | 'response',
    strategy?: string
  ): string {
    const normalized = (text || '').replace(/\s+$/g, '').trim();
    if (!normalized) {
      return '';
    }

    if ((this.domain.includes('chatgpt') || this.domain.includes('openai')) && turnSide === 'response') {
      return this.cleanChatgptResponseText(normalized);
    }

    if (this.domain.includes('gemini') && (turnSide === 'prompt' || strategy === 'gemini:user-query')) {
      return this.cleanGeminiPromptText(normalized);
    }

    return normalized;
  }

  private cleanChatgptResponseText(text: string): string {
    let cleaned = text
      .replace(/^\s*chatgpt\s+said:\s*/i, '')
      .trim();

    cleaned = cleaned
      .replace(/\s*is this conversation helpful so far\?\s*$/i, '')
      .replace(/\s*do you like this personality\?\s*$/i, '')
      .trim();

    return cleaned;
  }

  private cleanGeminiPromptText(text: string): string {
    return text
      .replace(/^\s*you\s+said\s*:?\s*/i, '')
      .trim();
  }

  private pruneSignatureCache(now: number): void {
    const keys = Array.from(this.copySignatureCache.keys());
    keys.forEach((key) => {
      const recordedAt = this.copySignatureCache.get(key);
      if (!recordedAt || now - recordedAt > ActivityTracker.COPY_SIGNATURE_TTL * 10) {
        this.copySignatureCache.delete(key);
      }
    });
  }

  private extractSelectionContext(selection: Selection | null): { context: string; element?: Element } {
    if (!selection || selection.rangeCount === 0) {
      return { context: '' };
    }

    try {
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;

      const context = container?.textContent?.trim().substring(0, 200) || '';
      return { context, element: container || undefined };
    } catch (error) {
      console.debug('[TrustButVerify] Failed to extract selection context:', error);
      return { context: '' };
    }
  }

  private buildContextFromElement(element: Element | null, fallbackText: string): string {
    const el = element && element instanceof HTMLElement ? element : element?.parentElement;
    if (el) {
      const tag = el.tagName?.toLowerCase();
      if (tag === 'body' || tag === 'html') {
        return fallbackText.substring(0, 200);
      }
    }

    if (element && element.textContent) {
      const text = element.textContent.trim();
      if (text.length > 0) {
        if (!this.looksLikeScriptNoise(text) && !this.looksLikeUselessContext(text)) {
          return text.substring(0, 200);
        }
      }
    }
    return fallbackText.substring(0, 200);
  }

  private describeElement(element: Element | null): Partial<CopyActivityTrigger> | undefined {
    if (!element) {
      return undefined;
    }

    const el = element instanceof HTMLElement ? element : element.parentElement;
    if (!el) {
      return undefined;
    }

    const classList = Array.from(el.classList || []).slice(0, 5).join(' ').trim();
    const textPreview = el.textContent?.replace(/\s+/g, ' ').trim();

    const metadata: Partial<CopyActivityTrigger> = {
      elementTag: el.tagName.toLowerCase()
    };

    if (classList) {
      metadata.elementClasses = classList;
    }

    const role = el.getAttribute('role');
    if (role) {
      metadata.elementRole = role;
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      metadata.elementAriaLabel = ariaLabel;
    }

    const dataTestId = el.getAttribute('data-testid');
    if (dataTestId) {
      metadata.dataTestId = dataTestId;
    }

    if (textPreview) {
      metadata.elementTextPreview = textPreview.substring(0, 160);
    }

    return metadata;
  }

  /**
   * Send activity to background script
   */
  private async sendToBackground(activity: CopyActivity): Promise<void> {
    try {
      const payload = {
        type: 'COPY_EVENT',
        data: activity
      };

      await chrome.runtime.sendMessage(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();

      const isTransientPortIssue =
        lower.includes('message port closed') ||
        lower.includes('receiving end does not exist') ||
        lower.includes('could not establish connection');

      if (isTransientPortIssue && chrome?.runtime?.id) {
        try {
          await new Promise((resolve) => window.setTimeout(resolve, 200));
          await chrome.runtime.sendMessage({
            type: 'COPY_EVENT',
            data: activity
          });
          return;
        } catch (retryError) {
          console.error('[TrustButVerify] Error sending to background (retry failed):', retryError);
          return;
        }
      }

      if (lower.includes('extension context invalidated')) {
        this.extensionContextInvalidated = true;
      }

      console.error('[TrustButVerify] Error sending to background:', error);
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}

// Initialize tracker when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new ActivityTracker());
} else {
  new ActivityTracker();
}
