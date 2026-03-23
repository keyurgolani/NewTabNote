/**
 * Onboarding Manager - handles the first-run experience
 * Provides tooltip-style walkthrough, welcome note creation, and quick-start prompt.
 */
class OnboardingManager {
  /**
   * Get the welcome note content blocks for new users.
   * Includes text, headings, lists, todos, code, and wiki-links per Req 7.2.
   * @returns {Array<{type: string, content: string, checked?: boolean}>} Array of block data
   */
  static getWelcomeNoteContent() {
    return [
      { type: 'text', content: 'Welcome to <b>NewTabNote</b>! 🚀' },
      { type: 'text', content: 'This is a block-based note-taking app designed for speed and productivity. Every paragraph, image, or list is a "block" that you can move, change, or delete.' },

      { type: 'h2', content: 'Quick Start' },
      { type: 'text', content: '<b>Slash Commands</b>: Type <code class="code-pill">/</code> in any empty block to see all available block types.' },
      { type: 'text', content: '<b>Daily Notes</b>: Click the 📅 icon in the sidebar or press <kbd>Alt</kbd>+<kbd>D</kbd> to open today\'s note.' },
      { type: 'text', content: '<b>Drag &amp; Drop</b>: Grab the ⠿ handle on the left of any block to reorder it.' },

      { type: 'h2', content: 'Try It Out' },
      { type: 'todo', content: 'Check off this todo item', checked: false },
      { type: 'todo', content: 'Create a new note from the sidebar', checked: false },
      { type: 'todo', content: 'Try the slash command menu by typing /', checked: false },

      { type: 'h2', content: 'Code Blocks' },
      { type: 'text', content: 'You can add code snippets with syntax highlighting:' },
      { type: 'code', content: 'console.log("Hello from NewTabNote!");' },

      { type: 'h2', content: 'AI Powered Features' },
      { type: 'text', content: 'We\'ve integrated AI to help you organize your thoughts.' },
      { type: 'bullet', content: '<b>Semantic Search</b>: Find notes by meaning, not just keywords.' },
      { type: 'bullet', content: '<b>Smart Sidebar</b>: Click the ✨ button to chat with your notes or see proactive insights.' },

      { type: 'h2', content: 'Organization' },
      { type: 'bullet', content: '<b>Folders</b>: Create folders in the sidebar and drag notes into them.' },
      { type: 'bullet', content: '<b>Backlinks</b>: Use <code class="code-pill">[[Note Name]]</code> to link notes together.' },

      { type: 'text', content: 'Happy note-taking! ✨' }
    ];
  }

  /**
   * Configure default settings for first-run users.
   * @returns {Promise<void>}
   */
  static async setupFirstRun() {
    await Storage.setSetting('embeddingsEnabled', true);
    await Storage.setSetting('autoTitleEnabled', true);
    await Storage.setSetting('insightsEnabled', true);
  }

  /**
   * Check whether onboarding has already been completed.
   * @returns {Promise<boolean>}
   */
  static async hasCompleted() {
    return !!(await Storage.getSetting('hasCompletedOnboarding', false));
  }

  /**
   * Mark onboarding as complete and persist the flag.
   * @returns {Promise<void>}
   */
  static async markComplete() {
    await Storage.setSetting('hasCompletedOnboarding', true);
  }

  /**
   * Walkthrough step definitions. Each step targets a UI element with a tooltip.
   * @returns {Array<{target: string, title: string, description: string, position: string}>}
   */
  static getWalkthroughSteps() {
    return [
      {
        target: 'sidebar',
        title: 'Sidebar',
        description: 'Browse, search, and organize all your notes here. Create folders, pin favorites, and switch between notes, templates, archive, and trash.',
        position: 'right'
      },
      {
        target: 'editor-container',
        title: 'Editor',
        description: 'This is your writing space. Each paragraph is a "block" you can move, convert, or delete. Just start typing!',
        position: 'left'
      },
      {
        target: 'add-block-hint',
        title: 'Slash Commands',
        description: 'Type / in any empty block to open the command menu. Add headings, lists, code blocks, images, tables, and more.',
        position: 'top'
      },
      {
        target: 'ai-floating-btn',
        title: 'AI Chat',
        description: 'Chat with AI about your notes. Get summaries, expand ideas, rewrite content, or search across all your notes.',
        position: 'left'
      },
      {
        target: 'sidebar-daily-note',
        title: 'Daily Notes',
        description: 'One-click access to today\'s note. Great for journals, standups, or daily planning. Press Alt+D anytime.',
        position: 'right'
      }
    ];
  }

  /**
   * Run the interactive tooltip walkthrough.
   * Resolves when the user completes or dismisses the walkthrough.
   * @returns {Promise<void>}
   */
  static runWalkthrough() {
    return new Promise((resolve) => {
      const steps = OnboardingManager.getWalkthroughSteps();
      let currentStep = 0;

      // Create overlay backdrop
      const overlay = document.createElement('div');
      overlay.className = 'onboarding-overlay';

      // Create tooltip container
      const tooltip = document.createElement('div');
      tooltip.className = 'onboarding-tooltip';
      tooltip.setAttribute('role', 'dialog');
      tooltip.setAttribute('aria-label', 'Onboarding walkthrough');

      document.body.appendChild(overlay);
      document.body.appendChild(tooltip);

      const cleanup = () => {
        overlay.remove();
        tooltip.remove();
        // Remove any highlight from previous step
        const highlighted = document.querySelector('.onboarding-highlight');
        if (highlighted) highlighted.classList.remove('onboarding-highlight');
        resolve();
      };

      const renderStep = (index) => {
        const step = steps[index];
        const targetEl = document.getElementById(step.target);

        // Remove previous highlight
        const prevHighlighted = document.querySelector('.onboarding-highlight');
        if (prevHighlighted) prevHighlighted.classList.remove('onboarding-highlight');

        // Highlight current target
        if (targetEl) {
          targetEl.classList.add('onboarding-highlight');
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        const isLast = index === steps.length - 1;
        const stepCounter = `${index + 1} / ${steps.length}`;

        tooltip.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'onboarding-tooltip-header';

        const title = document.createElement('span');
        title.className = 'onboarding-tooltip-title';
        title.textContent = step.title;

        const counter = document.createElement('span');
        counter.className = 'onboarding-tooltip-counter';
        counter.textContent = stepCounter;

        header.appendChild(title);
        header.appendChild(counter);

        const desc = document.createElement('p');
        desc.className = 'onboarding-tooltip-desc';
        desc.textContent = step.description;

        const actions = document.createElement('div');
        actions.className = 'onboarding-tooltip-actions';

        const skipBtn = document.createElement('button');
        skipBtn.className = 'onboarding-btn onboarding-btn-skip';
        skipBtn.textContent = 'Skip';
        skipBtn.addEventListener('click', cleanup);

        const nextBtn = document.createElement('button');
        nextBtn.className = 'onboarding-btn onboarding-btn-next';
        nextBtn.textContent = isLast ? 'Done' : 'Next';
        nextBtn.addEventListener('click', () => {
          if (isLast) {
            cleanup();
          } else {
            currentStep++;
            renderStep(currentStep);
          }
        });

        actions.appendChild(skipBtn);
        actions.appendChild(nextBtn);

        tooltip.appendChild(header);
        tooltip.appendChild(desc);
        tooltip.appendChild(actions);

        // Position tooltip near target
        OnboardingManager._positionTooltip(tooltip, targetEl, step.position);

        nextBtn.focus();
      };

      // Dismiss on overlay click
      overlay.addEventListener('click', cleanup);

      // Dismiss on Escape
      const onKeydown = (e) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKeydown);
          cleanup();
        }
      };
      document.addEventListener('keydown', onKeydown);

      renderStep(0);
    });
  }

  /**
   * Position the tooltip relative to a target element.
   * @param {HTMLElement} tooltip
   * @param {HTMLElement|null} targetEl
   * @param {string} preferredPosition - 'top'|'bottom'|'left'|'right'
   */
  static _positionTooltip(tooltip, targetEl, preferredPosition) {
    if (!targetEl) {
      // Center on screen if target not found
      tooltip.style.top = '50%';
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translate(-50%, -50%)';
      return;
    }

    const rect = targetEl.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gap = 12;

    let top, left;

    switch (preferredPosition) {
      case 'right':
        top = rect.top + rect.height / 2 - tooltipRect.height / 2;
        left = rect.right + gap;
        break;
      case 'left':
        top = rect.top + rect.height / 2 - tooltipRect.height / 2;
        left = rect.left - tooltipRect.width - gap;
        break;
      case 'top':
        top = rect.top - tooltipRect.height - gap;
        left = rect.left + rect.width / 2 - tooltipRect.width / 2;
        break;
      case 'bottom':
      default:
        top = rect.bottom + gap;
        left = rect.left + rect.width / 2 - tooltipRect.width / 2;
        break;
    }

    // Clamp to viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    top = Math.max(8, Math.min(top, vh - tooltipRect.height - 8));
    left = Math.max(8, Math.min(left, vw - tooltipRect.width - 8));

    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
    tooltip.style.transform = 'none';
  }

  /**
   * Show the quick-start prompt after the walkthrough.
   * @param {string} welcomeNoteId - ID of the created welcome note
   * @returns {Promise<string>} The user's choice: 'blank', 'sample', or 'import'
   */
  static showQuickStartPrompt(welcomeNoteId) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'onboarding-overlay onboarding-overlay-dark';

      const dialog = document.createElement('div');
      dialog.className = 'onboarding-quickstart';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', 'Quick start');

      const title = document.createElement('h2');
      title.className = 'onboarding-quickstart-title';
      title.textContent = 'How would you like to start?';

      const options = document.createElement('div');
      options.className = 'onboarding-quickstart-options';

      const choices = [
        { id: 'blank', icon: '📝', label: 'Start a blank note', desc: 'Jump right in with an empty note' },
        { id: 'sample', icon: '📖', label: 'Open the sample note', desc: 'Explore the Welcome note with examples' },
        { id: 'import', icon: '📥', label: 'Import existing notes', desc: 'Bring in notes from Markdown or JSON' }
      ];

      const cleanup = (choice) => {
        overlay.remove();
        dialog.remove();
        resolve(choice);
      };

      choices.forEach((choice) => {
        const btn = document.createElement('button');
        btn.className = 'onboarding-quickstart-btn';

        const icon = document.createElement('span');
        icon.className = 'onboarding-quickstart-icon';
        icon.textContent = choice.icon;

        const text = document.createElement('div');
        text.className = 'onboarding-quickstart-text';

        const label = document.createElement('span');
        label.className = 'onboarding-quickstart-label';
        label.textContent = choice.label;

        const desc = document.createElement('span');
        desc.className = 'onboarding-quickstart-desc';
        desc.textContent = choice.desc;

        text.appendChild(label);
        text.appendChild(desc);
        btn.appendChild(icon);
        btn.appendChild(text);

        btn.addEventListener('click', () => cleanup(choice.id));
        options.appendChild(btn);
      });

      dialog.appendChild(title);
      dialog.appendChild(options);

      document.body.appendChild(overlay);
      document.body.appendChild(dialog);

      // Dismiss overlay defaults to sample note
      overlay.addEventListener('click', () => cleanup('sample'));

      // Focus first button
      const firstBtn = options.querySelector('button');
      if (firstBtn) firstBtn.focus();
    });
  }
}

window.Onboarding = OnboardingManager;
