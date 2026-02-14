/**
 * Onboarding Manager - handles the first-run experience
 */
class OnboardingManager {
    static getWelcomeNoteContent() {
        return [
            { type: 'text', content: 'Welcome to <b>NewTabNote</b>! 🚀' },
            { type: 'text', content: 'This is a block-based note-taking app designed for speed and productivity. Every paragraph, image, or list is a "block" that you can move, change, or delete.' },

            { type: 'h2', content: 'Quick Start' },
            { type: 'text', content: '1. <b>Slash Commands</b>: Type <code class="code-pill">/</code> in any empty block to see all available block types (Headers, Lists, Images, etc.).' },
            { type: 'text', content: '2. <b>Daily Notes</b>: Click the 📅 icon in the sidebar or press <kbd>Alt</kbd>+<kbd>D</kbd> to open your note for today.' },
            { type: 'text', content: '3. <b>Drag & Drop</b>: Grab the ⠿ handle on the left of any block to reorder it.' },

            { type: 'h2', content: 'AI Powered Features' },
            { type: 'text', content: 'We\'ve integrated local AI to help you organize your thoughts without compromising privacy.' },
            { type: 'text', content: '• <b>Semantic Search</b>: Find notes by meaning, not just keywords.' },
            { type: 'text', content: '• <b>Smart Sidebar</b>: Click the ✨ button in the bottom right to chat with your notes or see proactive insights.' },

            { type: 'h2', content: 'Organization' },
            { type: 'text', content: '• <b>Folders</b>: Create folders in the sidebar and drag notes into them.' },
            { type: 'text', content: '• <b>Backlinks</b>: Use <code class="code-pill">[[Note Name]]</code> to link notes together. Check the "Backlinks" panel at the bottom of any note to see what links to it.' },

            { type: 'text', content: 'Happy note-taking!' }
        ];
    }

    static async setupFirstRun() {
        // Enable local semantic search by default for new users
        await Storage.saveSetting('embeddingsEnabled', true);
        await Storage.saveSetting('autoTitleEnabled', true);
        await Storage.saveSetting('insightsEnabled', true);
    }
}

window.Onboarding = OnboardingManager;
