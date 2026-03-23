import type { NudgeAnswerMode, NudgeResponseValue, NudgeTriggerType } from '../types';

export type NudgeOverlayPosition = 'top-right' | 'middle-right' | 'bottom-right';

export interface NudgeOverlayQuestionPayload {
  questionId: string;
  questionText: string;
  answerMode: NudgeAnswerMode;
  ratingLabels?: { low: string; high: string };
  yesLabel?: string;
  questionTags?: string[];
}

export interface NudgeOverlayPayload {
  triggerType: NudgeTriggerType;
  conversationId?: string;
  turnId?: string;
  copyActivityId?: string;
  timeoutMs?: number;
  position?: NudgeOverlayPosition;
  textPreview?: string;
  questions: NudgeOverlayQuestionPayload[];
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
  questionTags?: string[];
  dismissedBy: 'answer' | 'skip' | 'close' | 'timeout' | 'replaced';
}

interface ActiveNudgeState {
  payload: NudgeOverlayPayload;
  shownAt: number;
  timeoutId: number;
  unansweredQuestions: Set<string>;
  explicitlyAnsweredCount: number;
}

export class NudgeOverlay {
  // ── DOM references ──────────────────────────────────────────────────
  private readonly host: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly previewContainer: HTMLDivElement;
  private readonly questionsContainer: HTMLDivElement;
  private readonly scrollIndicator: HTMLDivElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private active: ActiveNudgeState | null = null;
  private onResolve?: (result: NudgeOverlayResolution) => void;
  private onSessionComplete?: (fullSkip: boolean, triggerType: NudgeTriggerType) => void;

  constructor() {
    // ── Build the overlay DOM tree ────────────────────────────────────
    this.host = document.createElement('div');
    this.host.id = '__tbv_nudge_overlay';
    this.host.setAttribute('aria-live', 'polite');
    this.host.style.position = 'fixed';
    this.host.style.zIndex = '2147483646';
    this.host.style.pointerEvents = 'none';
    this.host.style.display = 'none';

    // Inject custom scrollbar styles scoped to this overlay
    const style = document.createElement('style');
    style.textContent = `
      #__tbv_nudge_overlay_questions::-webkit-scrollbar {
        width: 6px;
      }
      #__tbv_nudge_overlay_questions::-webkit-scrollbar-track {
        background: transparent;
        border-radius: 4px;
      }
      #__tbv_nudge_overlay_questions::-webkit-scrollbar-thumb {
        background: transparent;
        border-radius: 4px;
      }
      #__tbv_nudge_overlay_questions:hover::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.03);
      }
      #__tbv_nudge_overlay_questions:hover::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
      }
      #__tbv_nudge_overlay_questions::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.25);
      }
    `;
    this.host.appendChild(style);

    this.card = document.createElement('div');
    this.card.style.width = 'min(610px, calc(100vw - 24px))';
    this.card.style.maxHeight = 'calc(100vh - 40px)';
    this.card.style.display = 'flex';
    this.card.style.flexDirection = 'column';
    this.card.style.background = '#10131a';
    this.card.style.color = '#f4f7ff';
    this.card.style.border = '1px solid rgba(255,255,255,0.12)';
    this.card.style.borderRadius = '16px';
    this.card.style.padding = '20px';
    this.card.style.boxShadow = '0 10px 40px rgba(0,0,0,0.4)';
    this.card.style.pointerEvents = 'auto';
    this.card.style.fontFamily = 'Inter, system-ui, sans-serif';

    const header = document.createElement('div');
    header.style.flexShrink = '0';
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.paddingBottom = '12px';
    header.style.marginBottom = '16px';
    header.style.borderBottom = '1px solid rgba(255,255,255,0.70)';

    this.titleEl = document.createElement('div');
    this.titleEl.style.fontSize = '15px';
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

    this.previewContainer = document.createElement('div');
    this.previewContainer.style.fontSize = '15px';
    this.previewContainer.style.lineHeight = '1.45';
    this.previewContainer.style.color = 'rgba(255,255,255,0.6)';
    this.previewContainer.style.fontStyle = 'italic';
    this.previewContainer.style.marginBottom = '16px';
    this.previewContainer.style.padding = '8px 12px';
    this.previewContainer.style.background = 'rgba(255,255,255,0.04)';
    this.previewContainer.style.borderRadius = '6px';
    this.previewContainer.style.borderLeft = '3px solid #8db7ff';
    this.previewContainer.style.display = 'none';
    this.previewContainer.style.flexShrink = '0';

    this.questionsContainer = document.createElement('div');
    this.questionsContainer.id = '__tbv_nudge_overlay_questions';
    this.questionsContainer.style.display = 'flex';
    this.questionsContainer.style.flexDirection = 'column';
    this.questionsContainer.style.gap = '20px';
    this.questionsContainer.style.overflowY = 'auto';
    this.questionsContainer.style.scrollbarColor = 'transparent transparent';
    this.questionsContainer.style.paddingRight = '20px';
    this.questionsContainer.style.flex = '1';

    this.questionsContainer.addEventListener('mouseenter', () => {
      this.questionsContainer.style.scrollbarColor = 'hsl(0deg 0% 72.59% / 38%) transparent';
    });
    this.questionsContainer.addEventListener('mouseleave', () => {
      this.questionsContainer.style.scrollbarColor = 'transparent transparent';
    });

    const footer = document.createElement('div');
    footer.style.flexShrink = '0';
    footer.style.display = 'flex';
    footer.style.alignItems = 'center';
    footer.style.justifyContent = 'space-between';
    footer.style.marginTop = '16px';
    footer.style.paddingTop = '12px';
    footer.style.borderTop = '1px solid rgba(255,255,255,0.70)';

    this.scrollIndicator = document.createElement('div');
    this.scrollIndicator.textContent = '↓ Scroll for more';
    this.scrollIndicator.style.fontSize = '14px';
    this.scrollIndicator.style.color = 'rgb(141, 171, 255)';
    this.scrollIndicator.style.opacity = '0';
    this.scrollIndicator.style.transition = 'opacity 0.2s';
    this.scrollIndicator.style.fontWeight = '700';

    this.skipButton = document.createElement('button');
    this.skipButton.type = 'button';
    this.skipButton.textContent = 'Skip All';
    this.skipButton.style.border = '1px solid rgba(255,255,255,0.22)';
    this.skipButton.style.background = 'transparent';
    this.skipButton.style.color = '#f4f7ff';
    this.skipButton.style.borderRadius = '10px';
    this.skipButton.style.padding = '10px 14px';
    this.skipButton.style.cursor = 'pointer';
    this.skipButton.style.fontSize = '14px';

    footer.appendChild(this.scrollIndicator);
    footer.appendChild(this.skipButton);

    this.card.appendChild(header);
    this.card.appendChild(this.previewContainer);
    this.card.appendChild(this.questionsContainer);
    this.card.appendChild(footer);
    this.host.appendChild(this.card);

    // ── Wire up dismiss / skip handlers ───────────────────────────────
    this.closeButton.addEventListener('click', () => {
      this.resolveRemaining('close');
    });

    this.skipButton.addEventListener('click', () => {
      this.resolveRemaining('skip');
    });

    this.questionsContainer.addEventListener('scroll', () => {
      this.updateScrollIndicator();
    });

    // Defer DOM attachment until body is ready
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

  setOnSessionComplete(handler: (fullSkip: boolean, triggerType: NudgeTriggerType) => void): void {
    this.onSessionComplete = handler;
  }

  show(payload: NudgeOverlayPayload): void {
    if (this.active) {
      this.resolveRemaining('replaced');
    }

    const timeoutMs = Math.max(1000, payload.timeoutMs ?? 60_000);
    this.applyPosition(payload.position || 'bottom-right');

    const typeLabel = payload.triggerType === 'copy' ? 'Copied text' : 'Response';
    this.titleEl.textContent = `Quick check • ${typeLabel} (${payload.questions.length} questions)`;

    if (payload.textPreview) {
      this.previewContainer.textContent = `"${payload.textPreview}"`;
      this.previewContainer.style.display = 'block';
    } else {
      this.previewContainer.style.display = 'none';
      this.previewContainer.textContent = '';
    }

    // Render questions
    this.questionsContainer.innerHTML = '';
    const unansweredQuestions = new Set<string>();

    payload.questions.forEach((q) => {
      unansweredQuestions.add(q.questionId);
      this.renderQuestion(q);
    });

    // Re-attach if somehow removed from DOM
    if (!this.host.isConnected) {
      (document.body || document.documentElement).appendChild(this.host);
    }

    this.host.style.display = 'block';

    // Check initial scroll state after rendering
    setTimeout(() => this.updateScrollIndicator(), 50);

    console.log('[TrustButVerify] Nudge overlay visible — host in DOM:', this.host.isConnected, 'display:', this.host.style.display);

    const timeoutId = window.setTimeout(() => {
      this.resolveRemaining('timeout');
    }, timeoutMs);

    this.active = {
      payload,
      shownAt: Date.now(),
      timeoutId,
      unansweredQuestions,
      explicitlyAnsweredCount: 0
    };
  }

  hide(): void {
    if (!this.active) {
      this.host.style.display = 'none';
      return;
    }
    this.resolveRemaining('close');
  }

  dispose(): void {
    if (this.active) {
      window.clearTimeout(this.active.timeoutId);
      this.active = null;
    }
    this.host.remove();
  }

  // ── Scroll Indicator Update ─────────────────────────────────────────
  private updateScrollIndicator(): void {
    const { scrollTop, scrollHeight, clientHeight } = this.questionsContainer;
    // If exact match or very close to bottom, hide. If clientHeight is 0, hide.
    if (clientHeight === 0 || scrollHeight <= clientHeight + 2) {
      this.scrollIndicator.style.opacity = '0';
    } else if (scrollTop >= scrollHeight - clientHeight - 10) {
      this.scrollIndicator.style.opacity = '0';
    } else {
      this.scrollIndicator.style.opacity = '0.8';
    }
  }

  // ── Render individual question ──────────────────────────────────────
  private renderQuestion(q: NudgeOverlayQuestionPayload): void {
    const qWrapper = document.createElement('div');
    qWrapper.id = `__tbv_q_${q.questionId}`;
    qWrapper.style.display = 'flex';
    qWrapper.style.flexDirection = 'column';

    const questionEl = document.createElement('div');
    questionEl.style.fontSize = '15px';
    questionEl.style.lineHeight = '1.55';
    questionEl.style.marginBottom = '8px';
    questionEl.textContent = q.questionText;

    const answersEl = document.createElement('div');
    answersEl.style.display = 'flex';
    answersEl.style.flexWrap = 'wrap';
    answersEl.style.gap = '8px';

    const addButton = (label: string, value: NudgeResponseValue, primary = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.border = primary ? '1px solid #8db7ff' : '1px solid rgba(255,255,255,0.18)';
      button.style.background = primary ? 'rgba(71, 126, 255, 0.25)' : 'rgba(255,255,255,0.06)';
      button.style.color = '#f4f7ff';
      button.style.borderRadius = '10px';
      button.style.padding = '8px 12px';
      button.style.cursor = 'pointer';
      button.style.fontSize = '13px';
      button.addEventListener('click', () => this.resolveSpecific(q.questionId, value));
      answersEl.appendChild(button);
    };

    if (q.answerMode === 'yes_no_skip') {
      addButton(q.yesLabel ?? 'Yes', 'yes', true);
      addButton('No', 'no');
    } else if (q.answerMode === 'yes_partly_no_skip') {
      addButton(q.yesLabel ?? 'Yes', 'yes', true);
      addButton('Partly', 'partly');
      addButton('No', 'no');
    } else {
      for (let i = 1; i <= 10; i++) {
        addButton(String(i), i as NudgeResponseValue);
      }
      if (q.ratingLabels) {
        const labelRow = document.createElement('div');
        labelRow.style.width = '100%';
        labelRow.style.display = 'flex';
        labelRow.style.justifyContent = 'space-between';
        labelRow.style.fontSize = '12px';
        labelRow.style.opacity = '0.6';
        labelRow.style.marginTop = '2px';

        const lowSpan = document.createElement('span');
        lowSpan.textContent = `1 = ${q.ratingLabels.low}`;
        const highSpan = document.createElement('span');
        highSpan.textContent = `10 = ${q.ratingLabels.high}`;

        labelRow.appendChild(lowSpan);
        labelRow.appendChild(highSpan);
        answersEl.appendChild(labelRow);
      }
    }

    qWrapper.appendChild(questionEl);
    qWrapper.appendChild(answersEl);
    this.questionsContainer.appendChild(qWrapper);
  }

  // ── Resolve specific question ───────────────────────────────────────
  private resolveSpecific(questionId: string, response: NudgeResponseValue): void {
    if (!this.active) return;

    if (!this.active.unansweredQuestions.has(questionId)) return;

    this.active.unansweredQuestions.delete(questionId);
    this.active.explicitlyAnsweredCount += 1;

    const qPayload = this.active.payload.questions.find(q => q.questionId === questionId);
    if (!qPayload) return;

    if (this.onResolve) {
      this.onResolve({
        questionId: qPayload.questionId,
        questionText: qPayload.questionText,
        response,
        responseTimeMs: Math.max(0, Date.now() - this.active.shownAt),
        triggerType: this.active.payload.triggerType,
        conversationId: this.active.payload.conversationId,
        turnId: this.active.payload.turnId,
        copyActivityId: this.active.payload.copyActivityId,
        questionTags: qPayload.questionTags,
        dismissedBy: 'answer'
      });
    }

    // Visually disable the question
    const qWrapper = this.host.querySelector(`#__tbv_q_${questionId}`) as HTMLDivElement;
    if (qWrapper) {
      qWrapper.style.opacity = '0.4';
      qWrapper.style.pointerEvents = 'none';
      const selectedText = document.createElement('div');
      selectedText.style.fontSize = '12px';
      selectedText.style.marginTop = '4px';
      selectedText.style.color = '#8db7ff';
      selectedText.textContent = `✓ Answer recorded`;
      qWrapper.appendChild(selectedText);
    }

    // Check if we are done
    if (this.active.unansweredQuestions.size === 0) {
      this.finishSession();
    }
  }

  // ── Resolve remaining questions ─────────────────────────────────────
  private resolveRemaining(dismissedBy: NudgeOverlayResolution['dismissedBy']): void {
    if (!this.active) {
      this.host.style.display = 'none';
      return;
    }

    // Capture unanswered questions
    const remaining = Array.from(this.active.unansweredQuestions);

    remaining.forEach(questionId => {
      this.active!.unansweredQuestions.delete(questionId);
      const qPayload = this.active!.payload.questions.find(q => q.questionId === questionId);

      if (qPayload && this.onResolve) {
        this.onResolve({
          questionId: qPayload.questionId,
          questionText: qPayload.questionText,
          response: 'skip',
          responseTimeMs: Math.max(0, Date.now() - this.active!.shownAt),
          triggerType: this.active!.payload.triggerType,
          conversationId: this.active!.payload.conversationId,
          turnId: this.active!.payload.turnId,
          copyActivityId: this.active!.payload.copyActivityId,
          questionTags: qPayload.questionTags,
          dismissedBy
        });
      }
    });

    this.finishSession();
  }

  // ── Finish the session and notify ───────────────────────────────────
  private finishSession(): void {
    if (!this.active) return;

    const explicitlyAnsweredCount = this.active.explicitlyAnsweredCount;
    const fullSkip = explicitlyAnsweredCount === 0;
    const triggerType = this.active.payload.triggerType;

    const timeoutId = this.active.timeoutId;
    this.active = null;
    window.clearTimeout(timeoutId);

    this.host.style.display = 'none';

    if (this.onSessionComplete) {
      this.onSessionComplete(fullSkip, triggerType);
    }
  }

  // ── Position the overlay on screen ──────────────────────────────────
  private applyPosition(position: NudgeOverlayPosition): void {
    // Always render centered for multi-question overlay
    this.host.style.left = '50%';
    this.host.style.top = '50%';
    this.host.style.transform = 'translate(-50%, -50%)';
    this.host.style.right = 'auto';
    this.host.style.bottom = 'auto';
  }
}
