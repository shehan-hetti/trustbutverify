import type { MessageResponse, VerifyParticipantResult } from '../types';

const uuidInput = document.getElementById('uuidInput') as HTMLInputElement;
const verifyBtn = document.getElementById('verifyBtn') as HTMLButtonElement;
const statusMessage = document.getElementById('statusMessage') as HTMLDivElement;

/**
 * UUID v4 basic format check.
 */
function isValidUuidFormat(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function showStatus(msg: string, type: 'success' | 'error' | 'loading'): void {
  statusMessage.textContent = msg;
  statusMessage.className = `reg-status status-${type}`;
  statusMessage.hidden = false;
}

function hideStatus(): void {
  statusMessage.hidden = true;
}

function setLoading(loading: boolean): void {
  verifyBtn.disabled = loading;
  uuidInput.disabled = loading;
  if (loading) {
    verifyBtn.textContent = 'Verifying…';
    showStatus('Contacting server…', 'loading');
  } else {
    verifyBtn.textContent = 'Verify & Activate';
  }
}

async function handleVerify(): Promise<void> {
  hideStatus();
  const uuid = uuidInput.value.trim();

  // Client-side format check
  if (!uuid) {
    uuidInput.classList.add('input-error');
    showStatus('Please enter a Participant ID.', 'error');
    return;
  }
  if (!isValidUuidFormat(uuid)) {
    uuidInput.classList.add('input-error');
    showStatus('Invalid format — expected a UUID like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', 'error');
    return;
  }

  uuidInput.classList.remove('input-error', 'input-success');
  setLoading(true);

  try {
    const response: MessageResponse = await chrome.runtime.sendMessage({
      type: 'VERIFY_PARTICIPANT',
      data: { uuid }
    });

    if (!response.success) {
      setLoading(false);
      uuidInput.classList.add('input-error');
      showStatus(response.error || 'Verification failed — please check your connection.', 'error');
      return;
    }

    const result = response.data as VerifyParticipantResult;
    if (result.valid) {
      uuidInput.classList.add('input-success');
      showStatus('✓ Verified successfully! Opening dashboard…', 'success');
      // Brief pause so user sees the success message, then close popup.
      // The service worker already switched action popup to the main popup,
      // so next click opens the dashboard.
      setTimeout(() => window.close(), 1200);
    } else {
      setLoading(false);
      uuidInput.classList.add('input-error');
      showStatus(result.error || 'This Participant ID is not recognized. Please check with the researcher.', 'error');
    }
  } catch (err: unknown) {
    setLoading(false);
    uuidInput.classList.add('input-error');
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Connection error: ${msg}`, 'error');
  }
}

// Bind events
verifyBtn.addEventListener('click', handleVerify);
uuidInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleVerify();
});
uuidInput.addEventListener('input', () => {
  uuidInput.classList.remove('input-error', 'input-success');
  hideStatus();
});
