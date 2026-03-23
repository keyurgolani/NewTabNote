/**
 * ThemeEngine handles applying and managing CSS custom properties for theming.
 */
class ThemeEngine {
    constructor() {
        this.currentTheme = null;
        this.defaultProperties = {
            '--bg-primary': '#ffffff',
            '--bg-secondary': '#f7f7f7',
            '--bg-hover': '#f0f0f0',
            '--bg-active': '#e8e8e8',
            '--text-primary': '#1a1a1a',
            '--text-secondary': '#6b6b6b',
            '--text-muted': '#9b9b9b',
            '--text-placeholder': '#c4c4c4',
            '--border-color': '#e5e5e5',
            '--accent-color': '#2383e2',
            '--accent-hover': '#1a6fc4',
            '--danger-color': '#e03e3e',
            '--code-bg': '#f4f4f4',
            '--selection-bg': 'rgba(35, 131, 226, 0.15)',
        };

        this.darkProperties = {
            '--bg-primary': '#191919',
            '--bg-secondary': '#252525',
            '--bg-hover': '#2f2f2f',
            '--bg-active': '#3a3a3a',
            '--text-primary': '#e0e0e0',
            '--text-secondary': '#9b9b9b',
            '--text-muted': '#6b6b6b',
            '--text-placeholder': '#4a4a4a',
            '--border-color': '#333',
            '--code-bg': '#2a2a2a',
            '--selection-bg': 'rgba(35, 131, 226, 0.25)',
        };
    }

    /**
     * Initialize and apply the saved theme.
     * @returns {Promise<void>}
     */
    async init() {
        const themeId = await Storage.getSetting('theme', 'light');
        await this.applyTheme(themeId);
    }

    /**
     * Apply a theme by ID.
     * @param {string} themeId - Theme identifier ('light', 'dark', 'system', or custom theme ID)
     * @returns {Promise<void>}
     */
    async applyTheme(themeId) {
        let properties = {};

        if (themeId === 'light') {
            properties = this.defaultProperties;
            document.documentElement.removeAttribute('data-theme');
        } else if (themeId === 'dark') {
            properties = this.darkProperties;
            document.documentElement.setAttribute('data-theme', 'dark');
        } else if (themeId === 'system') {
            const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            properties = isDark ? this.darkProperties : this.defaultProperties;
            document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
        } else {
            // Custom theme
            const customThemes = await Storage.getCustomThemes();
            const theme = customThemes.find(t => t.id === themeId);
            if (theme && theme.properties) {
                properties = theme.properties;
                // Determine if it's a dark or light custom theme for iconography/base styles
                const isDark = this.isThemeDark(properties['--bg-primary']);
                document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
            } else {
                // Fallback to light
                properties = this.defaultProperties;
                document.documentElement.removeAttribute('data-theme');
            }
        }

        this.injectProperties(properties);
        this.currentTheme = themeId;
    }

    /**
     * Inject CSS custom properties into :root.
     * @param {Object<string, string>} properties - CSS variable key-value pairs
     * @returns {void}
     */
    injectProperties(properties) {
        const root = document.documentElement;
        for (const [key, value] of Object.entries(properties)) {
            root.style.setProperty(key, value);
        }
    }

    /**
     * Determine if a background color is dark.
     * @param {string} hex - Hex color string
     * @returns {boolean} True if the color is dark
     */
    isThemeDark(hex) {
        if (!hex || hex[0] !== '#') return false;

        // Simple hex to brightness conversion
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);

        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness < 128;
    }

    /**
     * Get all available theme options for dropdowns
     */
    async getThemeOptions() {
        const customThemes = await Storage.getCustomThemes();
        const options = [
            { id: 'light', name: 'Light' },
            { id: 'dark', name: 'Dark' },
            { id: 'system', name: 'System' },
        ];

        customThemes.forEach(t => {
            options.push({ id: t.id, name: t.name, isCustom: true });
        });

        return options;
    }
}

// Global instance
window.Themes = new ThemeEngine();
