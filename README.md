# TrustButVerify Browser Extension

TrustButVerify is a Manifest V3 browser extension that monitors copy behavior on
LLM chat interfaces, links copies to detected conversation turns, computes text
readability/complexity metrics, collects nudge responses, and syncs research
data to the TrustButVerify backend API.

## What It Does

- Tracks user copy actions on supported LLM chat websites.
- Detects prompt/response conversation turns and links copies to turns.
- Computes readability metrics for response text and response-side copies.
- Shows nudges (copy-triggered) and stores responses.
- Stores local state in `chrome.storage.local`.
- Verifies participant UUIDs with backend and auto-syncs data every 5 minutes.

## Supported Websites

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`
- `https://grok.com/*`
- `https://x.ai/*`
- `https://deepseek.com/*`
- `https://chat.deepseek.com/*`
- `https://www.deepseek.com/*`

## Prerequisites

- Node.js 18+
- npm
- Chrome or Edge (developer mode for unpacked extension loading)
- A running TrustButVerify backend instance (local or remote)
- A valid participant UUID issued by the researcher (required to activate the extension)

Backend reference: `https://github.com/shehan-hetti/trustbutverify-backend`

## Quick Start

1. Clone and install:

```bash
git clone https://github.com/shehan-hetti/trustbutverify.git
cd trustbutverify
npm install
```

2. Create local environment file:

```bash
cp .env.example .env
```

3. Set backend URL in `.env`:

```dotenv
VITE_BACKEND_URL=http://localhost
```

Use `http://localhost` when backend runs locally, or VM/public IP for remote deployment, for example:

```dotenv
VITE_BACKEND_URL=http://120.50.20.125
```

4. Build extension:

```bash
npm run build
```

5. Load unpacked extension:

- Open `chrome://extensions/` (or `edge://extensions/`)
- Enable Developer mode
- Click Load unpacked
- Select the `dist` directory

## Backend Connectivity Notes

- `.env` is intentionally gitignored and is not committed.
- `.env.example` is committed as a template for new developers.
- `VITE_BACKEND_URL` is baked at build time; if URL changes, rebuild with `npm run build` and reload extension.
- `public/manifest.json` host permissions must include the backend origin used by `VITE_BACKEND_URL`.

## Tech Stack

- `TypeScript`: main implementation language
- `Manifest V3`: browser extension platform model
- `Vite`: build tooling and bundling
- `Chrome Storage API`: local extension persistence
- `Vitest`: automated test runner
- `text-readability-ts`: readability and complexity metrics
- Vanilla TypeScript UI: popup and registration flows without a frontend framework

## Architecture

### Content Script

Runs on supported LLM chat pages and captures:

- copied text content
- timestamp, URL, and domain
- selection/container context
- nudge display/response events in-page

### Background Service Worker

Coordinates extension logic and persistence. It:

- computes readability metrics for response text and response-side copies
- stores conversations, copies, nudges, participant UUID, and sync state in `chrome.storage.local`
- verifies participant UUIDs with backend
- syncs data to backend automatically every 5 minutes
- categorizes turns and unmatched copies via the LLM-2 service

### Popup and Registration UI

The extension has two popup states:

- `registration/registration.html`: shown before UUID verification
- `popup/popup.html`: main dashboard after activation

The dashboard shows:

- conversation and copy views
- analytics summary
- nudge statistics
- sync status, participant ID, and last sync time
- export actions and clear-data actions

## Registration and Sync Flow

- On first run, popup opens `registration/registration.html`.
- User must enter a valid participant UUID before the main dashboard is unlocked.
- Extension calls backend `GET /api/participants/verify/{uuid}`.
- On success, UUID is stored locally and popup switches to dashboard.
- Auto-sync runs periodically via `chrome.alarms` (every 5 minutes).
- Sync payload is sent to backend `POST /api/sync` with `X-Participant-UUID` header.

## Data Model Summary

- `ConversationLog`: conversation-level metadata and turn list.
- `ConversationTurn`: prompt/response text, timestamps, optional category/summary, readability and complexity.
- `CopyActivity`: copy event details, linked turn metadata, optional readability/complexity for response-side copies.
- `NudgeEvent`: trigger type, shown question, response value, response time, dismissal reason.

## Readability and Complexity

Readability is computed with `text-readability-ts` and stored for:

- Assistant response text (`ConversationTurn.response.readability`)
- Response-side copied text (`CopyActivity.readability`)

### Raw Metrics

| Metric | What it measures | Range / units |
|--------|------------------|---------------|
| `fleschReadingEase` | Overall readability, higher is easier | 0-100+ |
| `fleschKincaidGrade` | US school grade level | grade number |
| `smogIndex` | Grade level based on polysyllabic words | grade number |
| `colemanLiauIndex` | Grade level from character and sentence counts | grade number |
| `automatedReadabilityIndex` | Grade level from character density | grade number |
| `gunningFog` | Complexity from sentence length and hard words | grade number |
| `daleChallReadabilityScore` | Familiar-word readability score | raw score |
| `lix` | Läsbarhetsindex readability score | index value |
| `rix` | Anderson Rix readability score | index value |
| `textStandard` | Consensus grade string | string |
| `textMedian` | Median grade across formulas | grade number |

Derived complexity bands are:

- `very-easy` (<= 4)
- `easy` (5 to 7)
- `moderate` (8 to 10)
- `hard` (11 to 13)
- `very-hard` (>= 14)

Guardrails:

- Skip scoring text under 20 words.
- Truncate very long text before scoring.
- Fail-safe defaults prevent crashes from metric library errors.

Optional `reasonCodes` explain why text landed in a given complexity band, for example `low-flesch-ease` or `high-fog`.

## Scripts

- `npm run dev`: build in watch mode
- `npm run build`: type check + production build + postbuild path fixups
- `npm run type-check`: TypeScript checks only
- `npm test`: run Vitest suite once
- `npm run test:watch`: run Vitest in watch mode

## Testing

```bash
npm test
```

Current tests cover storage behavior, nudge selection logic, readability calculations, and service-worker utility flows.

## Project Structure

```text
trustbutverify/
├── src/
│   ├── background/         # Service worker and sync/categorization logic
│   ├── content/            # Copy tracking + nudge overlay integration
│   ├── nudges/             # Nudge question bank and selector logic
│   ├── popup/              # Main dashboard UI
│   ├── registration/       # Participant UUID verification UI
│   ├── types/              # Shared type definitions
│   └── utils/              # Storage, detection, readability, backend client
├── public/
│   ├── manifest.json
│   └── icons/
├── tests/
├── scripts/
├── .env.example
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## Troubleshooting

- Registration fails: check backend health at `<backend>/api/health`, verify `.env` URL, rebuild, and confirm UUID exists in backend.
- Sync status stuck in `error`: check backend logs and extension service-worker logs, and verify backend host exists in `manifest.json` `host_permissions`.
- No copy events: confirm site URL matches `content_scripts` patterns, then reload extension and refresh the target tab.

## Licence

This project is licensed under the [GPL-3.0 License](https://www.gnu.org/licenses/gpl-3.0.en.html).

