# Privacy Policy for New Tab Note

**Last Updated: February 2, 2026**

## Overview

New Tab Note is a browser extension that provides a rich note-taking experience in your new tab page. We are committed to protecting your privacy and being transparent about our data practices.

## Data Storage

**All your data is stored locally on your device.** We do not collect, transmit, or store any of your data on external servers.

- **Notes and Content**: Stored in your browser's IndexedDB (local database)
- **Settings and Preferences**: Stored in Chrome's local storage (`chrome.storage.local`)
- **Media Files**: Images and attachments are stored locally in IndexedDB

## Data We Do NOT Collect

- We do not collect personal information
- We do not track your browsing activity
- We do not use analytics or tracking services
- We do not share any data with third parties
- We do not transmit your notes or content to any server

## AI Features (Optional)

If you choose to use AI-powered features (summarization, title generation, chat):

- **You provide your own API key** for your chosen AI provider (OpenAI, Anthropic, Google, etc.)
- **Requests go directly from your browser to your chosen AI provider** - we do not proxy or intercept these requests
- **Your API key is stored locally** on your device and is never transmitted to us
- **Note content sent to AI providers** is subject to that provider's privacy policy

Supported AI providers include: OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, Mistral, Groq, Qwen, GLM, Kimi, MiniMax, OpenRouter, and Ollama (local).

## Permissions

This extension requests the following permissions:

- **storage**: To save your settings and preferences locally
- **unlimitedStorage**: To allow storing large notes and media files locally
- **offscreen**: To make AI API calls in the background
- **host_permissions (https://_/_)**: To fetch metadata for bookmark blocks and make AI API requests

## Data Export and Backup

You can export all your data at any time using the built-in export feature. Your data belongs to you.

## Changes to This Policy

We may update this privacy policy from time to time. Any changes will be reflected in the "Last Updated" date above.

## Contact

If you have questions about this privacy policy, please open an issue on our [GitHub repository](https://github.com/keyurgolani/new-tab-note).

---

**Summary**: Your notes stay on your device. We don't collect or transmit any data. AI features are optional and use your own API keys.
