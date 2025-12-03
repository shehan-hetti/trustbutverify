import type { CopyActivity } from '../types';
import { ConversationDetector } from '../utils/conversation-detector';

/**
 * Content script that tracks copy events and conversations on LLM/Gen AI websites
 */
class ActivityTracker {
  private readonly domain: string;
  private conversationDetector: ConversationDetector;

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
    
    // Initialize copy tracking
    document.addEventListener('copy', this.handleCopy.bind(this));
    
    // Initialize conversation tracking
    this.conversationDetector.init();
  }

  /**
   * Handle copy event
   */
  private async handleCopy(event: ClipboardEvent): Promise<void> {
    try {
      const selection = window.getSelection();
      if (!selection || selection.toString().trim().length === 0) {
        return;
      }

      const copiedText = selection.toString().trim();
      
      // Get some context around the selection
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer.parentElement;
      const context = container?.textContent?.substring(0, 200) || '';

      const activity: CopyActivity = {
        id: this.generateId(),
        timestamp: Date.now(),
        url: window.location.href,
        domain: this.domain,
        copiedText: copiedText,
        textLength: copiedText.length,
        selectionContext: context
      };

      // Send to background script
      await this.sendToBackground(activity);
      
      console.log('[TrustButVerify] Copy event tracked:', {
        domain: this.domain,
        length: copiedText.length,
        timestamp: new Date(activity.timestamp).toISOString()
      });
    } catch (error) {
      console.error('[TrustButVerify] Error tracking copy:', error);
    }
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
