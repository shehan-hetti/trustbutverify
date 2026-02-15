# TrustButVerify

A lightweight browser extension that tracks copy activities on LLM/Gen AI websites like ChatGPT, DeepSeek, Grok, Claude and Gemini.

## Features

- 📋 **Copy Tracking**: Automatically tracks when you copy text from AI chatbot responses
- 🔒 **Privacy-First**: All data stored locally on your device
- 🎯 **Targeted Monitoring**: Works only on specified LLM/Gen AI websites
- 📊 **Activity Dashboard**: View your copy history with timestamps and context
- 🧹 **Data Control**: Clear all tracked activities anytime

## Supported Websites

- ChatGPT (chatgpt.com)
- DeepSeek (deepseek.com)
- Grok (grok.com)
- Claude (claude.ai)
- Google Gemini (gemini.google.com)

## Development

### Prerequisites

- Node.js 18+ and npm
- Chrome

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd trustbutverify
```

2. Install dependencies:
```bash
npm install
```

3. Build the extension:
```bash
npm run build
```

### Development Mode

Run in watch mode for development:
```bash
npm run dev
```

### Loading in Browser

#### Chrome/Edge:
1. Open `chrome://extensions/` (or `edge://extensions/`)
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist` folder

## Project Structure

```
trustbutverify/
├── src/
│   ├── background/         # Background service worker
│   │   └── service-worker.ts
│   ├── content/            # Content scripts
│   │   ├── clipboard-bridge.ts
│   │   └── content-script.ts
│   ├── popup/              # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   ├── types/              # TypeScript type definitions
│   │   └── index.ts
│   └── utils/              # Utility functions
│       ├── conversation-detector.ts
│       ├── readability-metrics.ts
│       └── storage.ts
├── public/
│   ├── manifest.json       # Extension manifest
│   └── icons/              # Extension icons
├── dist/                   # Build output
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## Tech Stack

- **TypeScript**: Type-safe development
- **Manifest V3**: Latest browser extension standard
- **Vite**: Fast build tooling
- **Chrome Storage API**: Local data persistence
- **text-readability-ts**: Text readability / complexity analysis
- **Vanilla TypeScript**: No framework dependencies for optimal performance

## Architecture

### Content Script
Runs on target websites and listens for copy events. Captures:
- Copied text content
- Timestamp
- URL and domain
- Selection context

### Background Service Worker
Processes and stores copy activities using Chrome Storage API. Also:
- Enriches copy activities with turn matching and category assignment
- Computes text readability metrics on LLM responses and response-side copies
- Categorizes turns and unmatched copies via LLM-2

### Popup UI
Displays tracked activities with:
- Total copy count
- Recent activities list
- Clear all option
- Privacy information

## Text Readability Metrics

When an LLM response is captured (turn or response-side copy), the extension computes readability metrics using the `text-readability-ts` library. Metrics are stored on `ConversationTurn.response.readability` and `CopyActivity.readability`.

### Raw Metrics (TextReadabilityMetrics)

| Metric | What it measures | Range / units |
|--------|-----------------|---------------|
| `fleschReadingEase` | Overall readability (higher = easier) | 0–100+ |
| `fleschKincaidGrade` | US school grade level | Grade number |
| `smogIndex` | Grade level needed to understand (based on polysyllables) | Grade number |
| `colemanLiauIndex` | Grade level based on characters per word / sentences | Grade number |
| `automatedReadabilityIndex` | Grade level from character counts | Grade number |
| `gunningFog` | Complexity based on sentence length and hard words | Grade number |
| `daleChallReadabilityScore` | Score using a list of familiar words | Raw score |
| `lix` | Swedish readability index (Läsbarhetsindex) | Index value |
| `rix` | Anderson's Rix readability | Index value |
| `textStandard` | Consensus grade string, e.g. "9th and 10th grade" | String |
| `textMedian` | Median grade across all formulas | Grade number |

### Derived Complexity (TextComplexitySummary)

The `gradeConsensus` value (from `textMedian`) is mapped to a human-friendly band:

| Band | Grade range | Meaning |
|------|-------------|---------|
| `very-easy` | ≤ 4 | Elementary school level |
| `easy` | 5 – 7 | Middle school level |
| `moderate` | 8 – 10 | High school level |
| `hard` | 11 – 13 | College level |
| `very-hard` | ≥ 14 | Graduate / professional level |

Optional `reasonCodes` explain the band, e.g. `low-flesch-ease`, `high-fog`, `high-smog`.

### Limits

- Text shorter than 20 words is skipped (too short for reliable scoring).
- Text longer than 50,000 characters is truncated to the first 50k before scoring.
- All library calls are wrapped with safe defaults (0 on error) to prevent crashes.

## Scripts

- `npm run dev` - Build in watch mode for development
- `npm run build` - Build for production
- `npm run type-check` - Run TypeScript type checking

