/**
 * Backend API client for TrustButVerify.
 *
 * Base URL is baked in at build time via Vite (VITE_BACKEND_URL).
 * All endpoints sit under /api/ on that host.
 */

const BASE_URL: string = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost').replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/*  Types matching the backend Pydantic schemas                        */
/* ------------------------------------------------------------------ */

export interface BackendSyncResponse {
  success: boolean;
  newConversations: number;
  updatedConversations: number;
  newTurns: number;
  newCopyActivities: number;
  newNudgeEvents: number;
}

export interface BackendVerifyResponse {
  valid: boolean;
  registered_at?: string;
}

export interface BackendHealthResponse {
  status: string;
  database: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function apiUrl(path: string): string {
  return `${BASE_URL}/api${path}`;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/*  Public API functions                                               */
/* ------------------------------------------------------------------ */

/**
 * Verify a participant UUID against the backend.
 * Returns { valid: true } if the UUID is registered.
 */
export async function verifyParticipant(uuid: string): Promise<BackendVerifyResponse> {
  return jsonFetch<BackendVerifyResponse>(apiUrl(`/participants/verify/${encodeURIComponent(uuid)}`));
}

/**
 * Push local data (conversations + nudge events) to the backend.
 * The participant UUID is sent in the X-Participant-UUID header.
 */
export async function syncData(
  uuid: string,
  payload: { conversations: unknown[]; nudgeEvents: unknown[] }
): Promise<BackendSyncResponse> {
  return jsonFetch<BackendSyncResponse>(apiUrl('/sync'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Participant-UUID': uuid
    },
    body: JSON.stringify(payload)
  });
}

