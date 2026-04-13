/**
 * Clipboard Bridge — injected into the PAGE context (not the content-script
 * isolated world) so it can monkey-patch the real `navigator.clipboard` and
 * `document.execCommand('copy')` APIs that the host page calls.
 *
 * When a programmatic copy is detected it posts a `window.postMessage` to the
 * content-script world, which forwards the event to the background service
 * worker for storage and enrichment.
 *
 * Why page-context injection is needed:
 *  Content scripts run in an isolated JS world and cannot intercept calls the
 *  page makes to platform APIs. This IIFE is injected via a <script> tag so
 *  it shares the page's global scope and can wrap the clipboard methods.
 */
(() => {
  const globalWindow = window as typeof window & {
    __TBV_CLIPBOARD_BRIDGE__?: boolean;
  };

  if (globalWindow.__TBV_CLIPBOARD_BRIDGE__) {
    return;
  }

  Object.defineProperty(globalWindow, '__TBV_CLIPBOARD_BRIDGE__', {
    value: true,
    configurable: true
  });

  const SOURCE = 'trust-but-verify';
  const MESSAGE = 'TBV_PROGRAMMATIC_COPY';

  const safeString = (value: unknown): string => {
    if (typeof value === 'string') {
      return value;
    }
    if (value == null) {
      return '';
    }
    try {
      return String(value);
    } catch (error) {
      return '';
    }
  };

  const describeElement = (element: Element | null) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const el = element as HTMLElement;
    let classes = '';
    try {
      classes = el.classList ? Array.from(el.classList).slice(0, 5).join(' ') : '';
    } catch (error) {
      classes = '';
    }

    let textPreview = '';
    try {
      textPreview = el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    } catch (error) {
      textPreview = '';
    }

    return {
      tag: el.tagName ? el.tagName.toLowerCase() : undefined,
      classes: classes || undefined,
      role: el.getAttribute ? el.getAttribute('role') || undefined : undefined,
      ariaLabel: el.getAttribute ? el.getAttribute('aria-label') || undefined : undefined,
      dataTestId: el.getAttribute ? el.getAttribute('data-testid') || undefined : undefined,
      textPreview: textPreview ? textPreview.substring(0, 160) : undefined
    };
  };

  /**
   * Walk up from a button/icon to find the nearest turn container element.
   * Returns the turn container if found, otherwise the original element.
   */
  const resolveFromButton = (el: Element | null): Element | null => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return el;
    const tag = (el as HTMLElement).tagName?.toLowerCase() || '';
    const isButtonLike = tag === 'button' || tag === 'svg' || tag === 'path'
      || el.closest('button') !== null
      || el.closest('[role="button"]') !== null;
    if (!isButtonLike) return el;

    // Try platform-specific turn container selectors.
    const selectors = [
      '[data-testid^="conversation-turn-"]',
      'div[data-message-author-role]',
      '.font-claude-response',
      '[data-testid="user-message"]',
      'model-response',
      'message-content',
      'div[id^="response-"]',
      '.ds-message'
    ];
    for (const sel of selectors) {
      try {
        const container = el.closest(sel);
        if (container) return container;
      } catch { /* ignore */ }
    }
    return el;
  };

  const reportCopy = (text: unknown, method: string) => {
    const normalized = safeString(text).trim();
    if (!normalized) {
      return;
    }

    let descriptor: ReturnType<typeof describeElement> = null;
    try {
      // Resolve from button/icon to the nearest turn container for better metadata.
      const rawEl = document.activeElement;
      const resolved = resolveFromButton(rawEl);
      descriptor = describeElement(resolved);
    } catch (error) {
      descriptor = null;
    }

    try {
      window.postMessage({
        source: SOURCE,
        type: MESSAGE,
        payload: {
          text: normalized,
          method,
          element: descriptor || undefined
        }
      }, window.location.origin);
    } catch (error) {
      console.debug('[TrustButVerify] Failed to notify clipboard bridge:', error);
    }
  };

  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    const originalWriteText = clipboard.writeText.bind(clipboard);

    clipboard.writeText = function patchedWriteText(...args: Parameters<Clipboard['writeText']>) {
      try {
        reportCopy(args[0], 'navigator.clipboard.writeText');
      } catch (error) {
        console.debug('[TrustButVerify] page clipboard writeText hook error:', error);
      }
      return originalWriteText(...args);
    };
  }

  if (clipboard && typeof clipboard.write === 'function') {
    const originalWrite = clipboard.write.bind(clipboard);

    clipboard.write = function patchedWrite(...args: Parameters<Clipboard['write']>) {
      const [items] = args;

      if (Array.isArray(items)) {
        items.forEach((item) => {
          if (!item || typeof item !== 'object') {
            return;
          }

          const types = Array.isArray((item as ClipboardItem).types)
            ? (item as ClipboardItem).types
            : [];

          if (types.includes('text/plain') && typeof (item as ClipboardItem).getType === 'function') {
            Promise.resolve((item as ClipboardItem).getType('text/plain'))
              .then((blob) => (blob && typeof blob.text === 'function' ? blob.text() : ''))
              .then((text) => {
                if (text) {
                  reportCopy(text, 'navigator.clipboard.write');
                }
              })
              .catch(() => undefined);
          }
        });
      }

      return originalWrite(...args);
    };
  }

  if (typeof document.execCommand === 'function') {
    const originalExecCommand = document.execCommand.bind(document);

    document.execCommand = function patchedExecCommand(commandId: string, showUI?: boolean, value?: unknown): boolean {
      if (typeof commandId === 'string' && commandId.toLowerCase() === 'copy') {
        try {
          const selection = window.getSelection();
          const selectedText = selection && selection.rangeCount > 0
            ? selection.toString()
            : '';

          if (selectedText) {
            reportCopy(selectedText, 'document.execCommand(copy)');
          }
        } catch (error) {
          console.debug('[TrustButVerify] execCommand copy hook error:', error);
        }
      }

      const normalizedValue = typeof value === 'string' ? value : undefined;
      return originalExecCommand(commandId, showUI ?? false, normalizedValue);
    };
  }
})();
