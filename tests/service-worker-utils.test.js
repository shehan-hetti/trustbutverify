/**
 * Tests for pure utility functions in service-worker.ts
 *
 * Because the service worker does not export its helper functions,
 * we replicate the pure logic here and test it.
 * This ensures correctness of the algorithms used in matching,
 * categorization prompt building, and LLM response parsing.
 *
 * If these functions are ever extracted to a shared module, these tests
 * can import them directly.
 */
import { describe, it, expect } from 'vitest';
/* ------------------------------------------------------------------ */
/*  Replicas of service-worker pure functions                          */
/* ------------------------------------------------------------------ */
function normalizeText(text) {
    return (text || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function normalizeForMatch(text, mode) {
    const soft = normalizeText(text)
        .toLowerCase()
        .replace(/\bcopy code\b/gi, ' ')
        .replace(/\bcopy table\b/gi, ' ')
        .replace(/\bcopy\b/gi, ' ')
        .replace(/\bexport to sheets\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (mode === 'soft')
        return soft;
    return soft.replace(/[^\p{L}\p{N}]+/gu, '');
}
function tokenizeForOverlap(text) {
    const soft = normalizeForMatch(text, 'soft');
    if (!soft)
        return [];
    return soft
        .split(/\s+/g)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3);
}
function tokenOverlapScore(a, b) {
    const ta = tokenizeForOverlap(a);
    const tb = tokenizeForOverlap(b);
    if (ta.length === 0 || tb.length === 0)
        return 0;
    const setB = new Set(tb);
    let common = 0;
    for (const t of ta) {
        if (setB.has(t))
            common++;
    }
    const coverageA = common / ta.length;
    const coverageB = common / tb.length;
    return Math.max(coverageA, coverageB);
}
function containmentScore(a, b) {
    const aSoft = normalizeForMatch(a, 'soft');
    const bSoft = normalizeForMatch(b, 'soft');
    if (!aSoft || !bSoft)
        return 0;
    if (aSoft === bSoft)
        return 1.0;
    if (bSoft.includes(aSoft))
        return Math.min(1, aSoft.length / bSoft.length);
    if (aSoft.includes(bSoft))
        return Math.min(1, bSoft.length / aSoft.length);
    const aHard = normalizeForMatch(a, 'hard');
    const bHard = normalizeForMatch(b, 'hard');
    if (aHard && bHard) {
        if (bHard.includes(aHard))
            return Math.min(1, aHard.length / bHard.length);
        if (aHard.includes(bHard))
            return Math.min(1, bHard.length / aHard.length);
    }
    return tokenOverlapScore(a, b) * 0.9;
}
function tryParseJsonObjectFromText(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace)
        return null;
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
        return JSON.parse(candidate);
    }
    catch {
        return null;
    }
}
function extractCategoryFromContent(content) {
    const match = content.match(/\bcategory\s*:\s*(.+)$/im);
    if (!match)
        return null;
    const value = match[1].trim();
    return value.length ? value : null;
}
function extractSummaryFromContent(content) {
    const match = content.match(/\bsummary\s*:\s*(.+)$/im);
    if (!match)
        return null;
    const value = match[1].trim();
    return value.length ? value : null;
}
function extractCategoryAndSummary(content) {
    const json = tryParseJsonObjectFromText(content);
    if (json && typeof json === 'object') {
        const record = json;
        let category = null;
        const rawCategory = record.category;
        if (typeof rawCategory === 'string') {
            category = rawCategory.trim();
        }
        else if (Array.isArray(rawCategory) && rawCategory.every((v) => typeof v === 'string')) {
            category = rawCategory.map((s) => s.trim()).filter(Boolean).join('|');
        }
        const rawSummary = record.summary;
        const summary = typeof rawSummary === 'string' ? rawSummary.trim() : null;
        if (category && summary)
            return { category, summary };
    }
    const category = extractCategoryFromContent(content);
    const summary = extractSummaryFromContent(content);
    if (!category || !summary)
        return null;
    return { category, summary };
}
function extractCategoryOnly(content) {
    const json = tryParseJsonObjectFromText(content);
    if (json && typeof json === 'object') {
        const record = json;
        const raw = record.category;
        if (typeof raw === 'string') {
            const c = raw.trim();
            return c.length ? c : null;
        }
        if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) {
            const c = raw.map((s) => s.trim()).filter(Boolean).join('|');
            return c.length ? c : null;
        }
    }
    return extractCategoryFromContent(content);
}
function parseLlmCompletionPayload(text) {
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed.content === 'string')
            return parsed.content;
    }
    catch { /* ignore */ }
    return text;
}
function derivePlatformFromDomain(domain) {
    if (domain.includes('chatgpt') || domain.includes('openai'))
        return 'ChatGPT';
    if (domain.includes('deepseek'))
        return 'DeepSeek';
    if (domain.includes('claude'))
        return 'Claude';
    if (domain.includes('gemini'))
        return 'Gemini';
    if (domain.includes('grok') || domain === 'x.ai')
        return 'Grok';
    return 'Unknown';
}
function deriveThreadIdFromUrl(url, domain) {
    try {
        const u = new URL(url);
        const path = u.pathname;
        const chatgpt = path.match(/\/c\/([^/?#]+)/);
        if (chatgpt)
            return `${domain}::${chatgpt[1]}`;
        const gemApp = path.match(/\/app\/([^/?#]+)/);
        if (gemApp)
            return `${domain}::${gemApp[1]}`;
        const key = `${u.origin}${u.pathname}`;
        let hash = 0;
        for (let i = 0; i < key.length; i++) {
            hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
        }
        return `${domain}::h${hash.toString(36)}`;
    }
    catch {
        return `${domain}::unknown`;
    }
}
/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */
describe('normalizeText', () => {
    it('collapses whitespace and trims', () => {
        expect(normalizeText('  hello   world  ')).toBe('hello world');
    });
    it('strips zero-width characters', () => {
        expect(normalizeText('he\u200Bllo')).toBe('hello');
        expect(normalizeText('\uFEFFont')).toBe('ont');
    });
    it('handles empty / null-ish input', () => {
        expect(normalizeText('')).toBe('');
        // @ts-expect-error intentional
        expect(normalizeText(null)).toBe('');
    });
});
describe('normalizeForMatch', () => {
    it('soft mode lowercases and strips UI artifacts', () => {
        expect(normalizeForMatch('Copy Code snippet', 'soft')).toBe('snippet');
    });
    it('hard mode removes all non-alphanumeric chars', () => {
        expect(normalizeForMatch('Hello, World!', 'hard')).toBe('helloworld');
    });
    it('handles "Export to Sheets" artifact', () => {
        expect(normalizeForMatch('data Export to Sheets more', 'soft')).toBe('data more');
    });
});
describe('tokenizeForOverlap', () => {
    it('splits into tokens of length >= 3', () => {
        const tokens = tokenizeForOverlap('the big brown fox');
        expect(tokens).toContain('the');
        expect(tokens).toContain('big');
        expect(tokens).toContain('brown');
        expect(tokens).toContain('fox');
    });
    it('filters out short tokens after normalization', () => {
        const tokens = tokenizeForOverlap('a I do it');
        // "a" and "I" are too short (< 3)
        expect(tokens).not.toContain('a');
    });
    it('returns empty for empty input', () => {
        expect(tokenizeForOverlap('')).toEqual([]);
    });
});
describe('tokenOverlapScore', () => {
    it('returns 1 for identical texts', () => {
        expect(tokenOverlapScore('hello world foo', 'hello world foo')).toBeCloseTo(1);
    });
    it('returns 0 for completely disjoint texts', () => {
        expect(tokenOverlapScore('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
    });
    it('returns partial score for partially overlapping texts', () => {
        const score = tokenOverlapScore('alpha beta gamma delta', 'beta delta epsilon zeta');
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
    });
    it('returns 0 when either input is empty', () => {
        expect(tokenOverlapScore('', 'something')).toBe(0);
        expect(tokenOverlapScore('something', '')).toBe(0);
    });
});
describe('containmentScore', () => {
    it('returns 1.0 for exact match', () => {
        expect(containmentScore('Hello World', 'Hello World')).toBe(1.0);
    });
    it('returns containment ratio when a is substring of b', () => {
        const score = containmentScore('Hello', 'Hello World today');
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThanOrEqual(1);
    });
    it('returns 0 for empty strings', () => {
        expect(containmentScore('', 'abc')).toBe(0);
        expect(containmentScore('abc', '')).toBe(0);
    });
    it('handles punctuation differences via hard mode', () => {
        const score = containmentScore('hello.world', 'hello world');
        expect(score).toBeGreaterThan(0);
    });
});
describe('tryParseJsonObjectFromText', () => {
    it('parses clean JSON', () => {
        const result = tryParseJsonObjectFromText('{"category":"Code"}');
        expect(result).toEqual({ category: 'Code' });
    });
    it('extracts JSON from surrounding text', () => {
        const result = tryParseJsonObjectFromText('Sure! Here is the JSON: {"category":"Research"} Hope that helps.');
        expect(result).toEqual({ category: 'Research' });
    });
    it('returns null for non-JSON', () => {
        expect(tryParseJsonObjectFromText('no json here')).toBeNull();
    });
    it('returns null for empty string', () => {
        expect(tryParseJsonObjectFromText('')).toBeNull();
    });
});
describe('extractCategoryAndSummary', () => {
    it('extracts from valid JSON', () => {
        const result = extractCategoryAndSummary('{"category":"Debugging|Python","summary":"User wants to fix a bug in their code."}');
        expect(result).toEqual({
            category: 'Debugging|Python',
            summary: 'User wants to fix a bug in their code.',
        });
    });
    it('handles category as array', () => {
        const result = extractCategoryAndSummary('{"category":["Debugging","Python"],"summary":"Bug fix."}');
        expect(result).toEqual({ category: 'Debugging|Python', summary: 'Bug fix.' });
    });
    it('falls back to line-based parsing', () => {
        const result = extractCategoryAndSummary('category: Debugging|Python\nsummary: User wants to fix a bug.');
        expect(result).toEqual({
            category: 'Debugging|Python',
            summary: 'User wants to fix a bug.',
        });
    });
    it('returns null when category is missing', () => {
        expect(extractCategoryAndSummary('{"summary":"Just a summary"}')).toBeNull();
    });
    it('returns null when summary is missing', () => {
        expect(extractCategoryAndSummary('{"category":"Code"}')).toBeNull();
    });
});
describe('extractCategoryOnly', () => {
    it('extracts category from JSON', () => {
        expect(extractCategoryOnly('{"category":"Request|Logging"}')).toBe('Request|Logging');
    });
    it('handles category as array', () => {
        expect(extractCategoryOnly('{"category":["Request","Logging"]}')).toBe('Request|Logging');
    });
    it('falls back to line-based parsing', () => {
        expect(extractCategoryOnly('category: Code|Python')).toBe('Code|Python');
    });
    it('returns null for empty category', () => {
        expect(extractCategoryOnly('{"category":""}')).toBeNull();
    });
});
describe('parseLlmCompletionPayload', () => {
    it('extracts content from JSON wrapper', () => {
        const input = JSON.stringify({ content: '{"category":"Code"}' });
        expect(parseLlmCompletionPayload(input)).toBe('{"category":"Code"}');
    });
    it('returns raw text when not JSON', () => {
        expect(parseLlmCompletionPayload('plain text')).toBe('plain text');
    });
    it('returns raw text when content is not a string', () => {
        const input = JSON.stringify({ content: 42 });
        expect(parseLlmCompletionPayload(input)).toBe(input);
    });
});
describe('derivePlatformFromDomain', () => {
    it('maps ChatGPT domains', () => {
        expect(derivePlatformFromDomain('chatgpt.com')).toBe('ChatGPT');
        expect(derivePlatformFromDomain('chat.openai.com')).toBe('ChatGPT');
    });
    it('maps DeepSeek', () => {
        expect(derivePlatformFromDomain('chat.deepseek.com')).toBe('DeepSeek');
    });
    it('maps Claude', () => {
        expect(derivePlatformFromDomain('claude.ai')).toBe('Claude');
    });
    it('maps Gemini', () => {
        expect(derivePlatformFromDomain('gemini.google.com')).toBe('Gemini');
    });
    it('maps Grok', () => {
        expect(derivePlatformFromDomain('grok.com')).toBe('Grok');
        expect(derivePlatformFromDomain('x.ai')).toBe('Grok');
    });
    it('returns Unknown for unrecognized domain', () => {
        expect(derivePlatformFromDomain('example.com')).toBe('Unknown');
    });
});
describe('deriveThreadIdFromUrl', () => {
    it('extracts ChatGPT thread id', () => {
        expect(deriveThreadIdFromUrl('https://chatgpt.com/c/abc123', 'chatgpt.com'))
            .toBe('chatgpt.com::abc123');
    });
    it('extracts Gemini app id', () => {
        expect(deriveThreadIdFromUrl('https://gemini.google.com/app/xyz789', 'gemini.google.com'))
            .toBe('gemini.google.com::xyz789');
    });
    it('falls back to hash for unknown URL pattern', () => {
        const id = deriveThreadIdFromUrl('https://claude.ai/chat', 'claude.ai');
        expect(id).toMatch(/^claude\.ai::h[a-z0-9]+$/);
    });
    it('returns domain::unknown for invalid URL', () => {
        expect(deriveThreadIdFromUrl('not-a-url', 'test.com')).toBe('test.com::unknown');
    });
});
