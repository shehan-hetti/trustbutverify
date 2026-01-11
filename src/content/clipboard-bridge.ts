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

  const reportCopy = (text: unknown, method: string) => {
    const normalized = safeString(text).trim();
    if (!normalized) {
      return;
    }

    let descriptor: ReturnType<typeof describeElement> = null;
    try {
      descriptor = describeElement(document.activeElement);
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
