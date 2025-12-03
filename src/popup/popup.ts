import type {
  CopyActivity,
  ConversationLog,
  MessageResponse,
  AnalyticsSummary
} from '../types';

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

  private conversations: ConversationLog[] = [];
  private activities: CopyActivity[] = [];
  private stats: AnalyticsSummary | null = null;
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

    this.init();
  }

  private async init(): Promise<void> {
    await this.loadAnalytics();
    this.populateDomainFilter();
    await Promise.all([this.loadConversations(), this.loadActivities()]);
    this.bindEvents();
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

    this.conversationsList.innerHTML = this.conversations
      .map((conversation) => this.createConversationHTML(conversation))
      .join('');
  }

  private createConversationHTML(conversation: ConversationLog): string {
    const date = new Date(conversation.timestamp);
    const timeAgo = this.getTimeAgo(date);
    const responseTime = conversation.responseTime ? this.formatDuration(conversation.responseTime) : '—';
    const id = `conversation-${conversation.id}`;
    const title = conversation.metadata?.conversationTitle;
    const messageCount = conversation.metadata?.messageCount;

    const metaChips = [
      `Prompt ${conversation.promptLength} chars`,
      `Response ${conversation.responseLength} chars`
    ];

    if (conversation.responseTime) {
      metaChips.push(`Response time ${responseTime}`);
    }

    if (messageCount) {
      metaChips.push(`${messageCount} messages in session`);
    }

    metaChips.push(date.toLocaleString());

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
          View prompt & response
          <span class="chevron">▾</span>
        </button>
        <div class="conversation-details" id="${id}">
          <div class="conversation-block prompt"><strong>Prompt</strong>\n${this.escapeHtml(conversation.userPrompt)}</div>
          <div class="conversation-block response"><strong>Response</strong>\n${this.escapeHtml(conversation.llmResponse)}</div>
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
    this.activitiesList.innerHTML = this.activities
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

  private createCsv(conversations: ConversationLog[]): string {
    const headers = ['timestamp', 'domain', 'userPrompt', 'llmResponse', 'responseTimeMs', 'promptLength', 'responseLength', 'sessionId', 'url'];
    const rows = conversations.map((conversation) => {
      const cells: Array<string | number | undefined> = [
        new Date(conversation.timestamp).toISOString(),
        conversation.domain,
        conversation.userPrompt,
        conversation.llmResponse,
        conversation.responseTime,
        conversation.promptLength,
        conversation.responseLength,
        conversation.sessionId,
        conversation.url
      ];

      return cells.map((cell) => this.escapeCsv(String(cell ?? ''))).join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

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
