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
  /** True when the user changed their initial answer before finishing the session. */
  edited?: boolean;
}

interface ActiveNudgeState {
  payload: NudgeOverlayPayload;
  shownAt: number;
  timeoutId: number;
  unansweredQuestions: Set<string>;
  explicitlyAnsweredCount: number;
  /** Resolutions collected during this session (both interactive and bulk). */
  collectedResolutions: NudgeOverlayResolution[];
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
  private onBatchResolve?: (results: NudgeOverlayResolution[]) => void;
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
    this.previewContainer.style.borderLeft = '3px solid rgb(95 154 255)';
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
    this.skipButton.style.transition = 'all 0.2s ease';

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
      // If all questions are answered, this button says "Done" — just close.
      if (this.active && this.active.unansweredQuestions.size === 0) {
        this.finishSession();
      } else {
        this.resolveRemaining('skip');
      }
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

  setOnBatchResolve(handler: (results: NudgeOverlayResolution[]) => void): void {
    this.onBatchResolve = handler;
  }

  setOnSessionComplete(handler: (fullSkip: boolean, triggerType: NudgeTriggerType) => void): void {
    this.onSessionComplete = handler;
  }

  show(payload: NudgeOverlayPayload): void {
    if (this.active) {
      this.resolveRemaining('replaced');
    }

    const timeoutMs = Math.max(1000, payload.timeoutMs ?? 120_000);
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
    this.resetSkipButton();
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
      explicitlyAnsweredCount: 0,
      collectedResolutions: []
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

  // ── Update the footer button text/style based on answered count ─────
  private updateSkipButtonState(): void {
    if (!this.active) return;

    const answered = this.active.explicitlyAnsweredCount;
    const remaining = this.active.unansweredQuestions.size;

    if (remaining === 0) {
      // All answered — show "Done" with highlighted style, hide close button,
      // and clear the auto-close timeout so the popup stays open until the
      // user explicitly clicks "Done".
      this.skipButton.textContent = 'Done';
      this.skipButton.style.border = '1px solid rgb(74 140 255)';
      this.skipButton.style.background = 'rgb(17 62 167)';
      this.skipButton.style.fontWeight = '600';
      this.closeButton.style.display = 'none';
      window.clearTimeout(this.active.timeoutId);
    } else if (answered > 0) {
      // Some answered — show "Skip Rest", ensure close button visible
      this.skipButton.textContent = 'Skip Rest';
      this.skipButton.style.border = '1px solid rgba(255,255,255,0.22)';
      this.skipButton.style.background = 'transparent';
      this.skipButton.style.fontWeight = '';
      this.closeButton.style.display = '';
    } else {
      // No answers yet — keep "Skip All", ensure close button visible
      this.closeButton.style.display = '';
    }
  }

  // ── Reset skip button to initial state ──────────────────────────────
  private resetSkipButton(): void {
    this.skipButton.textContent = 'Skip All';
    this.skipButton.style.border = '1px solid rgba(255,255,255,0.22)';
    this.skipButton.style.background = 'transparent';
    this.skipButton.style.fontWeight = '';
    this.closeButton.style.display = '';
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

    const addButton = (label: string, value: NudgeResponseValue) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('data-tbv-answer-value', String(value));
      button.style.border = '1px solid rgba(255,255,255,0.18)';
      button.style.background = 'rgba(255,255,255,0.06)';
      button.style.color = '#f4f7ff';
      button.style.borderRadius = '10px';
      button.style.padding = '8px 12px';
      button.style.cursor = 'pointer';
      button.style.fontSize = '13px';
      button.style.transition = 'all 0.15s ease';
      button.addEventListener('click', () => this.resolveSpecific(q.questionId, value));
      answersEl.appendChild(button);
    };

    if (q.answerMode === 'yes_no_skip') {
      addButton(q.yesLabel ?? 'Yes', 'yes');
      addButton('No', 'no');
    } else if (q.answerMode === 'yes_partly_no_skip') {
      addButton(q.yesLabel ?? 'Yes', 'yes');
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

    const qPayload = this.active.payload.questions.find(q => q.questionId === questionId);
    if (!qPayload) return;

    // Determine if this is a first answer or an edit of a previous answer
    const isFirstAnswer = this.active.unansweredQuestions.has(questionId);
    const existingIdx = this.active.collectedResolutions.findIndex(
      r => r.questionId === questionId && r.dismissedBy === 'answer'
    );
    const isEdit = !isFirstAnswer && existingIdx !== -1;

    // If it's an edit and the same value was clicked again, ignore
    if (isEdit && this.active.collectedResolutions[existingIdx].response === response) {
      return;
    }

    if (isFirstAnswer) {
      this.active.unansweredQuestions.delete(questionId);
      this.active.explicitlyAnsweredCount += 1;
    }

    const resolution: NudgeOverlayResolution = {
      questionId: qPayload.questionId,
      questionText: qPayload.questionText,
      response,
      responseTimeMs: Math.max(0, Date.now() - this.active.shownAt),
      triggerType: this.active.payload.triggerType,
      conversationId: this.active.payload.conversationId,
      turnId: this.active.payload.turnId,
      copyActivityId: this.active.payload.copyActivityId,
      questionTags: qPayload.questionTags,
      dismissedBy: 'answer',
      edited: isEdit ? true : undefined
    };

    if (this.onResolve) {
      this.onResolve(resolution);
    }

    // Update or push into collected resolutions
    if (isEdit && existingIdx !== -1) {
      // Replace the previous resolution with the updated one
      this.active.collectedResolutions[existingIdx] = resolution;
    } else {
      this.active.collectedResolutions.push(resolution);
    }

    // Visually update buttons: highlight selected, dim (but keep clickable) the rest
    const qWrapper = this.host.querySelector(`#__tbv_q_${questionId}`) as HTMLDivElement;
    if (qWrapper) {
      const allButtons = qWrapper.querySelectorAll('button[data-tbv-answer-value]');
      allButtons.forEach((btn) => {
        const b = btn as HTMLButtonElement;
        if (b.getAttribute('data-tbv-answer-value') === String(response)) {
          // Highlight the selected answer
          b.style.border = '1px solid rgb(74 140 255)';
          b.style.background = 'rgb(19 77 211 / 40%)';
          b.style.fontWeight = '600';
          b.style.opacity = '1';
        } else {
          // Dim unselected but keep clickable for potential edits
          b.style.border = '1px solid rgba(255,255,255,0.18)';
          b.style.background = 'rgba(255,255,255,0.06)';
          b.style.fontWeight = '';
          b.style.opacity = '0.45';
        }
        // Keep buttons clickable so user can change their answer
        b.style.pointerEvents = 'auto';
        b.style.cursor = 'pointer';
      });

      // Add or update confirmation text
      const confirmId = `__tbv_confirm_${questionId}`;
      let confirmEl = qWrapper.querySelector(`#${confirmId}`) as HTMLDivElement | null;
      if (!confirmEl) {
        confirmEl = document.createElement('div');
        confirmEl.id = confirmId;
        confirmEl.style.fontSize = '12px';
        confirmEl.style.marginTop = '4px';
        confirmEl.style.color = '#8db7ff';
        qWrapper.appendChild(confirmEl);
      }
      confirmEl.textContent = isEdit ? '✓ Answer edited' : '✓ Answer recorded';
    }

    // Update the footer button text based on progress
    this.updateSkipButtonState();
  }

  // ── Resolve remaining questions ─────────────────────────────────────
  private resolveRemaining(dismissedBy: NudgeOverlayResolution['dismissedBy']): void {
    if (!this.active) {
      this.host.style.display = 'none';
      return;
    }

    // Capture unanswered questions and build resolutions.
    // Do NOT call onResolve here — collect into the batch instead.
    const remaining = Array.from(this.active.unansweredQuestions);

    remaining.forEach(questionId => {
      this.active!.unansweredQuestions.delete(questionId);
      const qPayload = this.active!.payload.questions.find(q => q.questionId === questionId);

      if (qPayload) {
        this.active!.collectedResolutions.push({
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
    const allResolutions = this.active.collectedResolutions;

    const timeoutId = this.active.timeoutId;
    this.active = null;
    window.clearTimeout(timeoutId);

    this.host.style.display = 'none';

    // Emit all resolutions as a single batch for atomic storage.
    // This is the PRIMARY save path — prevents the read-modify-write
    // race that occurred when individual onResolve calls fired concurrently.
    if (this.onBatchResolve && allResolutions.length > 0) {
      this.onBatchResolve(allResolutions);
    }

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
