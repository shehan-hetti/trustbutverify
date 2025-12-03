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
│   │   └── content-script.ts
│   ├── popup/              # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   ├── types/              # TypeScript type definitions
│   │   └── index.ts
│   └── utils/              # Utility functions
|       ├── conversation-detector.ts 
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
- **Vanilla TypeScript**: No framework dependencies for optimal performance

## Architecture

### Content Script
Runs on target websites and listens for copy events. Captures:
- Copied text content
- Timestamp
- URL and domain
- Selection context

### Background Service Worker
Processes and stores copy activities using Chrome Storage API.

### Popup UI
Displays tracked activities with:
- Total copy count
- Recent activities list
- Clear all option
- Privacy information

## Scripts

- `npm run dev` - Build in watch mode for development
- `npm run build` - Build for production
- `npm run type-check` - Run TypeScript type checking

