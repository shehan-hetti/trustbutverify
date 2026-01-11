import type { CopyActivity, CopyActivityTrigger } from '../types';
import { ConversationDetector } from '../utils/conversation-detector';

/**
 * Content script that tracks copy events and conversations on LLM/Gen AI websites
 */
class ActivityTracker {
  private readonly domain: string;
  private conversationDetector: ConversationDetector;
  private lastInteractedElement: HTMLElement | null = null;
  private readonly copySignatureCache = new Map<string, number>();
  private static readonly COPY_SIGNATURE_TTL = 750;
  private static readonly PROGRAMMATIC_COPY_MESSAGE = 'TBV_PROGRAMMATIC_COPY';

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

    window.addEventListener('beforeunload', () => {
      window.removeEventListener('message', this.handleBridgeMessage);
    });
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

      const { context, element } = this.extractSelectionContext(selection);
      const fallbackElement = (element as HTMLElement | null)
        || (event.target as HTMLElement | null)
        || this.lastInteractedElement
        || (document.activeElement as HTMLElement | null)
        || null;

      await this.recordCopy(copiedText, context || this.buildContextFromElement(fallbackElement, copiedText), {
        type: 'selection',
        method: event.clipboardData ? 'copy-event' : 'copy-event-selection',
        ...this.describeElement(fallbackElement)
      });

      console.log('[TrustButVerify] Copy event tracked:', {
        domain: this.domain,
        length: copiedText.length,
        method: 'copy',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TrustButVerify] Error tracking copy:', error);
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
    const context = metadata?.context?.trim()
      ? metadata.context.trim().substring(0, 200)
      : this.buildContextFromElement(element, trimmed);

    const fallbackMetadata = this.describeElement(element) || {};
    const combinedMetadata: Partial<CopyActivityTrigger> = {
      ...fallbackMetadata,
      ...(metadata?.trigger || {})
    };

    const trigger: CopyActivityTrigger = {
      type: 'programmatic',
      method,
      ...combinedMetadata
    };

    this.recordCopy(trimmed, context, trigger).catch((error) => {
      console.error('[TrustButVerify] Error tracking programmatic copy:', error);
    });

    console.log('[TrustButVerify] Copy event tracked:', {
      domain: this.domain,
      length: trimmed.length,
      method,
      timestamp: new Date().toISOString()
    });
  }

  private async recordCopy(copiedText: string, context: string, trigger: CopyActivityTrigger): Promise<void> {
    const trimmed = copiedText.trim();
    if (!trimmed) {
      return;
    }

    const signature = `${trigger.type}:${trigger.method || 'unknown'}:${trimmed}`;
    if (!this.shouldRecordSignature(signature)) {
      return;
    }

    const activity: CopyActivity = {
      id: this.generateId(),
      timestamp: Date.now(),
      url: window.location.href,
      domain: this.domain,
      conversationId: this.conversationDetector.getConversationId(),
      copiedText: trimmed,
      textLength: trimmed.length,
      selectionContext: context ? context.substring(0, 200) : undefined,
      trigger: this.cleanTriggerMetadata(trigger)
    };

    await this.sendToBackground(activity);
  }

  private cleanTriggerMetadata(trigger: CopyActivityTrigger): CopyActivityTrigger {
    const cleaned: CopyActivityTrigger = { type: trigger.type };
    if (trigger.method) {
      cleaned.method = trigger.method;
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
    if (element && element.textContent) {
      const text = element.textContent.trim();
      if (text.length > 0) {
        return text.substring(0, 200);
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
      await chrome.runtime.sendMessage({
        type: 'COPY_EVENT',
        data: activity
      });
    } catch (error) {
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
