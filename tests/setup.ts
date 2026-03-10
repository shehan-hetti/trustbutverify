/**
 * Vitest setup — provides a minimal chrome.* API mock so modules that
 * reference chrome.storage / chrome.runtime can be imported.
 */
import { vi } from 'vitest';

// In-memory key-value store backing chrome.storage.local
const store: Record<string, unknown> = {};

const chromeStorageLocal = {
  get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
    if (!keys) return { ...store };
    if (typeof keys === 'string') {
      return { [keys]: store[keys] };
    }
    if (Array.isArray(keys)) {
      const result: Record<string, unknown> = {};
      for (const k of keys) result[k] = store[k];
      return result;
    }
    // keys is a default-values object
    const result: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(keys)) {
      result[k] = store[k] !== undefined ? store[k] : def;
    }
    return result;
  }),
  set: vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  }),
  remove: vi.fn(async (keys: string | string[]) => {
    const arr = typeof keys === 'string' ? [keys] : keys;
    for (const k of arr) delete store[k];
  }),
  clear: vi.fn(async () => {
    for (const k of Object.keys(store)) delete store[k];
  }),
};

const chromeRuntime = {
  sendMessage: vi.fn(),
  onMessage: { addListener: vi.fn() },
  onInstalled: { addListener: vi.fn() },
  getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
};

const chromeAction = {
  setPopup: vi.fn(),
};

const chromeAlarms = {
  create: vi.fn(),
  onAlarm: { addListener: vi.fn() },
};

// Expose on globalThis so bare `chrome.*` references resolve
(globalThis as any).chrome = {
  storage: {
    local: chromeStorageLocal,
  },
  runtime: chromeRuntime,
  action: chromeAction,
  alarms: chromeAlarms,
};

// Re-export for tests that need to spy or reset
export { store, chromeStorageLocal, chromeRuntime };

// Clear the in-memory store between tests
import { beforeEach } from 'vitest';
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  vi.clearAllMocks();
});
