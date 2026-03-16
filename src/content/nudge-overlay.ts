import type { NudgeAnswerMode, NudgeResponseValue, NudgeTriggerType } from '../types';

export type NudgeOverlayPosition = 'top-right' | 'middle-right' | 'bottom-right';

export interface NudgeOverlayPayload {
  questionId: string;
  questionText: string;
  answerMode: NudgeAnswerMode;
  triggerType: NudgeTriggerType;
  conversationId?: string;
  turnId?: string;
  copyActivityId?: string;
  timeoutMs?: number;
  position?: NudgeOverlayPosition;
  ratingLabels?: { low: string; high: string };
  yesLabel?: string;
}

export interface NudgeOverlayResolution {
  questionId: string;
  questionText: string;
  response: NudgeResponseValue;
  responseTimeMs: number;
  triggerType: NudgeTriggerType;
  conversationId?: string;
  turnId?: string;
  copyActivityId?: string;
  dismissedBy: 'answer' | 'skip' | 'close' | 'timeout' | 'replaced';
}

interface ActiveNudgeState {
  payload: NudgeOverlayPayload;
  shownAt: number;
  timeoutId: number;
}

export class NudgeOverlay {
  // ── DOM references ──────────────────────────────────────────────────
  private readonly host: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly questionEl: HTMLDivElement;
  private readonly answersEl: HTMLDivElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private active: ActiveNudgeState | null = null;
  private onResolve?: (result: NudgeOverlayResolution) => void;

  constructor() {
    // ── Build the overlay DOM tree ────────────────────────────────────
    // All styles are inline to avoid CSS conflicts with the host page.
    this.host = document.createElement('div');
    this.host.id = '__tbv_nudge_overlay';
    this.host.setAttribute('aria-live', 'polite');
    this.host.style.position = 'fixed';
    this.host.style.zIndex = '2147483646';
    this.host.style.pointerEvents = 'none';
    this.host.style.display = 'none';

    this.card = document.createElement('div');
    this.card.style.width = 'min(560px, calc(100vw - 24px))';
    this.card.style.background = '#10131a';
    this.card.style.color = '#f4f7ff';
    this.card.style.border = '1px solid rgba(255,255,255,0.12)';
    this.card.style.borderRadius = '16px';
    this.card.style.padding = '20px';
    this.card.style.boxShadow = '0 10px 28px rgba(0,0,0,0.35)';
    this.card.style.pointerEvents = 'auto';
    this.card.style.fontFamily = 'Inter, system-ui, sans-serif';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.marginBottom = '8px';

    this.titleEl = document.createElement('div');
    this.titleEl.style.fontSize = '16px';
    this.titleEl.style.fontWeight = '700';
    this.titleEl.style.opacity = '0.95';

    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.textContent = '✕';
    this.closeButton.setAttribute('aria-label', 'Close nudge');
    this.closeButton.style.border = 'none';
    this.closeButton.style.background = 'transparent';
    this.closeButton.style.color = '#d7deef';
    this.closeButton.style.cursor = 'pointer';
    this.closeButton.style.fontSize = '15px';
    this.closeButton.style.padding = '2px 4px';

    header.appendChild(this.titleEl);
    header.appendChild(this.closeButton);

    this.questionEl = document.createElement('div');
    this.questionEl.style.fontSize = '15px';
    this.questionEl.style.lineHeight = '1.55';
    this.questionEl.style.marginBottom = '18px';

    this.answersEl = document.createElement('div');
    this.answersEl.style.display = 'flex';
    this.answersEl.style.flexWrap = 'wrap';
    this.answersEl.style.gap = '8px';

    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.justifyContent = 'flex-end';
    footer.style.marginTop = '14px';

    this.skipButton = document.createElement('button');
    this.skipButton.type = 'button';
    this.skipButton.textContent = 'Skip';
    this.skipButton.style.border = '1px solid rgba(255,255,255,0.22)';
    this.skipButton.style.background = 'transparent';
    this.skipButton.style.color = '#f4f7ff';
    this.skipButton.style.borderRadius = '10px';
    this.skipButton.style.padding = '10px 14px';
    this.skipButton.style.cursor = 'pointer';
    this.skipButton.style.fontSize = '14px';

    footer.appendChild(this.skipButton);

    this.card.appendChild(header);
    this.card.appendChild(this.questionEl);
    this.card.appendChild(this.answersEl);
    this.card.appendChild(footer);
    this.host.appendChild(this.card);

    // ── Wire up dismiss / skip handlers ───────────────────────────────
    this.closeButton.addEventListener('click', () => {
      this.resolve('skip', 'close');
    });

    this.skipButton.addEventListener('click', () => {
      this.resolve('skip', 'skip');
    });

    // Defer DOM attachment until body is ready; use body to share ChatGPT's stacking context
    const attach = () => {
      const target = document.body || document.documentElement;
      target.appendChild(this.host);
    };
    if (document.body) {
      attach();
    } else {
      document.addEventListener('DOMContentLoaded', attach, { once: true });
    }
    this.applyPosition('bottom-right');
  }

  setOnResolve(handler: (result: NudgeOverlayResolution) => void): void {
    this.onResolve = handler;
  }

  show(payload: NudgeOverlayPayload): void {
    if (this.active) {
      this.resolve('skip', 'replaced');
    }

    const timeoutMs = Math.max(1000, payload.timeoutMs ?? 60_000);
    this.applyPosition(payload.position || 'bottom-right');

    this.titleEl.textContent = payload.triggerType === 'copy' ? 'Quick check • Copied text' : 'Quick check • Response';
    this.questionEl.textContent = payload.questionText;

    this.renderAnswerButtons(payload.answerMode, payload.yesLabel, payload.ratingLabels);

    // Re-attach if somehow removed from DOM
    if (!this.host.isConnected) {
      (document.body || document.documentElement).appendChild(this.host);
    }

    this.host.style.display = 'block';
    console.log('[TrustButVerify] Nudge overlay visible — host in DOM:', this.host.isConnected, 'display:', this.host.style.display);

    const timeoutId = window.setTimeout(() => {
      this.resolve('skip', 'timeout');
    }, timeoutMs);

    this.active = {
      payload,
      shownAt: Date.now(),
      timeoutId
    };
  }

  hide(): void {
    if (!this.active) {
      this.host.style.display = 'none';
      return;
    }
    this.resolve('skip', 'close');
  }

  dispose(): void {
    if (this.active) {
      window.clearTimeout(this.active.timeoutId);
      this.active = null;
    }
    this.host.remove();
  }

  // ── Answer button rendering per answer mode ─────────────────────────
  private renderAnswerButtons(
    mode: NudgeAnswerMode,
    yesLabel?: string,
    ratingLabels?: { low: string; high: string }
  ): void {
    this.answersEl.innerHTML = '';

    const addButton = (label: string, value: NudgeResponseValue, primary = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.border = primary ? '1px solid #8db7ff' : '1px solid rgba(255,255,255,0.18)';
      button.style.background = primary ? 'rgba(71, 126, 255, 0.25)' : 'rgba(255,255,255,0.06)';
      button.style.color = '#f4f7ff';
      button.style.borderRadius = '10px';
      button.style.padding = '10px 12px';
      button.style.cursor = 'pointer';
      button.style.fontSize = '14px';
      button.addEventListener('click', () => this.resolve(value, 'answer'));
      this.answersEl.appendChild(button);
    };

    if (mode === 'yes_no_skip') {
      addButton(yesLabel ?? 'Yes', 'yes', true);
      addButton('No', 'no');
      return;
    }

    if (mode === 'yes_partly_no_skip') {
      addButton(yesLabel ?? 'Yes', 'yes', true);
      addButton('Partly', 'partly');
      addButton('No', 'no');
      return;
    }

    for (let i = 1; i <= 10; i++) {
      addButton(String(i), i as NudgeResponseValue);
    }

    if (ratingLabels) {
      const labelRow = document.createElement('div');
      labelRow.style.width = '100%';
      labelRow.style.display = 'flex';
      labelRow.style.justifyContent = 'space-between';
      labelRow.style.fontSize = '13px';
      labelRow.style.opacity = '0.6';
      labelRow.style.marginTop = '2px';
      const lowSpan = document.createElement('span');
      lowSpan.textContent = `1 = ${ratingLabels.low}`;
      const highSpan = document.createElement('span');
      highSpan.textContent = `10 = ${ratingLabels.high}`;
      labelRow.appendChild(lowSpan);
      labelRow.appendChild(highSpan);
      this.answersEl.appendChild(labelRow);
    }
  }

  // ── Resolve the active nudge and notify the callback ────────────────
  private resolve(response: NudgeResponseValue, dismissedBy: NudgeOverlayResolution['dismissedBy']): void {
    if (!this.active) {
      this.host.style.display = 'none';
      return;
    }

    const { payload, shownAt, timeoutId } = this.active;
    this.active = null;
    window.clearTimeout(timeoutId);

    this.host.style.display = 'none';

    if (!this.onResolve) {
      return;
    }

    this.onResolve({
      questionId: payload.questionId,
      questionText: payload.questionText,
      response,
      responseTimeMs: Math.max(0, Date.now() - shownAt),
      triggerType: payload.triggerType,
      conversationId: payload.conversationId,
      turnId: payload.turnId,
      copyActivityId: payload.copyActivityId,
      dismissedBy
    });
  }

  // ── Position the overlay on screen ──────────────────────────────────
  private applyPosition(position: NudgeOverlayPosition): void {
    if (position === 'middle-right') {
      this.host.style.right = '12px';
      this.host.style.top = '50%';
      this.host.style.transform = 'translateY(-50%)';
      this.host.style.left = 'auto';
      this.host.style.bottom = 'auto';
      return;
    }

    if (position === 'bottom-right') {
      this.host.style.right = '12px';
      this.host.style.bottom = '12px';
      this.host.style.transform = 'none';
      this.host.style.left = 'auto';
      this.host.style.top = 'auto';
      return;
    }

    this.host.style.right = '12px';
    this.host.style.top = '12px';
    this.host.style.transform = 'none';
    this.host.style.left = 'auto';
    this.host.style.bottom = 'auto';
  }
}
