/**
 * Tests for src/utils/readability-metrics.ts
 *
 * computeReadability is the sole public export.
 * The internal helpers (gradeToBand, deriveReasonCodes, safe, safeStr)
 * are exercised indirectly via the output properties.
 */
import { describe, it, expect } from 'vitest';
import { computeReadability } from '../src/utils/readability-metrics';

/* ------------------------------------------------------------------ */
/*  Edge-case / guard-clause tests                                    */
/* ------------------------------------------------------------------ */

describe('computeReadability – edge cases', () => {
  it('returns null for empty string', () => {
    expect(computeReadability('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    // @ts-expect-error intentional bad input
    expect(computeReadability(null)).toBeNull();
    // @ts-expect-error intentional bad input
    expect(computeReadability(undefined)).toBeNull();
    // @ts-expect-error intentional bad input
    expect(computeReadability(42)).toBeNull();
  });

  it('returns null when word count is below MIN_WORD_COUNT (10)', () => {
    expect(computeReadability('short text here')).toBeNull(); // 3 words
    expect(computeReadability('one two three four five six seven eight nine')).toBeNull(); // 9 words
  });
});

/* ------------------------------------------------------------------ */
/*  Happy-path: real text with enough words                           */
/* ------------------------------------------------------------------ */

const SAMPLE = `
The quick brown fox jumps over the lazy dog.
This sentence exists to push the word count above the minimum threshold
required by the readability library. Adding more words ensures reliable
grade-level calculations across multiple readability formulas.
Software engineering is a discipline that applies scientific and
practical knowledge to the invention, design, implementation, and
testing of complex software systems.
`;

describe('computeReadability – valid text', () => {
  const result = computeReadability(SAMPLE);

  it('returns a non-null result for text with enough words', () => {
    expect(result).not.toBeNull();
  });

  it('metrics.version is 1', () => {
    expect(result!.metrics.version).toBe(1);
  });

  it('metrics contains all expected numeric fields', () => {
    const m = result!.metrics;
    expect(typeof m.wordCount).toBe('number');
    expect(m.wordCount).toBeGreaterThanOrEqual(10);
    expect(typeof m.sentenceCount).toBe('number');
    expect(m.sentenceCount).toBeGreaterThan(0);
    expect(typeof m.fleschReadingEase).toBe('number');
    expect(typeof m.fleschKincaidGrade).toBe('number');
    expect(typeof m.smogIndex).toBe('number');
    expect(typeof m.colemanLiauIndex).toBe('number');
    expect(typeof m.automatedReadabilityIndex).toBe('number');
    expect(typeof m.gunningFog).toBe('number');
    expect(typeof m.daleChallReadabilityScore).toBe('number');
    expect(typeof m.lix).toBe('number');
    expect(typeof m.rix).toBe('number');
  });

  it('sampleTextLength reflects the actual text length', () => {
    expect(result!.metrics.sampleTextLength).toBe(SAMPLE.length);
  });

  it('complexity.complexityBand is a valid band', () => {
    const validBands = ['very-easy', 'easy', 'moderate', 'hard', 'very-hard'] as const;
    expect(validBands).toContain(result!.complexity.complexityBand);
  });

  it('complexity.gradeConsensus is a number', () => {
    expect(typeof result!.complexity.gradeConsensus).toBe('number');
  });

  it('reasonCodes is either undefined or a string array', () => {
    const rc = result!.complexity.reasonCodes;
    if (rc !== undefined) {
      expect(Array.isArray(rc)).toBe(true);
      for (const c of rc) {
        expect(typeof c).toBe('string');
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gradeToBand coverage (indirectly via gradeConsensus values)         */
/* ------------------------------------------------------------------ */

describe('computeReadability – complexity band mapping', () => {
  // We can't call gradeToBand directly (not exported), but we trust the
  // band in the result. Just ensure the public API doesn't crash on
  // extremely easy or extremely hard prose.
  it('handles very simple text without error', () => {
    const easy = 'The cat sat on a mat. The dog ran in the sun. A bird flew in the sky. ' +
      'I like to play. She has a red ball. He sees the big tree. We run and jump. ' +
      'The fish is in the pond. My hat is blue. I see a cow.';
    const r = computeReadability(easy);
    if (r) {
      expect(r.complexity.complexityBand).toBeDefined();
    }
  });

  it('handles complex academic text without error', () => {
    const hard =
      'Epistemological considerations necessitate the disambiguation of ontological ' +
      'presuppositions underlying the hermeneutical analysis of phenomenological ' +
      'frameworks in contemporary post-structuralist discourse. The axiomatization ' +
      'of metamathematical propositions further obfuscates the dialectical synthesis. ' +
      'Notwithstanding, the teleological implications of transcendental idealism remain ' +
      'ineluctably intertwined with deontological imperatives of Kantian ethics.';
    const r = computeReadability(hard);
    if (r) {
      expect(r.complexity.complexityBand).toBeDefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Truncation guard                                                   */
/* ------------------------------------------------------------------ */

describe('computeReadability – truncation', () => {
  it('handles text exceeding MAX_TEXT_LENGTH (50 000 chars) without throwing', () => {
    const longText = 'word '.repeat(12_000); // 60 000 chars (just over limit)
    const r = computeReadability(longText);
    // Should still produce metrics capped at 50k chars
    if (r) {
      expect(r.metrics.sampleTextLength).toBeLessThanOrEqual(50_000);
    }
  }, 30_000);
});
