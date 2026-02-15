/**
 * readability-metrics.ts
 *
 * Thin wrapper around `text-readability-ts` that produces
 * TextReadabilityMetrics + TextComplexitySummary objects
 * ready for storage on ConversationTurn.response or CopyActivity.
 */

import _readabilityModule from 'text-readability-ts';
import type {
  TextReadabilityMetrics,
  TextComplexitySummary,
  ComplexityBand,
} from '../types';

/* ------------------------------------------------------------------ */
/*  Tunables                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve the readability singleton.
 * The CJS module.exports may land on .default, .__require(), or directly
 * depending on how the bundler wraps it.  We try all paths.
 */
function getReadability(): any {
  const mod = _readabilityModule as any;
  // Direct: already the singleton (has .lexiconCount)
  if (typeof mod?.lexiconCount === 'function') return mod;
  // .default: esModuleInterop default export
  if (typeof mod?.default?.lexiconCount === 'function') return mod.default;
  // __require: rollup commonjs lazy wrapper
  if (typeof mod?.__require === 'function') {
    const resolved = mod.__require();
    if (typeof resolved?.lexiconCount === 'function') return resolved;
    if (typeof resolved?.default?.lexiconCount === 'function') return resolved.default;
  }
  // Fallback: return whatever we have and let it throw descriptive errors.
  return mod?.default || mod;
}

let _readability: any = null;
function readability(): any {
  if (!_readability) _readability = getReadability();
  return _readability;
}

/** Don't bother computing metrics for texts shorter than this. */
const MIN_WORD_COUNT = 20;

/**
 * Hard cap on the text length fed to the library.
 * Long responses (e.g. full code files) can be expensive; we take
 * the first MAX_TEXT_LENGTH characters as a representative sample.
 */
const MAX_TEXT_LENGTH = 50_000;

/* ------------------------------------------------------------------ */
/*  Complexity-band mapping                                           */
/* ------------------------------------------------------------------ */

/**
 * Map a consensus grade number to a human-friendly complexity band.
 *
 * | Band       | Grade range |
 * |------------|-------------|
 * | very-easy  | ≤ 4         |
 * | easy       | 5 – 7       |
 * | moderate   | 8 – 10      |
 * | hard       | 11 – 13     |
 * | very-hard  | ≥ 14        |
 */
function gradeToBand(grade: number): ComplexityBand {
  if (grade <= 4) return 'very-easy';
  if (grade <= 7) return 'easy';
  if (grade <= 10) return 'moderate';
  if (grade <= 13) return 'hard';
  return 'very-hard';
}

/**
 * Produce optional reason codes that hint *why* a text landed in its
 * band (useful for debugging / UI tooltips).
 */
function deriveReasonCodes(metrics: TextReadabilityMetrics): string[] {
  const codes: string[] = [];
  if (metrics.fleschReadingEase < 30) codes.push('low-flesch-ease');
  if (metrics.fleschReadingEase > 80) codes.push('high-flesch-ease');
  if (metrics.gunningFog >= 14) codes.push('high-fog');
  if (metrics.smogIndex >= 14) codes.push('high-smog');
  if (metrics.daleChallReadabilityScore >= 9) codes.push('high-dale-chall');
  if (metrics.lix >= 55) codes.push('high-lix');
  return codes;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export interface ReadabilityResult {
  metrics: TextReadabilityMetrics;
  complexity: TextComplexitySummary;
}

/**
 * Compute readability metrics for a block of text.
 *
 * Returns `null` when the text is too short to produce meaningful
 * scores (fewer than MIN_WORD_COUNT words).
 */
export function computeReadability(rawText: string): ReadabilityResult | null {
  if (!rawText || typeof rawText !== 'string') return null;

  // Truncate if necessary – keep only the leading portion.
  const text =
    rawText.length > MAX_TEXT_LENGTH
      ? rawText.slice(0, MAX_TEXT_LENGTH)
      : rawText;

  const wordCount = readability().lexiconCount(text, true);
  if (wordCount < MIN_WORD_COUNT) return null;

  const sentenceCount = readability().sentenceCount(text);
  if (sentenceCount === 0) return null; // avoid divide-by-zero inside lib

  /* --- raw scores ------------------------------------------------- */
  const metrics: TextReadabilityMetrics = {
    version: 1,
    sampleTextLength: text.length,
    sentenceCount,
    wordCount,

    fleschReadingEase: safe(() => readability().fleschReadingEase(text)),
    fleschKincaidGrade: safe(() => readability().fleschKincaidGrade(text)),
    smogIndex: safe(() => readability().smogIndex(text)),
    colemanLiauIndex: safe(() => readability().colemanLiauIndex(text)),
    automatedReadabilityIndex: safe(() => readability().automatedReadabilityIndex(text)),
    gunningFog: safe(() => readability().gunningFog(text)),
    daleChallReadabilityScore: safe(() => readability().daleChallReadabilityScore(text)),
    lix: safe(() => readability().lix(text)),
    rix: safe(() => readability().rix(text)),

    textStandard: safeStr(() => readability().textStandard(text) as string),
    textMedian: safe(() => readability().textMedian(text)),
  };

  /* --- derived complexity ----------------------------------------- */
  const gradeConsensus = metrics.textMedian ?? metrics.fleschKincaidGrade;
  const complexityBand = gradeToBand(gradeConsensus);
  const reasonCodes = deriveReasonCodes(metrics);

  const complexity: TextComplexitySummary = {
    gradeConsensus,
    complexityBand,
    ...(reasonCodes.length > 0 ? { reasonCodes } : {}),
  };

  return { metrics, complexity };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Run a numeric metric safely; return 0 on error. */
function safe(fn: () => number): number {
  try {
    const v = fn();
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Run a string metric safely; return undefined on error. */
function safeStr(fn: () => string): string | undefined {
  try {
    const v = fn();
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}
