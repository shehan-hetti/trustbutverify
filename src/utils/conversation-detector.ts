import type { ConversationLog, ConversationTurn } from '../types';

/**
 * Utility to detect and extract conversations from different LLM platforms
 */
export class ConversationDetector {
  private readonly domain: string;
  private pendingPrompt: { text: string; timestamp: number } | null = null;
  private readonly processedElements = new WeakSet<Element>();
  private readonly processedMessageKeys = new Set<string>();
  private readonly processedMessageKeyQueue: string[] = [];
  private readonly recentPrompts: Array<{ text: string; timestamp: number }> = [];

  constructor(domain: string) {
    this.domain = domain;
    this.logDebug('Detector constructed', { domain: this.domain });
  }

  /**
   * Initialize conversation monitoring
   */
  init(): void {
    this.logDebug('Conversation monitoring initialized');
    
    // Use MutationObserver to detect new messages
    this.observeConversations();
    
    // Listen for form submissions (prompts)
    this.observePromptSubmissions();
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
    let cachedPrompt = '';
    let cacheTimestamp = 0;

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
        if (this.isComposerElement(target)) {
          updateCachedPrompt();
          if (cachedPrompt) {
            this.logDebug('Enter captured prompt', cachedPrompt.substring(0, 120));
            this.handlePrompt(cachedPrompt);
            cachedPrompt = '';
          }
        }
      }
    }, true);

    // Capture on button click (mouse down phase)
    document.addEventListener('mousedown', (event) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'BUTTON' || target.closest('button')) {
        updateCachedPrompt();
        if (cachedPrompt && Date.now() - cacheTimestamp < 5000) {
          this.logDebug('Button captured prompt', cachedPrompt.substring(0, 120));
          this.handlePrompt(cachedPrompt);
          cachedPrompt = '';
        }
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
    return Boolean(element.closest('div[contenteditable="true"]') || element.closest('.ProseMirror'));
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
    // Platform-specific selectors
    const selectors = this.getMessageSelectors();
    
    for (const selector of selectors) {
      const candidates: Element[] = [];

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
          return;
        }

        if (this.isUserAuthoredElement(candidate)) {
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

        this.logDebug('Message selector matched', {
          selector,
          tag: candidate.tagName,
          class: (candidate as HTMLElement).className,
          id: (candidate as HTMLElement).id,
          messageKey,
          textPreview: (candidate.textContent || '').substring(0, 120)
        });

        // Wait for content to load (streaming responses)
        this.waitForContent(candidate);
      });
    }
  }

  /**
   * Wait for element to have content, then extract it
   */
  private waitForContent(element: Element): void {
    if (this.processedElements.has(element)) {
      return;
    }

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
    let fallbackTimeout: number | null = null;
    let stabilityTimer: number | null = null;
    let lastStableText = '';
    let retryCount = 0;
    let placeholderCount = 0;
    let lastLoggedPlaceholderCount = 0;
    let placeholderWaitActive = false;

    const STABILITY_DELAY = 1200;
    const FALLBACK_DELAY = 25000;
    const PROMPT_WAIT_RETRY_MS = 150;
    const PROMPT_WAIT_MAX_RETRIES = 10;
    const PLACEHOLDER_MAX_RETRIES = 80;

    const cleanup = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (fallbackTimeout !== null) {
        window.clearTimeout(fallbackTimeout);
        fallbackTimeout = null;
      }
      if (stabilityTimer !== null) {
        window.clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }
    };

    const schedulePlaceholderRetry = () => {
      if (placeholderCount >= PLACEHOLDER_MAX_RETRIES) {
        this.logDebug('Gemini placeholder retry limit reached', {
          placeholderCount,
          messageKey: this.getElementKey(element)
        });
        cleanup();
        this.markProcessed(element, this.getElementKey(element));
        return;
      }

      placeholderCount += 1;

      if (!placeholderWaitActive) {
        placeholderWaitActive = true;
        const logDetails = {
          normalized: this.normalizeText(element.textContent || ''),
          placeholderCount
        };

        if ((placeholderCount <= 3 || placeholderCount % 10 === 0) && placeholderCount !== lastLoggedPlaceholderCount) {
          lastLoggedPlaceholderCount = placeholderCount;
          this.logDebug('Gemini placeholder detected, waiting for final content', logDetails);
        }

        window.setTimeout(() => {
          placeholderWaitActive = false;
          finalizeIfReady();
        }, STABILITY_DELAY);
      }
    };

    const finalizeIfReady = () => {
      if (this.processedElements.has(element)) {
        return;
      }

      const text = element.textContent?.trim() || '';
      if (text.length >= 2) {
        const normalizedText = this.normalizeText(text);

        if (this.isGeminiDomain() && this.isGeminiPlaceholder(normalizedText)) {
          schedulePlaceholderRetry();
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
        if (this.isGeminiDomain() && this.isGeminiPlaceholder(normalizedText)) {
          schedulePlaceholderRetry();
          return;
        }

        this.logDebug('Response ready for extraction', {
          textLength: text.length,
          hasPrompt: Boolean(this.pendingPrompt),
          retries: retryCount,
          messageKey
        });
        this.markProcessed(element, messageKey);
        this.extractAndSaveMessage(element);
        placeholderCount = 0;
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

    observer = new MutationObserver(() => {
      const text = element.textContent?.trim() || '';
      if (!text) {
        return;
      }

      if (text !== lastStableText) {
        this.logDebug('Mutation observed', text.substring(0, 120));
        scheduleStabilityCheck(text);
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

      if (this.isGeminiDomain() && this.isGeminiPlaceholder(normalizedText)) {
        schedulePlaceholderRetry();
        return;
      }

      finalizeIfReady();
    }, FALLBACK_DELAY);
  }

  /**
   * Get message selectors based on platform
   */
  private getMessageSelectors(): string[] {
    const domain = this.domain;

    // ChatGPT / OpenAI
    if (domain.includes('chatgpt') || domain.includes('openai')) {
      return [
        '[data-message-author-role="assistant"]',
        '.agent-turn',
        '.markdown',
        '[class*="Message"]',
        ...this.getGenericAssistantSelectors()
      ];
    }

    // Claude
    if (domain.includes('claude')) {
      return [
        '[data-is-streaming="false"]',
        '[class*="AssistantMessage"]',
        '[class*="HumanMessage"]',
        '.font-claude-response-body',
        ...this.getGenericAssistantSelectors()
      ];
    }

    // Gemini
    if (domain.includes('gemini')) {
      return [
        '.model-response',
        '[class*="response"]',
        '[data-test-id*="response"]',
        ...this.getGenericAssistantSelectors()
      ];
    }

    // Grok
    if (domain.includes('grok') || domain.includes('x.ai')) {
      return [
        '[data-testid="assistant-message"]',
        '[data-testid="response-message"]',
        'div[id^="response-"] .response-content-markdown',
        'div[id^="response-"]',
        '[class*="assistant-message"]',
        '[class*="assistantBubble"]',
        '[class*="assistant"]:not([class*="user"])',
        ...this.getGenericAssistantSelectors()
      ];
    }

    // DeepSeek
    if (domain.includes('deepseek')) {
      return [
        '[data-role="assistant"]',
        '.message-content[data-role="assistant"]',
        '.message-content.ai',
        '[data-testid="assistant-message"]',
        '[data-testid*="assistant"]',
        '[data-testid*="response"]',
        '.markdown, .markdown-body, .ds-markdown',
        '.message-content:not([data-role="user"])',
        '[class*="assistant"]:not([class*="user"])',
        '[class*="ai-"]:not([class*="user"])',
        ...this.getGenericAssistantSelectors()
      ];
    }

    // Generic fallback
    return this.getGenericAssistantSelectors();
  }

  private getGenericAssistantSelectors(): string[] {
    return [
      '[data-role*="assistant"]',
      '[data-author*="assistant"]',
      '[class*="assistant"]',
      '[class*="ai-response"]',
      '[role="article"]'
    ];
  }

  /**
   * Extract and save message content
   */
  private extractAndSaveMessage(element: Element): void {
    const text = this.extractText(element);
    
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
    if (this.pendingPrompt && Date.now() - this.pendingPrompt.timestamp < 60000) {
      const responseTime = Date.now() - this.pendingPrompt.timestamp;
      const threadId = this.getConversationId();
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
      this.pendingPrompt = null;
    } else {
      this.logDebug('No pending prompt to pair with response');
    }
  }

  /**
   * Handle user prompt submission
   */
  private handlePrompt(promptText: string): void {
    this.logDebug('Prompt stored', promptText.substring(0, 120));
    const timestamp = Date.now();
    this.pendingPrompt = {
      text: promptText,
      timestamp
    };

    const normalized = this.normalizeText(promptText);
    if (normalized) {
      this.recentPrompts.push({ text: normalized, timestamp });
      if (this.recentPrompts.length > 50) {
        this.recentPrompts.splice(0, this.recentPrompts.length - 50);
      }
    }

    this.pruneRecentPrompts(timestamp);
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
      await chrome.runtime.sendMessage({
        type: 'UPSERT_CONVERSATION_TURNS',
        data: { threadId, threadInfo, turns }
      });
      this.logDebug('Turns upserted', { threadId, count: turns.length });
    } catch (error) {
      console.error('[TrustButVerify] Error upserting turns:', error);
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

    const id = element.id?.trim();
    if (id) {
      return `${this.domain}::${id}`;
    }

    const dataMessageId = element.getAttribute('data-message-id')?.trim();
    if (dataMessageId) {
      return `${this.domain}::${dataMessageId}`;
    }

    const dataMessageUuid = element.getAttribute('data-message-uuid')?.trim();
    if (dataMessageUuid) {
      return `${this.domain}::${dataMessageUuid}`;
    }

    const testId = element.getAttribute('data-testid')?.trim();
    if (testId) {
      return `${this.domain}::${testId}`;
    }

    const text = this.normalizeText(element.textContent || '');
    if (text.length >= 4) {
      const prefix = text.substring(0, 60);
      return `${this.domain}::text::${prefix}::${text.length}`;
    }

    return undefined;
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

  private isGeminiPlaceholder(text: string): boolean {
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
      'just a second',
      'thinking',
      'loading',
      'one moment',
      'one sec',
      'just a moment',
      'give me a moment',
      'show thinking'
    ]);

    if (placeholderPhrases.has(normalized)) {
      return true;
    }

    const stripped = normalized
      .replace(/^show thinking/, '')
      .replace(/^just a second/, '')
      .replace(/^thinking/, '')
      .replace(/^loading/, '')
      .replace(/^one moment/, '')
      .replace(/^one sec/, '')
      .replace(/^just a moment/, '')
      .replace(/^give me a moment/, '')
      .trim();

    if (!stripped) {
      return true;
    }

    if (placeholderPhrases.has(stripped)) {
      return true;
    }

    return false;
  }

  private cleanGeminiText(text: string): string {
    let cleaned = text
      .replace(/Show thinking/gi, ' ')
      .replace(/Just a second(?:\u2026|\.\.\.)?/gi, ' ')
      .replace(/\s{2,}/g, ' ');

    return cleaned.trim();
  }

  private normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
}
