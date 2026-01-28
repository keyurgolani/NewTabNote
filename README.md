# New Tab Note

A rich block-based note editor that replaces your browser's new tab page. Inspired by Notion and Obsidian, designed for quick note-taking with AI-powered features.

## Features

### Editor

- **Block-Based Editor**: 18 different block types for structured content
- **Slash Commands**: Type `/` in an empty block to access all block types
- **Markdown Shortcuts**: Use familiar shortcuts like `# `, `- `, `> `, ` ``` `
- **Drag & Drop**: Reorder blocks by dragging the handle
- **Block Timestamps**: Hover over any block to see creation and last edit time
- **Wide Content Support**: Tables, images, and videos automatically center when wider than the editor

### Organization

- **Multiple Notes**: Create and manage unlimited notes
- **Tabbed Interface**: Open multiple notes in tabs, double-click sidebar items to open in new tab
- **Sidebar Navigation**: Browse, search, and manage all notes with list or card view
- **Archive**: Archive notes you want to keep but hide from the main list
- **Trash**: Deleted notes go to trash with configurable auto-delete (7-90 days)
- **Fuzzy Search**: Quickly find notes by searching titles and content

### Customization

- **Theme**: Light, Dark, or System (auto-detect)
- **Font**: System Default, Serif, or Monospace
- **Editor Width**: Narrow (540px), Default (720px), Wide (900px), or Full Width
- **Resizable Sidebar**: Drag the sidebar edge to resize (180-500px)

### AI Assistant

- **AI Chat Sidebar**: Floating button opens a chat interface for AI interactions
- **Summarize**: Get concise summaries of your notes
- **Expand**: Add more details and explanations to content
- **Generate Title**: Auto-generate titles for untitled notes
- **Ask Questions**: Ask anything about your note content
- **Auto-Title**: Optionally auto-generate titles when you start typing in a new note

Supported AI Providers:

- **OpenAI**: GPT-4o, GPT-4o Mini, GPT-4 Turbo, GPT-3.5 Turbo
- **Anthropic**: Claude Sonnet 4, Claude 3.5 Sonnet, Claude 3 Opus, Claude 3 Haiku
- **Google Gemini**: Gemini 2.0 Flash, Gemini 1.5 Pro, Gemini 1.5 Flash
- **OpenRouter**: Access multiple models via single API
- **Ollama**: Run local models (requires CORS configuration)

### Data Management

- **Local Storage**: All data stored locally in IndexedDB
- **Export/Import**: Backup and restore notes as JSON
- **Export to Markdown**: Export individual notes as `.md` files
- **No Server Required**: Works completely offline (except AI features)

## Block Types

| Type          | Shortcut        | Description                                     |
| ------------- | --------------- | ----------------------------------------------- |
| Text          | -               | Plain text paragraph                            |
| Heading 1     | `# `            | Large section heading                           |
| Heading 2     | `## `           | Medium section heading                          |
| Heading 3     | `### `          | Small section heading                           |
| Bulleted List | `- ` or `* `    | Bullet point item                               |
| Numbered List | `1. `           | Numbered list item                              |
| To-do         | `[] ` or `[ ] ` | Checkbox item                                   |
| Toggle        | `/toggle`       | Collapsible content section                     |
| Quote         | `> `            | Block quote                                     |
| Code          | ` ``` `         | Code block with monospace font                  |
| Divider       | `---`           | Horizontal separator line                       |
| Callout       | `/callout`      | Highlighted info box with icon                  |
| Image         | `/image`        | Upload and display images                       |
| Table         | `/table`        | Editable table with add/remove rows and columns |
| Bookmark      | `/bookmark`     | Link preview card with title and description    |
| Video         | `/video`        | Embed YouTube or Vimeo videos                   |
| File          | `/file`         | File attachment with download                   |
| Equation      | `/equation`     | Math equation display                           |

## Keyboard Shortcuts

| Action             | Shortcut                    |
| ------------------ | --------------------------- |
| New block          | `Enter`                     |
| Delete/merge block | `Backspace` at start        |
| Navigate blocks    | `Arrow Up/Down`             |
| Open commands      | `/` in empty block          |
| Focus title        | `Arrow Up` from first block |

## Settings

Access settings via the gear icon in the header:

### Appearance

- **Theme**: Light / Dark / System
- **Font**: Default / Serif / Monospace
- **Editor Width**: Narrow / Default / Wide / Full

### AI Assistant

- **Provider**: Select your AI provider
- **API Key**: Enter your API key (stored locally)
- **Model**: Choose from available models (auto-fetched from API)
- **Ollama URL**: Configure local Ollama server URL
- **Auto-generate titles**: Enable automatic title generation for new notes
- **Auto-title interval**: How often to check for untitled notes (5 min - 1 month)

### Trash

- **Auto-delete after**: 7 / 14 / 30 / 60 / 90 days, or Never

### Data

- **Export All Notes**: Download all notes as JSON backup
- **Export Current Note**: Download current note as JSON
- **Create Backup**: Full backup including media
- **Import / Restore**: Restore from backup file

## Installation

### From Chrome Web Store (Recommended)

_Coming soon - pending review_

### From Release - CRX File (Enterprise/Developer)

> ⚠️ Chrome restricts `.crx` installation to enterprise environments or developer mode due to security policies.

1. Download the latest `new-tab-note-vX.X.X.crx` from [Releases](https://github.com/keyurgolani/new-tab-note/releases)
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Drag and drop the `.crx` file onto the extensions page

### From Release - ZIP File (Developer Mode)

1. Download the latest `new-tab-note-vX.X.X.zip` from [Releases](https://github.com/keyurgolani/new-tab-note/releases)
2. Extract the zip file to a permanent location
3. Open Chrome and navigate to `chrome://extensions/`
4. Enable "Developer mode" in the top right corner
5. Click "Load unpacked" and select the extracted folder
6. Open a new tab to start using New Tab Note

### From Source (Development)

1. Clone this repository
2. Install dependencies: `npm install`
3. Build the extension: `npm run build`
4. Open Chrome and navigate to `chrome://extensions/`
5. Enable "Developer mode" in the top right corner
6. Click "Load unpacked" and select the `dist` folder
7. Open a new tab to start using New Tab Note

## Development

### Prerequisites

- Node.js 18+
- npm

### Scripts

```bash
# Install dependencies
npm install

# Build for production (minified)
npm run build

# Build for development (no minification)
npm run build:dev

# Create release package (.zip)
npm run package

# Full release build (clean + build + package)
npm run release

# Clean build artifacts
npm run clean
```

### Project Structure

```
new-tab-note/
├── css/              # Stylesheets
├── icons/            # Extension icons
├── js/               # Source JavaScript
├── scripts/          # Build scripts
├── dist/             # Build output (generated)
├── releases/         # Release packages (generated)
├── manifest.json     # Chrome extension manifest
├── newtab.html       # Main new tab page
├── popup.html        # Extension popup
└── offscreen.html    # Offscreen document for API calls
```

### Release Process

Releases are automated via GitHub Actions. To create a new release:

1. Update version in `manifest.json` and `package.json`
2. Commit and push changes
3. Create and push a tag: `git tag v1.0.1 && git push origin v1.0.1`
4. GitHub Actions will build, package, and create a release with the `.zip` file

## Ollama Setup

To use Ollama (local AI models), start Ollama with CORS enabled:

```bash
OLLAMA_ORIGINS=chrome-extension://* ollama serve
```

## Privacy

- All notes are stored locally in your browser's IndexedDB
- No data is sent to any server except when using AI features
- AI requests go directly to your configured provider with your API key
- API keys are stored locally and never transmitted elsewhere

## License

MIT
