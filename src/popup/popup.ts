import type {
  CopyActivity,
  ConversationLog,
  MessageResponse,
  AnalyticsSummary,
  NudgeAggregateStats,
  SyncStatus
} from '../types';

/**
 * Controller for the extension popup UI.
 * Manages conversation list, copy activity list, analytics dashboard,
 * nudge feedback stats, sync status display, and data export.
 */
class PopupController {
  private conversationsList: HTMLElement;
  private activitiesList: HTMLElement;
  private conversationsSection: HTMLElement;
  private copiesSection: HTMLElement;
  private conversationControls: HTMLElement;
  private tabButtons: NodeListOf<HTMLButtonElement>;
  private clearBtn: HTMLButtonElement;
  private searchInput: HTMLInputElement;
  private domainFilter: HTMLSelectElement;
  private exportJsonBtn: HTMLButtonElement;
  private exportCsvBtn: HTMLButtonElement;
  private statTotalConversations: HTMLElement;
  private statTotalCopies: HTMLElement;
  private statAverageResponse: HTMLElement;
  private statTextTotals: HTMLElement;
  private domainBreakdownList: HTMLElement;
  private analyticsSection: HTMLElement;
  private nudgeShown: HTMLElement;
  private nudgeAnswered: HTMLElement;
  private nudgeSkipped: HTMLElement;
  private nudgeDismissRate: HTMLElement;
  private nudgeCopyRate: HTMLElement;
  private nudgeResponseRate: HTMLElement;
  private syncStatusBadge: HTMLElement;
  private syncParticipantId: HTMLElement;
  private syncLastTime: HTMLElement;
  private syncResultMessage: HTMLElement;

  private conversations: ConversationLog[] = [];
  private activities: CopyActivity[] = [];
  private stats: AnalyticsSummary | null = null;
  private nudgeStats: NudgeAggregateStats | null = null;
  private currentTab: 'conversations' | 'copies' = 'conversations';
  private currentSearchTerm = '';
  private currentDomain = '';
  private searchDebounce: number | null = null;
  private conversationRequestToken = 0;

  constructor() {
    this.conversationsList = document.getElementById('conversationsList')!;
    this.activitiesList = document.getElementById('activitiesList')!;
    this.conversationsSection = document.getElementById('conversationsSection')!;
    this.copiesSection = document.getElementById('copiesSection')!;
    this.conversationControls = document.getElementById('conversationControls')!;
    this.tabButtons = document.querySelectorAll('.tab-button');
    this.clearBtn = document.getElementById('clearBtn') as HTMLButtonElement;
    this.searchInput = document.getElementById('searchInput') as HTMLInputElement;
    this.domainFilter = document.getElementById('domainFilter') as HTMLSelectElement;
    this.exportJsonBtn = document.getElementById('exportJsonBtn') as HTMLButtonElement;
    this.exportCsvBtn = document.getElementById('exportCsvBtn') as HTMLButtonElement;
    this.statTotalConversations = document.getElementById('statTotalConversations')!;
    this.statTotalCopies = document.getElementById('statTotalCopies')!;
    this.statAverageResponse = document.getElementById('statAverageResponse')!;
    this.statTextTotals = document.getElementById('statTextTotals')!;
    this.domainBreakdownList = document.getElementById('domainBreakdown')!;
    this.analyticsSection = document.getElementById('analyticsSection')!;
    this.nudgeShown = document.getElementById('nudgeShown')!;
    this.nudgeAnswered = document.getElementById('nudgeAnswered')!;
    this.nudgeSkipped = document.getElementById('nudgeSkipped')!;
    this.nudgeDismissRate = document.getElementById('nudgeDismissRate')!;
    this.nudgeCopyRate = document.getElementById('nudgeCopyRate')!;
    this.nudgeResponseRate = document.getElementById('nudgeResponseRate')!;
    this.syncStatusBadge = document.getElementById('syncStatusBadge')!;
    this.syncParticipantId = document.getElementById('syncParticipantId')!;
    this.syncLastTime = document.getElementById('syncLastTime')!;
    this.syncResultMessage = document.getElementById('syncResultMessage')!;

    this.init();
  }

  private async init(): Promise<void> {
    await this.loadAnalytics();
    await this.loadNudgeStats();
    await this.loadSyncStatus();
    this.populateDomainFilter();
    await Promise.all([this.loadConversations(), this.loadActivities()]);
    this.bindEvents();
    this.renderAnalytics();
    this.renderNudgeStats();
    this.renderConversations();
    this.renderActivities();
    
    // Listen for storage changes to auto-refresh data
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.conversationLogs) {
          this.handleStorageChange();
        }
        if (changes.nudgeEvents) {
          this.loadNudgeStats().then(() => this.renderNudgeStats());
        }
      }
    });
  }

  /** Reload all data and re-render when chrome.storage changes externally. */
  private async handleStorageChange(): Promise<void> {
    await this.loadAnalytics();
    await Promise.all([this.loadConversations(), this.loadActivities()]);
    this.populateDomainFilter();
    this.renderAnalytics();
    this.renderConversations();
    this.renderActivities();
  }

  private bindEvents(): void {
    this.tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab === 'copies' ? 'copies' : 'conversations';
        this.switchTab(tab);
      });
    });

    this.clearBtn.addEventListener('click', () => this.handleClearCopies());

    this.conversationsList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.conversation-toggle');
      if (!target) {
        return;
      }
      this.toggleConversationDetails(target.dataset.toggle!);
    });

    this.domainFilter.addEventListener('change', () => {
      this.currentDomain = this.domainFilter.value;
      this.loadConversations();
    });

    this.searchInput.addEventListener('input', () => {
      if (this.searchDebounce) {
        window.clearTimeout(this.searchDebounce);
      }
      this.searchDebounce = window.setTimeout(() => {
        this.currentSearchTerm = this.searchInput.value.trim();
        this.loadConversations();
      }, 250);
    });

    this.exportJsonBtn.addEventListener('click', () => this.handleExport('json'));
    this.exportCsvBtn.addEventListener('click', () => this.handleExport('csv'));
  }

  private async loadAnalytics(): Promise<void> {
    try {
      this.analyticsSection.classList.remove('has-error');

      const response: MessageResponse = await chrome.runtime.sendMessage({
        type: 'GET_ANALYTICS'
      });

      if (response.success && response.data) {
        this.stats = response.data as AnalyticsSummary;
      }
    } catch (error) {
      console.error('[TrustButVerify] Error loading analytics:', error);
      this.analyticsSection.classList.add('has-error');
    }
  }

  private async loadConversations(): Promise<void> {
    const token = ++this.conversationRequestToken;
    try {
      this.conversationsList.innerHTML = '<p class="empty-state">Loading conversations...</p>';

      const response: MessageResponse = await chrome.runtime.sendMessage({
        type: 'GET_CONVERSATIONS',
        data: {
          limit: 100,
          domain: this.currentDomain || undefined,
          search: this.currentSearchTerm || undefined
        }
      });

      if (token !== this.conversationRequestToken) {
        return;
      }

      if (response.success && Array.isArray(response.data)) {
        this.conversations = response.data as ConversationLog[];
        this.renderConversations();
      }
    } catch (error) {
      console.error('[TrustButVerify] Error loading conversations:', error);
      if (token === this.conversationRequestToken) {
        this.showConversationError('Failed to load conversations');
      }
    }
  }

  private async loadActivities(): Promise<void> {
    try {
      const response: MessageResponse = await chrome.runtime.sendMessage({
        type: 'GET_ACTIVITIES',
        data: { limit: 50 }
      });

      if (response.success && Array.isArray(response.data)) {
        this.activities = response.data as CopyActivity[];
        this.renderActivities();
      }
    } catch (error) {
      console.error('[TrustButVerify] Error loading activities:', error);
      this.showCopyError('Failed to load copy activity');
    }
  }

  private renderAnalytics(): void {
    if (!this.stats) {
      this.statTotalConversations.textContent = '0';
      this.statTotalCopies.textContent = '0';
      this.statAverageResponse.textContent = '0s';
      this.statTextTotals.textContent = '0 → 0';
      this.domainBreakdownList.innerHTML = '<li class="domain-chip">No data yet</li>';
      return;
    }

    const { totalConversations, totalCopies, averageResponseTime, totalPromptLength, totalResponseLength, domainBreakdown } = this.stats;

    this.statTotalConversations.textContent = totalConversations.toString();
    this.statTotalCopies.textContent = totalCopies.toString();
    this.statAverageResponse.textContent = this.formatDuration(averageResponseTime);
    this.statTextTotals.textContent = `${totalPromptLength} → ${totalResponseLength}`;

    const domains = Object.entries(domainBreakdown);
    if (domains.length === 0) {
      this.domainBreakdownList.innerHTML = '<li class="domain-chip">No domains recorded</li>';
    } else {
      this.domainBreakdownList.innerHTML = domains
        .map(([domain, count]) => `<li class="domain-chip">${this.escapeHtml(this.formatDomain(domain))} • ${count}</li>`)
        .join('');
    }
  }

  private async loadNudgeStats(): Promise<void> {
    try {
      const response: MessageResponse = await chrome.runtime.sendMessage({
        type: 'GET_NUDGE_STATS'
      });
      if (response.success && response.data) {
        this.nudgeStats = response.data as NudgeAggregateStats;
      }
    } catch (error) {
      console.error('[TrustButVerify] Error loading nudge stats:', error);
    }
  }

  private renderNudgeStats(): void {
    if (!this.nudgeStats || this.nudgeStats.totalShown === 0) {
      this.nudgeShown.textContent = '0';
      this.nudgeAnswered.textContent = '0';
      this.nudgeSkipped.textContent = '0';
      this.nudgeDismissRate.textContent = '0%';
      this.nudgeCopyRate.textContent = 'Copy: 0%';
      this.nudgeResponseRate.textContent = 'Response: 0%';
      return;
    }

    const { totalShown, answered, skipped, dismissRateByQuestionType } = this.nudgeStats;
    const overallDismissRate = totalShown > 0 ? Math.round((skipped / totalShown) * 100) : 0;

    this.nudgeShown.textContent = totalShown.toString();
    this.nudgeAnswered.textContent = answered.toString();
    this.nudgeSkipped.textContent = skipped.toString();
    this.nudgeDismissRate.textContent = `${overallDismissRate}%`;
    this.nudgeCopyRate.textContent = `Copy: ${Math.round((dismissRateByQuestionType.copy || 0) * 100)}%`;
    this.nudgeResponseRate.textContent = `Response: ${Math.round((dismissRateByQuestionType.response || 0) * 100)}%`;
  }

  /** Populate the domain dropdown from the current analytics breakdown. */
  private populateDomainFilter(): void {
    if (!this.stats) {
      return;
    }

    while (this.domainFilter.options.length > 1) {
      this.domainFilter.remove(1);
    }

    const domains = Object.keys(this.stats.domainBreakdown).sort();
    const fragment = document.createDocumentFragment();
    domains.forEach((domain) => {
      const option = document.createElement('option');
      option.value = domain;
      option.textContent = this.formatDomain(domain);
      fragment.appendChild(option);
    });
    this.domainFilter.appendChild(fragment);

    if (this.currentDomain) {
      this.domainFilter.value = this.currentDomain;
    }
  }

  private renderConversations(): void {
    if (this.conversations.length === 0) {
      this.conversationsList.innerHTML = '<p class="empty-state">No conversations found</p>';
      return;
    }
    // Display newest first by reversing
    const reversed = [...this.conversations].reverse();
    this.conversationsList.innerHTML = reversed
      .map((conversation) => this.createConversationHTML(conversation))
      .join('');
  }

  private createConversationHTML(conversation: ConversationLog): string {
    const date = new Date(conversation.lastUpdatedAt || conversation.createdAt || Date.now());
    const timeAgo = this.getTimeAgo(date);
    const id = `conversation-${conversation.id}`;
    const title = conversation.title;
    const promptCount = conversation.turns.length;
    const responseCount = conversation.turns.length;
    const totalPromptLength = conversation.turns.reduce((s, t) => s + t.prompt.textLength, 0);
    const totalResponseLength = conversation.turns.reduce((s, t) => s + t.response.textLength, 0);

    const metaChips = [
      `${promptCount} prompts`,
      `${responseCount} responses`,
      `Prompt ${totalPromptLength} chars`,
      `Response ${totalResponseLength} chars`,
      date.toLocaleString()
    ];

    // Show last user + assistant turns if available
    const last = conversation.turns[conversation.turns.length - 1];
    const lastUserText = last ? last.prompt.text : '(no user turn)';
    const lastAssistantText = last ? last.response.text : '(no assistant turn)';

    return `
      <div class="conversation-item" data-id="${conversation.id}">
        <div class="conversation-header">
          <span class="conversation-domain">${this.escapeHtml(this.formatDomain(conversation.domain))}${title ? ` • ${this.escapeHtml(title)}` : ''}</span>
          <span class="conversation-time">${timeAgo}</span>
        </div>
        <div class="conversation-meta">
          ${metaChips.map((chip) => `<span class="meta-chip">${this.escapeHtml(chip)}</span>`).join('')}
        </div>
        <button class="conversation-toggle" data-toggle="${conversation.id}" aria-controls="${id}" aria-expanded="false">
          View latest turns
          <span class="chevron">▾</span>
        </button>
        <div class="conversation-details" id="${id}">
          <div class="conversation-block prompt"><strong>Latest Prompt</strong>\n${this.escapeHtml(lastUserText)}</div>
          <div class="conversation-block response"><strong>Latest Response</strong>\n${this.escapeHtml(lastAssistantText)}</div>
        </div>
      </div>
    `;
  }

  private renderActivities(): void {
    if (this.activities.length === 0) {
      this.activitiesList.innerHTML = '<p class="empty-state">No copy activities yet</p>';
      this.clearBtn.disabled = true;
      return;
    }

    this.clearBtn.disabled = false;
    // Show newest first by reversing
    const reversed = [...this.activities].reverse();
    this.activitiesList.innerHTML = reversed
      .map((activity) => this.createActivityHTML(activity))
      .join('');
  }

  private createActivityHTML(activity: CopyActivity): string {
    const date = new Date(activity.timestamp);
    const timeAgo = this.getTimeAgo(date);
    const displayText = this.truncateText(activity.copiedText, 150);

    return `
      <div class="activity-item">
        <div class="activity-header">
          <span class="activity-domain">${this.escapeHtml(this.formatDomain(activity.domain))}</span>
          <span class="activity-time">${timeAgo}</span>
        </div>
        <div class="activity-text">${this.escapeHtml(displayText)}</div>
        <div class="activity-meta">
          ${activity.textLength} characters • ${date.toLocaleTimeString()}
        </div>
      </div>
    `;
  }

  private async handleClearCopies(): Promise<void> {
    if (!confirm('Clear all stored copy activity?')) {
      return;
    }

    try {
      const response: MessageResponse = await chrome.runtime.sendMessage({
        type: 'CLEAR_ACTIVITIES'
      });

      if (response.success) {
        await Promise.all([this.loadActivities(), this.loadAnalytics()]);
        this.populateDomainFilter();
        this.renderAnalytics();
      }
    } catch (error) {
      console.error('[TrustButVerify] Error clearing activity:', error);
      this.showCopyError('Failed to clear activities');
    }
  }

  /** Export conversations as JSON or CSV download. */
  private handleExport(format: 'json' | 'csv'): void {
    if (this.conversations.length === 0) {
      alert('No conversations available to export yet.');
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      const blob = new Blob([JSON.stringify(this.conversations, null, 2)], { type: 'application/json' });
      this.downloadBlob(blob, `tbv-conversations-${timestamp}.json`);
    } else {
      const csv = this.createCsv(this.conversations);
      const blob = new Blob([csv], { type: 'text/csv' });
      this.downloadBlob(blob, `tbv-conversations-${timestamp}.csv`);
    }
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Build a CSV string from conversations — one row per turn for easier
   * analysis in spreadsheet tools.
   */
  private createCsv(conversations: ConversationLog[]): string {
    // One row per turn for easier analysis
    const headers = ['conversationId', 'domain', 'createdAt', 'lastUpdatedAt', 'promptTs', 'responseTs', 'responseTimeMs', 'promptLength', 'responseLength', 'promptText', 'responseText', 'url'];
    const rows: string[] = [];
    conversations.forEach((c) => {
      c.turns.forEach((t) => {
        const cells: Array<string | number | undefined> = [
          c.id,
          c.domain,
          new Date(c.createdAt).toISOString(),
          new Date(c.lastUpdatedAt).toISOString(),
          new Date(t.prompt.ts).toISOString(),
          new Date(t.response.ts).toISOString(),
          t.responseTimeMs,
          t.prompt.textLength,
          t.response.textLength,
          t.prompt.text,
          t.response.text,
          c.url
        ];
        rows.push(cells.map((cell) => this.escapeCsv(String(cell ?? ''))).join(','));
      });
    });
    return [headers.join(','), ...rows].join('\n');
  }

  /** Quote and escape a CSV cell value (RFC 4180). */
  private escapeCsv(value: string): string {
    if (value.includes('"') || value.includes(',') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private switchTab(tab: 'conversations' | 'copies'): void {
    if (this.currentTab === tab) {
      return;
    }

    this.currentTab = tab;

    this.tabButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab);
    });

    const showConversations = tab === 'conversations';
    this.conversationsSection.hidden = !showConversations;
    this.conversationControls.style.display = showConversations ? 'flex' : 'none';
    this.copiesSection.hidden = showConversations;
  }

  private toggleConversationDetails(conversationId: string): void {
    const details = document.getElementById(`conversation-${conversationId}`);
    const toggle = this.conversationsList.querySelector<HTMLButtonElement>(`.conversation-toggle[data-toggle="${conversationId}"]`);
    if (!details || !toggle) {
      return;
    }

    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    details.classList.toggle('show', !expanded);

    const chevron = toggle.querySelector('.chevron');
    if (chevron) {
      chevron.textContent = expanded ? '▾' : '▴';
    }
  }

  private showConversationError(message: string): void {
    this.conversationsList.innerHTML = `<p class="empty-state" style="color: #ff4757;">${this.escapeHtml(message)}</p>`;
  }

  /* ---------------------------------------------------------------- */
  /*  Sync UI                                                          */
  /* ---------------------------------------------------------------- */

  private async loadSyncStatus(): Promise<void> {
    try {
      const response: MessageResponse = await chrome.runtime.sendMessage({
        type: 'GET_SYNC_STATUS'
      });
      if (response.success && response.data) {
        const data = response.data as {
          participantUuid?: string;
          lastSyncAt?: number;
          syncStatus: SyncStatus;
        };
        this.renderSyncStatus(data.syncStatus, data.participantUuid, data.lastSyncAt);
      }
    } catch (err) {
      console.error('[TrustButVerify] Error loading sync status:', err);
    }
  }

  private renderSyncStatus(
    status: SyncStatus,
    participantUuid?: string,
    lastSyncAt?: number
  ): void {
    // Badge
    this.syncStatusBadge.textContent = status;
    this.syncStatusBadge.className = 'sync-status-badge';
    if (status !== 'idle') {
      this.syncStatusBadge.classList.add(`status-${status}`);
    }

    // Participant UUID (truncated)
    if (participantUuid) {
      this.syncParticipantId.textContent = participantUuid.substring(0, 8) + '…';
      this.syncParticipantId.title = participantUuid;
    } else {
      this.syncParticipantId.textContent = '—';
    }

    // Last sync time
    if (lastSyncAt) {
      this.syncLastTime.textContent = this.getTimeAgo(new Date(lastSyncAt));
      this.syncLastTime.title = new Date(lastSyncAt).toLocaleString();
    } else {
      this.syncLastTime.textContent = 'Never';
    }
  }

  private showCopyError(message: string): void {
    this.activitiesList.innerHTML = `<p class="empty-state" style="color: #ff4757;">${this.escapeHtml(message)}</p>`;
  }

  private formatDomain(domain: string): string {
    return domain.replace(/^www\./, '');
  }

  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

    return date.toLocaleDateString();
  }

  private formatDuration(milliseconds: number): string {
    if (!milliseconds || Number.isNaN(milliseconds)) {
      return '0s';
    }

    if (milliseconds < 1000) {
      return `${Math.round(milliseconds)}ms`;
    }

    return `${(milliseconds / 1000).toFixed(1)}s`;
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.substring(0, maxLength)}...`;
  }

  /** XSS-safe HTML escaping via textContent round-trip. */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new PopupController());
} else {
  new PopupController();
}
