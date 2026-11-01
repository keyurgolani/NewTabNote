# Privacy Policy for New Tab Note

**Last Updated: October 20, 2026**

## Overview

New Tab Note is a browser extension that provides a rich note-taking experience in your new tab page. We are committed to protecting your privacy and being transparent about our data practices.

## Data Storage

**All your data is stored locally on your device.** We do not collect, transmit, or store any of your data on external servers.

- **Notes and Content**: Stored in your browser's IndexedDB (local database)
- **Settings and Preferences**: Stored in Chrome's local storage (`chrome.storage.local`)
- **Media Files**: Images and attachments are stored locally in IndexedDB
- **Backups**: Automatic backups and recovery copies are stored locally in `chrome.storage.local`
- **The last edit of a closing tab**: When a tab closes before its last edit is saved, that edit is kept in the extension's own local storage (`localStorage`) on your device until NewTabNote next opens, which saves it into your notes and removes it. Deleting a note for good removes its kept edit too.

## Data We Do NOT Collect

- We do not collect personal information
- We do not track your browsing activity
- We do not use analytics or tracking services
- We do not share any data with third parties
- We do not run a server, so your notes and content never reach us

## AI Features (Optional)

If you choose to use AI-powered features (summarization, title generation, chat):

- **You provide your own API key** for your chosen AI provider (OpenAI, Anthropic, Google, etc.)
- **Requests go directly from your browser to your chosen AI provider** - we do not proxy or intercept these requests
- **Your API key is stored locally** on your device and is never transmitted to us
- **Note content sent to AI providers** is subject to that provider's privacy policy

Supported AI providers include: OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, Mistral, Groq, Qwen, GLM, Kimi, MiniMax, OpenRouter, and Ollama (local).

## Permissions

This extension requests the following permissions:

- **storage**: To save your settings, preferences, and local backup copies in Chrome's local storage
- **unlimitedStorage**: To store large notes, media, and local backups beyond Chrome's default storage limit
- **offscreen**: To send AI requests to a local Ollama server from an offscreen extension page
- **contextMenus**: To add "Add current page to today's note" and "Add selection to today's note" to the right-click menu
- **notifications**: To tell you whether a page or selection was saved to today's note
- **activeTab**: To read the current tab's address and title, only when you capture it with the right-click menu or a keyboard shortcut
- **sidePanel**: To show the Intelligence side panel when you click the toolbar icon

Host permissions cover the AI providers you can choose in Settings: OpenAI (api.openai.com), Anthropic (api.anthropic.com), Google Gemini (generativelanguage.googleapis.com), OpenRouter (openrouter.ai), xAI (api.x.ai), DeepSeek (api.deepseek.com), Mistral (api.mistral.ai), Groq (api.groq.com), Qwen (dashscope-intl.aliyuncs.com and dashscope.aliyuncs.com), GLM (api.z.ai and open.bigmodel.cn), Kimi (api.moonshot.ai and api.moonshot.cn), and MiniMax (api.minimax.io and api.minimax.chat), plus `http://localhost` for Ollama running on your own computer. The extension only contacts the provider you select, and only when you use an AI feature.

## Network Requests

New Tab Note has no server of its own. These are the requests it can make, and when:

- **Your chosen AI provider**: When you use an AI feature, your prompt and the note text that feature works on go to the provider you selected, or to Ollama at `http://localhost`.
- **Embedding model for semantic search**: The first time you open the AI sidebar or semantic search runs, your browser downloads the all-MiniLM-L6-v2 model from `huggingface.co` (its files may come from Hugging Face's `*.huggingface.co` and `*.hf.co` hosts) and the ONNX Runtime WebAssembly files from `cdn.jsdelivr.net`. Embeddings are computed on your device; your notes are not sent.
- **Bookmark icons**: Bookmark blocks show the site's icon from Google's favicon service (`https://www.google.com/s2/favicons`), which receives the bookmarked site's domain name.
- **Video blocks**: A video block with a YouTube or Vimeo link loads that service's player (`youtube.com` or `player.vimeo.com`) inside the note.
- **Images from web addresses**: Image blocks that point to a web address, including images in Markdown you paste or import, load the image from that address.

## Data Export and Backup

You can export your data at any time from Settings > Data & Backup. Your data belongs to you.

- **Export JSON** and **Create Backup** include active and archived notes, templates, folders, and media. They leave out trash, themes, version history, AI chat history, and settings, including your AI key.
- **Export All (ZIP/MD)** holds your active notes only, as Markdown.
- Before **Replace all** on import, a recovery copy of your notes is saved locally first.

## Changes to This Policy

We may update this privacy policy from time to time. Any changes will be reflected in the "Last Updated" date above.

## Contact

If you have questions about this privacy policy, please open an issue on our [GitHub repository](https://github.com/keyurgolani/new-tab-note).

---

**Summary**: Your notes stay on your device. We don't collect or transmit any data. AI features are optional and use your own API keys.
