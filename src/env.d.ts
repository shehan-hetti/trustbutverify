/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API base URL (no trailing slash). */
  readonly VITE_BACKEND_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
