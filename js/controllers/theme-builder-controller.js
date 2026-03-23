/**
 * ThemeBuilderController — manages custom theme creation, editing,
 * live preview, and saving via the theme builder modal.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {EventBus} deps.eventBus
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 */
class ThemeBuilderController {
  constructor({ storage, eventBus, domRefs, logger }) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.domRefs = domRefs;
    this.logger = logger;

    // Temporary theme properties while editing
    this.tempThemeProperties = {};

    // App-level callbacks (set by App after construction)
    this.onApplyTheme = null;

    /** @type {function|null} */
    this._focusTrapCleanup = null;
  }

  /** Initialize: wire DOM listeners for the theme builder modal. */
  async init() {
    this.setupThemeBuilder();
  }

  /** Tear down — no persistent listeners to clean up currently. */
  destroy() {}

  // ─── Theme Builder setup ───

  setupThemeBuilder() {
    const modal = document.getElementById('theme-builder-modal');
    if (!modal) return;

    const closeBtn = modal.querySelector('.close-btn');
    const cancelBtn = document.getElementById('theme-builder-cancel');
    const saveBtn = document.getElementById('theme-builder-save');
    const nameInput = document.getElementById('theme-builder-name');

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        if (this._focusTrapCleanup) { this._focusTrapCleanup(); this._focusTrapCleanup = null; }
        if (this.onApplyTheme) this.onApplyTheme();
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        if (this._focusTrapCleanup) { this._focusTrapCleanup(); this._focusTrapCleanup = null; }
        if (this.onApplyTheme) this.onApplyTheme();
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const name = (nameInput && nameInput.value.trim()) || 'Custom Theme';
        const theme = {
          name: name,
          properties: this.tempThemeProperties
        };
        const savedTheme = await this.storage.saveCustomTheme(theme);
        await this.storage.setSetting('theme', savedTheme.id);
        if (this.onApplyTheme) this.onApplyTheme();
        modal.classList.add('hidden');
        if (this._focusTrapCleanup) { this._focusTrapCleanup(); this._focusTrapCleanup = null; }
        Utils.showToast('Theme saved!', 'success');
      });
    }
  }

  // ─── Open Theme Builder ───

  async openThemeBuilder() {
    const modal = document.getElementById('theme-builder-modal');
    const controls = document.getElementById('theme-color-controls');
    const nameInput = document.getElementById('theme-builder-name');

    if (!modal || !controls) return;

    modal.classList.remove('hidden');
    this._focusTrapCleanup = Utils.trapFocus(modal);
    controls.innerHTML = '';

    // Start with current properties
    const currentThemeId = await this.storage.getSetting('theme', 'light');
    const options = await Themes.getThemeOptions();
    const currentTheme = options.find(o => o.id === currentThemeId);

    // Determine base properties to start from
    let baseProps = { ...Themes.defaultProperties };
    if (currentThemeId === 'dark' || (currentThemeId === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      baseProps = { ...Themes.darkProperties };
    }

    // If current is custom, use its name and props
    if (currentTheme && currentTheme.isCustom) {
      const allCustom = await this.storage.getCustomThemes();
      const fullTheme = allCustom.find(t => t.id === currentThemeId);
      if (fullTheme) {
        baseProps = { ...fullTheme.properties };
        if (nameInput) nameInput.value = fullTheme.name;
      }
    } else {
      if (nameInput) nameInput.value = '';
    }

    this.tempThemeProperties = { ...baseProps };

    // Create color pickers for each property
    for (const [prop, value] of Object.entries(this.tempThemeProperties)) {
      // Create control row
      const row = document.createElement('div');
      row.className = 'setting-row';

      const label = document.createElement('label');
      // Humanize label: --bg-primary -> Background Primary
      label.textContent = prop.replace('--', '').split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = this.colorToHex(value);

      picker.addEventListener('input', (e) => {
        this.tempThemeProperties[prop] = e.target.value;
        Themes.injectProperties(this.tempThemeProperties); // Live preview
      });

      row.appendChild(label);
      row.appendChild(picker);
      controls.appendChild(row);
    }
  }

  // ─── Helpers ───

  /**
   * Helper to convert various color formats to hex for <input type="color">
   */
  colorToHex(color) {
    if (!color) return '#000000';
    if (color.startsWith('#')) return color.substring(0, 7);
    if (color.startsWith('rgba') || color.startsWith('rgb')) {
      const parts = color.match(/[\d.]+/g);
      if (parts && parts.length >= 3) {
        const r = parseInt(parts[0]);
        const g = parseInt(parts[1]);
        const b = parseInt(parts[2]);
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
      }
    }
    return '#000000';
  }
}

// Dual CommonJS/browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ThemeBuilderController };
} else if (typeof window !== 'undefined') {
  window.ThemeBuilderController = ThemeBuilderController;
}
