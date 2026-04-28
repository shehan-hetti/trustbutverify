/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API base URL (no trailing slash). */
  readonly VITE_BACKEND_URL: string;
  /** LLM-2 categorization proxy endpoint. */
  readonly VITE_LLM2_URL: string;
  /** LLM-2 basic auth username. */
  readonly VITE_LLM2_USER: string;
  /** LLM-2 basic auth password. */
  readonly VITE_LLM2_PASS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
