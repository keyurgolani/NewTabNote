/**
 * AIChatController — manages AI chat sidebar UI: message rendering, prompt submission,
 * response handling, insert-preview, chat history, global chat (RAG), smart suggestions,
 * prompt templates, and LLM settings.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {EventBus} deps.eventBus
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 * @param {LLMService} deps.llm
 */
class AIChatController {
  constructor({ storage, eventBus, domRefs, logger, llm }) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.domRefs = domRefs;
    this.logger = logger;
    this.llm = llm;

    // AI Chat sidebar state
    this.aiSidebarOpen = false;
    this.aiSidebarWidth = 360;
    this.aiSidebarResizer = null;
    this.aiActiveTab = 'note';

    // Chat history
    this.aiChatHistory = [];
    this.noteChatMessages = [];
    this.globalChatHistory = [];
    this.globalChatMessages = [];

    // Prompt templates
    this.aiPromptTemplates = [];
    this.aiPromptTemplateEditingId = null;

    // Insert preview
    this.aiInsertPreviewState = null;

    // Consecutive error tracking (Req 11.6)
    this._errorTimestamps = [];

    // Accessibility: batched screen reader announcements (Req 12.2)
    this._srAnnouncementBuffer = '';
    this._srAnnouncementTimer = null;
    this._srLiveRegion = null;
    this._escapeHandler = null;

    // SearchEngine reference (set by App)
    this.searchEngine = null;

    // App-level callbacks (set by App after construction)
    this.getEditor = null;           // () => BlockEditor
    this.onOpenNoteInNewTab = null;  // (noteId) => Promise<void>
    this.onOpenNoteById = null;      // (noteId) => Promise<void>
    this.onRefreshNotesList = null;  // () => Promise<void>
    this.onRenderNotesList = null;   // () => Promise<void>
    this.onOpenNewTab = null;        // () => Promise<void>
    this.onOpenSettingsModal = null;  // () => Promise<void>
    this.onCloseAllModals = null;    // () => void
    this.onGetOpenTabs = null;       // () => Array
    this.onRenderTabs = null;        // () => void
    this.onSaveTabs = null;          // () => Promise<void>
    this.onGetNotes = null;          // () => Note[]
    this.onTriggerIndexing = null;   // () => void
    this.onLoadEmbeddingsModel = null; // () => void
  }

  /** Initialize AI chat: load templates, wire DOM listeners, load history. */
  async init() {
    await this.loadAIPromptTemplates();
    this.setupAIInsertPreview();
    await this.setupAI();
  }

  /** Tear down resizer and accessibility listeners. */
  destroy() {
    if (this.aiSidebarResizer) {
      this.aiSidebarResizer.destroy();
      this.aiSidebarResizer = null;
    }
    this._cleanupAccessibility();
  }

  // ─── AI Sidebar setup ───

  /**
   * Setup AI chat sidebar functionality
   */
  async setupAI() {
    const aiSidebar = document.getElementById('ai-sidebar');
    const aiFloatingBtn = document.getElementById('ai-floating-btn');
    const aiCloseBtn = document.getElementById('ai-sidebar-close');
    const chatInput = document.getElementById('ai-chat-input');
    const chatSendBtn = document.getElementById('ai-chat-send');
    const settingsBtn = document.getElementById('ai-sidebar-open-settings');
    const noteSuggestions = document.getElementById('ai-note-suggestion-buttons');
    const stickyTemplateButtons = document.getElementById('ai-sticky-template-buttons');

    if (!aiSidebar) return;

    // Initialize chat state
    this.aiSidebarOpen = false;
    this.aiSidebarWidth = await this.storage.getSetting('aiSidebarWidth', 360);
    this.aiActiveTab = 'note';

    // Load persisted chat history
    await this.loadChatHistory();

    // Toggle AI sidebar from floating button
    aiFloatingBtn?.addEventListener('click', () => {
      this.openAISidebar();
    });

    // Close AI sidebar
    aiCloseBtn?.addEventListener('click', () => {
      this.closeAISidebar();
    });

    // Tab switching
    const tabNote = document.getElementById('ai-tab-note');
    const tabAll = document.getElementById('ai-tab-all');
    const tabSmart = document.getElementById('ai-tab-smart');

    tabNote?.addEventListener('click', () => {
      this.switchAITab('note');
    });

    tabAll?.addEventListener('click', () => {
      this.switchAITab('all');
    });

    tabSmart?.addEventListener('click', () => {
      this.switchAITab('smart');
    });

    // Send message (note chat)
    chatSendBtn?.addEventListener('click', () => {
      this.sendAIChatMessage();
    });

    // Handle Enter key in chat input
    chatInput?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendAIChatMessage();
      }

      // Open new tab
      if ((e.ctrlKey || e.metaKey) && e.key === 't' && !e.shiftKey) {
        e.preventDefault();
        if (this.onOpenNewTab) this.onOpenNewTab();
      }

      // Daily Note shortcut (Alt + D)
      if (e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const note = await this.storage.ensureDailyNote();
        if (this.onRefreshNotesList) await this.onRefreshNotesList();
        if (this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(note.id);
      }
    });

    // Auto-resize textarea
    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });

    noteSuggestions?.addEventListener('click', (event) => {
      this.handleAIPromptSuggestionClick(event, 'note');
    });

    stickyTemplateButtons?.addEventListener('click', (event) => {
      this.handleAIPromptSuggestionClick(event, 'note');
    });

    document.querySelectorAll('.ai-extract-insights-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'extract-insights') {
          this.extractInsightsFromChat();
        }
      });
    });

    // Open settings from sidebar
    settingsBtn?.addEventListener('click', async () => {
      if (this.onOpenSettingsModal) await this.onOpenSettingsModal();
    });

    // Clear note chat button
    const clearNoteBtn = document.getElementById('ai-chat-clear');
    clearNoteBtn?.addEventListener('click', () => {
      this.clearNoteChat();
    });

    // Setup sidebar resize
    this.setupAISidebarResize();

    // Setup Global Chat
    this.setupGlobalChat();

    // Setup LLM settings
    this.setupLLMSettings();
    this.setupAIPromptTemplateSettings();
    this.renderAIPromptSuggestions();

    // Update visibility based on LLM configuration
    this.updateAISidebarState();

    // Setup accessibility: screen reader announcements, Escape key, focus management
    this._setupAccessibility();
  }

  // ─── Tab switching ───

  switchAITab(tab) {
    const tabNote = document.getElementById('ai-tab-note');
    const tabAll = document.getElementById('ai-tab-all');
    const panelNote = document.getElementById('ai-panel-note');
    const panelAll = document.getElementById('ai-panel-all');

    this.aiActiveTab = tab;
    if (tab === 'note') {
      tabNote?.classList.add('active');
      tabAll?.classList.remove('active');
      panelNote?.classList.add('active');
      panelAll?.classList.remove('active');
      document.getElementById('ai-chat-input')?.focus();
    } else if (tab === 'all') {
      tabNote?.classList.remove('active');
      tabAll?.classList.add('active');
      const tabSmart = document.getElementById('ai-tab-smart');
      tabSmart?.classList.remove('active');
      panelNote?.classList.remove('active');
      panelAll?.classList.add('active');
      const panelSmart = document.getElementById('ai-panel-smart');
      panelSmart?.classList.remove('active');
      document.getElementById('global-chat-input')?.focus();
    } else if (tab === 'smart') {
      tabNote?.classList.remove('active');
      tabAll?.classList.remove('active');
      const tabSmart = document.getElementById('ai-tab-smart');
      tabSmart?.classList.add('active');
      panelNote?.classList.remove('active');
      panelAll?.classList.remove('active');
      const panelSmart = document.getElementById('ai-panel-smart');
      panelSmart?.classList.add('active');

      this.updateSmartSuggestions(true);
    }
  }

  // ─── Sidebar resize ───

  setupAISidebarResize() {
    const sidebar = document.getElementById('ai-sidebar');
    const resizeHandle = document.getElementById('ai-sidebar-resize-handle');

    if (this.aiSidebarResizer) {
      this.aiSidebarResizer.destroy();
    }

    if (!sidebar || !resizeHandle) return;

    this.aiSidebarResizer = new ResizablePanel({
      panel: sidebar,
      handle: resizeHandle,
      min: 280,
      max: 600,
      direction: 'left',
      onResizeEnd: async (width) => {
        this.aiSidebarWidth = width;
        await this.storage.setSetting('aiSidebarWidth', this.aiSidebarWidth);
      },
    });
  }

  // ─── Toggle / Open / Close ───

  toggleAISidebar() {
    if (this.aiSidebarOpen) {
      this.closeAISidebar();
    } else {
      this.openAISidebar();
    }
  }

  openAISidebar() {
    const sidebar = document.getElementById('ai-sidebar');
    const floatingBtn = document.getElementById('ai-floating-btn');

    if (sidebar) {
      sidebar.classList.remove('hidden');
      sidebar.style.width = this.aiSidebarWidth + 'px';
    }

    if (floatingBtn) {
      floatingBtn.classList.add('hidden');
    }

    this.aiSidebarOpen = true;
    this.updateAISidebarState();

    // Lazy-load AI embedding model on first AI sidebar open (Req 27.3)
    if (this.onLoadEmbeddingsModel) {
      this.onLoadEmbeddingsModel();
    }

    setTimeout(() => {
      document.getElementById('ai-chat-input')?.focus();
    }, 100);
  }

  closeAISidebar() {
    const sidebar = document.getElementById('ai-sidebar');
    const floatingBtn = document.getElementById('ai-floating-btn');

    if (sidebar) {
      sidebar.classList.add('hidden');
    }

    if (floatingBtn) {
      floatingBtn.classList.remove('hidden');
    }

    this.aiSidebarOpen = false;
  }

  // ─── Chat history persistence ───

  async loadChatHistory() {
    this.aiChatHistory = await this.storage.getSetting('aiChatHistory', []);
    this.noteChatMessages = await this.storage.getSetting('noteChatMessages', []);
    this.globalChatHistory = await this.storage.getSetting('globalChatHistory', []);
    this.globalChatMessages = await this.storage.getSetting('globalChatMessages', []);

    // Cache display name for synchronous use in addChatMessage
    this._cachedDisplayName = await this.storage.getSetting('displayName', 'U');

    // Restore note chat UI
    if (this.noteChatMessages.length > 0) {
      const messagesContainer = document.getElementById('ai-chat-messages');
      const welcome = messagesContainer?.querySelector('.ai-chat-welcome');
      const stickySuggestions = document.getElementById('ai-sticky-suggestions');

      if (welcome) welcome.style.display = 'none';
      if (stickySuggestions) stickySuggestions.classList.remove('hidden');

      this.noteChatMessages.forEach(msg => {
        this.addChatMessage(msg.content, msg.type, false, msg.timestamp || null);
      });
    }

    // Restore global chat UI
    if (this.globalChatMessages.length > 0) {
      const messagesContainer = document.getElementById('global-chat-messages');
      const welcome = messagesContainer?.querySelector('.global-chat-welcome');

      if (welcome) welcome.style.display = 'none';

      this.globalChatMessages.forEach(msg => {
        this.addGlobalChatMessage(msg.content, msg.type, msg.sourceNotes, false);
      });
    }
  }

  async saveNoteChatHistory() {
    await this.storage.setSetting('aiChatHistory', this.aiChatHistory);
    await this.storage.setSetting('noteChatMessages', this.noteChatMessages);
  }

  async saveGlobalChatHistory() {
    await this.storage.setSetting('globalChatHistory', this.globalChatHistory);
    await this.storage.setSetting('globalChatMessages', this.globalChatMessages);
  }

  // ─── Clear chat ───

  async clearNoteChat() {
    this.aiChatHistory = [];
    this.noteChatMessages = [];
    await this.saveNoteChatHistory();

    const messagesContainer = document.getElementById('ai-chat-messages');
    if (messagesContainer) {
      const messages = messagesContainer.querySelectorAll('.ai-chat-message');
      messages.forEach(msg => msg.remove());
      const welcome = messagesContainer.querySelector('.ai-chat-welcome');
      if (welcome) welcome.style.display = '';
    }

    const stickySuggestions = document.getElementById('ai-sticky-suggestions');
    if (stickySuggestions) stickySuggestions.classList.add('hidden');

    const input = document.getElementById('ai-chat-input');
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }

    Utils.showToast('Chat cleared', 'success');
  }

  async clearGlobalChat() {
    this.globalChatHistory = [];
    this.globalChatMessages = [];
    await this.saveGlobalChatHistory();

    const messagesContainer = document.getElementById('global-chat-messages');
    if (messagesContainer) {
      const messages = messagesContainer.querySelectorAll('.ai-chat-message');
      messages.forEach(msg => msg.remove());
      const welcome = messagesContainer.querySelector('.global-chat-welcome');
      if (welcome) welcome.style.display = '';
    }

    const input = document.getElementById('global-chat-input');
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }

    Utils.showToast('Chat cleared', 'success');
  }

  // ─── AI sidebar state ───

  updateAISidebarState() {
    const notConfigured = document.getElementById('ai-not-configured-sidebar');
    const chatMessages = document.getElementById('ai-chat-messages');
    const chatInputArea = document.querySelector('.ai-chat-input-area');

    const isConfigured = this.llm.isConfigured();

    if (notConfigured) notConfigured.classList.toggle('hidden', isConfigured);
    if (chatMessages) chatMessages.style.display = isConfigured ? 'flex' : 'none';
    if (chatInputArea) chatInputArea.style.display = isConfigured ? 'flex' : 'none';
  }

  // ─── Send note chat message ───

  async sendAIChatMessage() {
    const input = document.getElementById('ai-chat-input');
    const message = input?.value.trim();

    if (!message) return;

    input.value = '';
    input.style.height = 'auto';

    const welcome = document.querySelector('.ai-chat-welcome');
    const stickySuggestions = document.getElementById('ai-sticky-suggestions');
    if (welcome) welcome.style.display = 'none';
    if (stickySuggestions) stickySuggestions.classList.remove('hidden');

    this.addChatMessage(message, 'user');

    // Build context-windowed note content
    const editor = this.getEditor ? this.getEditor() : null;
    const blocks = (editor && editor.blocks) ? editor.blocks : [];
    const cursorIndex = (editor && editor.activeBlock)
      ? blocks.findIndex(b => b.id === editor.activeBlock)
      : -1;

    let noteContent;
    let contextResult;

    if (blocks.length > 0) {
      contextResult = this.buildContextWindow(blocks, cursorIndex);
      noteContent = contextResult.content;
    } else {
      noteContent = this.getNoteContent();
      contextResult = null;
    }

    // Show context indicator when windowing is active
    if (contextResult && contextResult.isWindowed) {
      this.showContextIndicator(contextResult.percentage);
    } else {
      this.hideContextIndicator();
    }

    const sendBtn = document.getElementById('ai-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    const systemPrompt = `You are a helpful AI assistant. The user is working on a note with the following content:

---
${noteContent || '(Empty note)'}
---

Help the user with their request about this note. You can:
- Summarize the note
- Expand on topics
- Generate titles
- Answer questions about the content
- Suggest improvements
- Generate related questions
- And more

Be concise but helpful. If the user asks to generate a title, respond with ONLY the title text.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.aiChatHistory,
      { role: 'user', content: message }
    ];

    const messagesContainer = document.getElementById('ai-chat-messages');

    const result = await this._streamResponse(messagesContainer, messages, () => {
      if (sendBtn) sendBtn.disabled = false;
      // Req 12.5: Return focus to chat input after response completes
      document.getElementById('ai-chat-input')?.focus();
    });

    if (result) {
      this.aiChatHistory.push({ role: 'user', content: message });
      this.aiChatHistory.push({ role: 'assistant', content: result });

      if (this.aiChatHistory.length > 20) {
        this.aiChatHistory = this.aiChatHistory.slice(-20);
      }

      if (message.toLowerCase().includes('title') && message.toLowerCase().includes('generate')) {
        this.handleGeneratedTitle(result);
      }
    }
  }

  // ─── Streaming response helper ───

  /**
   * Stream an LLM response into a chat container with real-time token display,
   * Stop button, error handling with Retry, and finalization with markdown + actions.
   * @param {HTMLElement} container - The messages container element
   * @param {Array<{role: string, content: string}>} messages - Chat messages to send
   * @param {Function} onDone - Callback when streaming finishes (success or failure)
   * @param {Object} [opts] - Options
   * @param {Array|null} [opts.sourceNotes] - Source notes for global chat messages
   * @param {'note'|'global'} [opts.scope] - Chat scope for persistence
   * @returns {Promise<string|null>} The full response text, or null on failure/abort
   */
  async _streamResponse(container, messages, onDone, opts = {}) {
    const { sourceNotes = null, scope = 'note' } = opts;

    const { createSkeletonLoader, createThinkingTicker, createTimelineRail, createToolCard, createScrollFAB } = window.ChatUIComponents || {};

    // Phase 1: Show skeleton loader while waiting for first token
    let skeleton = null;
    if (createSkeletonLoader) {
      skeleton = createSkeletonLoader('message');
      container.appendChild(skeleton.el);
      container.scrollTop = container.scrollHeight;
    }

    // Phase 1b: Set up scroll state machine and FAB for sticky scroll behavior
    let scrollStateMachine = null;
    let scrollFAB = null;
    if (window.ScrollStateMachine && createScrollFAB) {
      scrollFAB = createScrollFAB({
        onClick: () => {
          if (scrollStateMachine) scrollStateMachine.scrollToBottom();
        }
      });
      scrollStateMachine = new window.ScrollStateMachine(container, {
        onNewContentCount: (count) => {
          if (scrollFAB) scrollFAB.setBadge(count);
        }
      });
      container.appendChild(scrollFAB.el);

      // Poll scroll state to show/hide FAB
      const _scrollFABHandler = () => {
        if (!scrollStateMachine || !scrollFAB) return;
        if (scrollStateMachine.state === 'free') {
          scrollFAB.show();
        } else {
          scrollFAB.hide();
        }
      };
      container.addEventListener('scroll', _scrollFABHandler, { passive: true });
      // Store handler reference for cleanup
      scrollFAB._scrollHandler = _scrollFABHandler;
      scrollFAB._container = container;
    }

    // Deferred message element — created on first token
    let messageEl = null;
    let contentEl = null;
    let stableZone = null;
    let activeZone = null;
    let stopBtn = null;
    let renderer = null;
    let thinkingTicker = null;
    let firstTokenReceived = false;
    let aborted = false;

    // Timeline and tool call state (activates when LLM yields tool call objects)
    let timelineRail = null;
    let toolCards = {};        // Map of toolCallId → { card, stepId }
    let toolStepCounter = 0;
    let contentStepId = null;  // ID of the content step in the timeline
    let hadThinking = false;   // Track if thinking phase occurred

    // parseBlock: convert a completed markdown block to sanitized HTML
    const parseBlock = (markdown) => {
      return sanitizeHtml(Utils.parseMarkdown(markdown));
    };

    /**
     * Remove skeleton loader and set up the streaming message element.
     * Called on first token arrival.
     */
    const initMessageElement = () => {
      // Remove skeleton with crossfade
      if (skeleton) {
        skeleton.destroy();
        skeleton = null;
      }

      messageEl = document.createElement('div');
      messageEl.className = 'ai-chat-message assistant';
      messageEl.style.animation = 'crossfade-in var(--duration-normal) ease both';

      contentEl = document.createElement('div');
      contentEl.className = 'ai-message-content ai-streaming';

      stableZone = document.createElement('div');
      stableZone.className = 'stable-zone';

      activeZone = document.createElement('div');
      activeZone.className = 'active-zone';

      contentEl.appendChild(stableZone);
      contentEl.appendChild(activeZone);
      messageEl.appendChild(contentEl);

      // Stop button
      stopBtn = document.createElement('button');
      stopBtn.className = 'ai-message-action-btn ai-stop-btn';
      stopBtn.title = 'Stop generating';
      stopBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="6" y="6" width="12" height="12" rx="2"></rect>
      </svg> Stop`;
      stopBtn.addEventListener('click', () => {
        aborted = true;
        if (renderer) renderer.abort();
        if (thinkingTicker) { thinkingTicker.destroy(); thinkingTicker = null; }
        // Clean up tool skeletons on abort
        for (const id in toolCards) {
          const entry = toolCards[id];
          if (entry && entry.skeleton) { entry.skeleton.destroy(); entry.skeleton = null; }
        }
        this.llm.abortStream();
      });
      messageEl.appendChild(stopBtn);

      container.appendChild(messageEl);
      container.scrollTop = container.scrollHeight;

      renderer = new StreamRenderer({
        stableZone,
        activeZone,
        parseBlock,
        onContentGrowth: () => {
          if (scrollStateMachine) {
            scrollStateMachine.notifyContentGrowth();
          } else {
            container.scrollTop = container.scrollHeight;
          }
        },
      });
    };

    /**
     * Determine if a token looks like a thinking/reasoning token.
     * The LLM service currently yields only plain strings, so we check
     * for object tokens with a thinking property (future-proofing for
     * providers that expose reasoning traces).
     */
    const isThinkingToken = (token) => {
      return token && typeof token === 'object' && (token.type === 'thinking' || token.thinking === true);
    };

    /**
     * Extract text content from a token (handles both string and object tokens).
     */
    const getTokenText = (token) => {
      if (typeof token === 'string') return token;
      if (token && typeof token === 'object') return token.text || token.content || '';
      return '';
    };

    /**
     * Determine if a token is a tool call event.
     * Tool call tokens are objects with type 'tool_call', 'tool_input', 'tool_output', or 'tool_error'.
     */
    const isToolCallToken = (token) => {
      if (!token || typeof token !== 'object') return false;
      return token.type === 'tool_call' || token.type === 'tool_input' ||
             token.type === 'tool_output' || token.type === 'tool_error';
    };

    /**
     * Ensure the TimelineRail exists. On first call, creates the rail and
     * retroactively adds thinking and content steps for phases already in progress.
     */
    const ensureTimeline = () => {
      if (timelineRail || !createTimelineRail) return;

      timelineRail = createTimelineRail();

      // Retroactively add thinking step if thinking occurred
      if (hadThinking) {
        const thinkStepContent = timelineRail.addStep('thinking', 'Thinking', 'thinking');
        timelineRail.setStepStatus('thinking', 'complete');
        // Move the collapsed thinking ticker into the timeline step
        const existingTicker = messageEl ? messageEl.querySelector('.thinking-ticker') : null;
        if (existingTicker) {
          thinkStepContent.appendChild(existingTicker);
        }
      }

      // Retroactively add content step if content rendering is in progress
      if (renderer && contentEl) {
        contentStepId = 'content-0';
        const contentStepContent = timelineRail.addStep(contentStepId, 'Response', 'answer');
        timelineRail.setStepStatus(contentStepId, 'running');
        // Move stable and active zones into the timeline content step
        contentStepContent.appendChild(stableZone);
        contentStepContent.appendChild(activeZone);
      }

      // Insert timeline into the message element
      if (messageEl) {
        // Insert timeline before contentEl (or at the start if no contentEl yet)
        if (contentEl && contentEl.parentNode === messageEl) {
          messageEl.insertBefore(timelineRail.el, contentEl);
          // Remove the now-empty contentEl wrapper since zones moved into timeline
          contentEl.remove();
        } else {
          messageEl.insertBefore(timelineRail.el, messageEl.firstChild);
        }
      }
    };

    /**
     * Handle a tool call event token by creating a ToolCard and timeline step.
     */
    const handleToolCall = (token) => {
      if (!createToolCard) return;

      // Ensure message element exists
      if (!messageEl) {
        initMessageElement();
      }

      ensureTimeline();

      const toolCallId = token.toolCallId || token.id || ('tool-' + toolStepCounter);
      const stepId = 'tool-' + toolStepCounter++;

      const card = createToolCard({
        toolName: token.toolName || token.name || 'Tool',
        toolType: token.toolType || 'default',
        onRetry: token.onRetry || null,
      });

      const stepContent = timelineRail.addStep(stepId, token.toolName || token.name || 'Tool', 'tool');
      timelineRail.setStepStatus(stepId, 'running');

      // Show tool skeleton until input arrives
      if (createSkeletonLoader) {
        const toolSkeleton = createSkeletonLoader('tool');
        stepContent.appendChild(toolSkeleton.el);
        toolCards[toolCallId] = { card, stepId, skeleton: toolSkeleton };
      } else {
        toolCards[toolCallId] = { card, stepId, skeleton: null };
      }

      card.setProgress(true);
      stepContent.appendChild(card.el);
    };

    /**
     * Handle tool input data arriving for an existing tool call.
     */
    const handleToolInput = (token) => {
      const toolCallId = token.toolCallId || token.id;
      const entry = toolCards[toolCallId];
      if (!entry) return;

      // Remove tool skeleton
      if (entry.skeleton) {
        entry.skeleton.destroy();
        entry.skeleton = null;
      }

      entry.card.setInput(typeof token.data === 'string' ? token.data : JSON.stringify(token.data, null, 2));
    };

    /**
     * Handle tool call completion.
     */
    const handleToolOutput = (token) => {
      const toolCallId = token.toolCallId || token.id;
      const entry = toolCards[toolCallId];
      if (!entry) return;

      // Remove tool skeleton if still present
      if (entry.skeleton) {
        entry.skeleton.destroy();
        entry.skeleton = null;
      }

      entry.card.setProgress(false);
      entry.card.setOutput(typeof token.data === 'string' ? token.data : JSON.stringify(token.data, null, 2));
      if (timelineRail) {
        timelineRail.setStepStatus(entry.stepId, 'complete');
      }
    };

    /**
     * Handle tool call error.
     */
    const handleToolError = (token) => {
      const toolCallId = token.toolCallId || token.id;
      const entry = toolCards[toolCallId];
      if (!entry) return;

      // Remove tool skeleton if still present
      if (entry.skeleton) {
        entry.skeleton.destroy();
        entry.skeleton = null;
      }

      entry.card.setProgress(false);
      entry.card.setError(token.message || token.error || 'Tool call failed');
      if (timelineRail) {
        timelineRail.setStepStatus(entry.stepId, 'error');
      }
    };

    try {
      for await (const token of this.llm.chatStream(messages)) {
        if (aborted) break;

        // ── Tool call event handling (objects with type tool_call/tool_input/tool_output/tool_error) ──
        if (isToolCallToken(token)) {
          switch (token.type) {
            case 'tool_call':
              handleToolCall(token);
              break;
            case 'tool_input':
              handleToolInput(token);
              break;
            case 'tool_output':
              handleToolOutput(token);
              break;
            case 'tool_error':
              handleToolError(token);
              break;
          }
          continue;
        }

        if (!firstTokenReceived) {
          firstTokenReceived = true;

          if (isThinkingToken(token)) {
            // Thinking token: remove skeleton, show ThinkingTicker
            if (skeleton) { skeleton.destroy(); skeleton = null; }
            hadThinking = true;

            if (createThinkingTicker) {
              thinkingTicker = createThinkingTicker({
                onCollapse: () => {
                  // Crossfade transition when thinking collapses
                  if (contentEl) {
                    contentEl.style.animation = 'crossfade-in var(--duration-normal) ease both';
                  }
                },
              });
              thinkingTicker.el.style.animation = 'crossfade-in var(--duration-normal) ease both';
              container.appendChild(thinkingTicker.el);
              container.scrollTop = container.scrollHeight;
            }

            const text = getTokenText(token);
            if (text && thinkingTicker) {
              thinkingTicker.addSentence(text);
            }
            continue;
          }

          // Content token (non-thinking): init message element, push token
          initMessageElement();
          renderer.push(getTokenText(token));
          continue;
        }

        // Subsequent tokens
        if (thinkingTicker && !renderer) {
          if (isThinkingToken(token)) {
            // More thinking tokens — feed to ticker
            const text = getTokenText(token);
            if (text) thinkingTicker.addSentence(text);
            continue;
          }

          // First content token after thinking: collapse ticker, init message element
          thinkingTicker.collapse();
          hadThinking = true;
          // Move ticker inside the message element after creating it
          initMessageElement();
          messageEl.insertBefore(thinkingTicker.el, contentEl);
          thinkingTicker = null; // Ownership transferred to messageEl

          renderer.push(getTokenText(token));
          continue;
        }

        // Normal content token — push to renderer
        if (renderer) {
          renderer.push(getTokenText(token));
          // Req 12.2: Accumulate content for batched screen reader announcement
          this._announceToScreenReader(getTokenText(token));
        }
      }
    } catch (error) {
      if (aborted || error.name === 'AbortError') {
        // User clicked Stop — renderer.abort() already called above
      } else {
        console.error('AI stream error:', error);
        // Clean up skeleton/ticker if error before first token
        if (skeleton) { skeleton.destroy(); skeleton = null; }
        if (thinkingTicker) { thinkingTicker.destroy(); thinkingTicker = null; }

        // Mark any running tool steps as error
        if (timelineRail) {
          for (const id in toolCards) {
            const entry = toolCards[id];
            if (entry.skeleton) { entry.skeleton.destroy(); entry.skeleton = null; }
          }
        }

        // Ensure message element exists for error display
        if (!messageEl) {
          initMessageElement();
        }
        if (renderer) {
          renderer.abort();
        }

        // Track consecutive errors (Req 11.6)
        this._trackError();

        // Detect error type and show appropriate UI
        const errorMsg = error.message || 'Unknown error';
        const isRateLimit = /429|rate.?limit/i.test(errorMsg);
        const isConnectionLost = /failed to fetch|network|ERR_INTERNET|ECONNREFUSED|ENOTFOUND|timeout/i.test(errorMsg)
          && firstTokenReceived;

        if (isRateLimit) {
          // Req 11.3: Rate limit toast with countdown
          const retryAfter = this._parseRetryAfter(errorMsg);
          this._showRateLimitToast(container, retryAfter);
          this._addStreamError(messageEl, contentEl, errorMsg, messages, container, onDone, opts);
        } else if (isConnectionLost) {
          // Req 11.4: Connection lost banner
          this._showConnectionLostBanner(container, messages, onDone, opts);
          this._addStreamError(messageEl, contentEl, errorMsg, messages, container, onDone, opts);
        } else {
          // Req 11.1: Generic inline error with retry
          this._addStreamError(messageEl, contentEl, errorMsg, messages, container, onDone, opts);
        }

        // Req 11.6: Check for consecutive errors
        this._checkConsecutiveErrors(container);

        // Clean up scroll state machine and FAB on error
        if (scrollStateMachine) { scrollStateMachine.destroy(); scrollStateMachine = null; }
        if (scrollFAB) {
          if (scrollFAB._scrollHandler && scrollFAB._container) {
            scrollFAB._container.removeEventListener('scroll', scrollFAB._scrollHandler);
          }
          scrollFAB.destroy(); scrollFAB = null;
        }
        onDone();
        return null;
      }
    }

    // Clean up skeleton if stream ended with no tokens
    if (skeleton) { skeleton.destroy(); skeleton = null; }

    // If no tokens were received at all, create the message element for finalization
    if (!messageEl) {
      initMessageElement();
    }

    // Finish streaming — flush remaining buffer to stable zone
    if (renderer && !aborted) {
      renderer.finish();
      // Req 12.2: Final screen reader announcement for completed response
      this._announceToScreenReader(renderer.stableContent, true);
    }

    // Mark content step as complete in timeline
    if (timelineRail && contentStepId) {
      timelineRail.setStepStatus(contentStepId, 'complete');
    }

    // Remove stop button
    if (stopBtn) stopBtn.remove();

    // Destroy scroll state machine and FAB now that streaming is done
    if (scrollStateMachine) {
      scrollStateMachine.destroy();
      scrollStateMachine = null;
    }
    if (scrollFAB) {
      if (scrollFAB._scrollHandler && scrollFAB._container) {
        scrollFAB._container.removeEventListener('scroll', scrollFAB._scrollHandler);
      }
      scrollFAB.destroy();
      scrollFAB = null;
    }

    // Use stableContent for history persistence (full markdown of all blocks)
    const fullResponse = renderer ? renderer.stableContent : '';
    if (renderer) renderer.destroy();

    // When timeline is active, create a new contentEl inside the timeline's content step
    // so _finalizeStreamedMessage can write the final parsed HTML there
    if (timelineRail && contentStepId) {
      const stepContent = timelineRail.getStepContent(contentStepId);
      if (stepContent) {
        stepContent.innerHTML = '';
        contentEl = document.createElement('div');
        contentEl.className = 'ai-message-content';
        stepContent.appendChild(contentEl);
      }
    }

    // Finalize: parse markdown, add action buttons
    this._finalizeStreamedMessage(messageEl, contentEl, fullResponse, sourceNotes, scope);

    // Req 11.5: Detect potentially incomplete responses (stream ended without proper completion)
    if (fullResponse && !aborted && this._looksIncomplete(fullResponse)) {
      this._showIncompleteResponse(messageEl, fullResponse, messages, container, onDone, opts);
    }

    onDone();
    return fullResponse;
  }

  /**
   * Add error indicator and Retry button to a streamed message that failed mid-stream.
   * @param {HTMLElement} messageEl - The message wrapper element
   * @param {HTMLElement} contentEl - The content element with partial text
   * @param {string} errorMsg - The error message
   * @param {Array} messages - Original messages for retry
   * @param {HTMLElement} container - The messages container
   * @param {Function} onDone - Callback for when retry completes
   * @param {Object} opts - Options passed to _streamResponse
   */
  _addStreamError(messageEl, contentEl, errorMsg, messages, container, onDone, opts) {
    // Remove stop button if present
    messageEl.querySelector('.ai-stop-btn')?.remove();

    contentEl.classList.remove('ai-streaming');

    // Req 11.1: Inline error preserving partial content, with shake animation
    const errorEl = document.createElement('div');
    errorEl.className = 'error-inline';
    errorEl.setAttribute('role', 'alert');

    const msgEl = document.createElement('div');
    msgEl.className = 'error-inline-message';
    msgEl.textContent = `⚠ Error: ${errorMsg}`;
    errorEl.appendChild(msgEl);

    // Req 11.2: Retry button re-sends original request
    const retryBtn = document.createElement('button');
    retryBtn.className = 'retry-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.setAttribute('aria-label', 'Retry sending message');
    retryBtn.addEventListener('click', async () => {
      messageEl.remove();
      await this._streamResponse(container, messages, onDone, opts);
    });
    errorEl.appendChild(retryBtn);

    messageEl.appendChild(errorEl);
  }

  /**
   * Req 11.3: Show rate limit toast with countdown timer.
   * @param {HTMLElement} container - Chat container
   * @param {number} retryAfterSec - Seconds until retry is allowed
   */
  _showRateLimitToast(container, retryAfterSec) {
    // Remove any existing toast
    container.querySelector('.error-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.setAttribute('role', 'alert');

    toast.innerHTML = `<span class="error-toast-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>` +
      `<span>Rate limited — retry in <span class="error-toast-countdown">${retryAfterSec}s</span></span>`;

    container.appendChild(toast);

    let remaining = retryAfterSec;
    const countdownEl = toast.querySelector('.error-toast-countdown');
    const interval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
        toast.classList.add('dismissing');
        setTimeout(() => toast.remove(), 300);
      } else {
        countdownEl.textContent = `${remaining}s`;
      }
    }, 1000);
  }

  /**
   * Req 11.4: Show connection lost banner at top of chat container.
   * @param {HTMLElement} container - Chat container
   * @param {Array} messages - Original messages for reconnect/retry
   * @param {Function} onDone - Callback
   * @param {Object} opts - Options
   */
  _showConnectionLostBanner(container, messages, onDone, opts) {
    // Remove any existing banner
    container.querySelector('.error-banner')?.remove();

    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.setAttribute('role', 'alert');

    banner.innerHTML = `<div class="error-banner-message">` +
      `<span class="error-banner-icon"><svg viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg></span>` +
      `Connection lost</div>`;

    const reconnectBtn = document.createElement('button');
    reconnectBtn.className = 'reconnect-btn';
    reconnectBtn.textContent = 'Reconnect';
    reconnectBtn.setAttribute('aria-label', 'Reconnect and retry');
    reconnectBtn.addEventListener('click', async () => {
      banner.remove();
      // Remove the last failed assistant message if present
      const lastMsg = container.querySelector('.ai-chat-message.assistant:last-of-type');
      if (lastMsg) lastMsg.remove();
      await this._streamResponse(container, messages, onDone, opts);
    });
    banner.appendChild(reconnectBtn);

    // Insert at top of container
    container.insertBefore(banner, container.firstChild);
  }

  /**
   * Req 11.5: Show incomplete response indicator with Continue button.
   * @param {HTMLElement} messageEl - The message element
   * @param {string} partialResponse - The partial response text
   * @param {Array} messages - Original messages
   * @param {HTMLElement} container - Chat container
   * @param {Function} onDone - Callback
   * @param {Object} opts - Options
   */
  _showIncompleteResponse(messageEl, partialResponse, messages, container, onDone, opts) {
    const indicator = document.createElement('div');
    indicator.className = 'response-incomplete';
    indicator.setAttribute('role', 'status');

    indicator.innerHTML = `<span class="response-incomplete-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>` +
      `<span>Response may be incomplete</span>`;

    const continueBtn = document.createElement('button');
    continueBtn.className = 'continue-btn';
    continueBtn.textContent = 'Continue';
    continueBtn.setAttribute('aria-label', 'Continue generating response');
    continueBtn.addEventListener('click', async () => {
      indicator.remove();
      // Build continuation messages: include partial response and ask to continue
      const continuationMessages = [
        ...messages,
        { role: 'assistant', content: partialResponse },
        { role: 'user', content: 'Please continue from where you left off.' }
      ];
      await this._streamResponse(container, continuationMessages, onDone, opts);
    });
    indicator.appendChild(continueBtn);

    messageEl.appendChild(indicator);
  }

  /**
   * Track an error timestamp for consecutive error detection (Req 11.6).
   */
  _trackError() {
    const now = Date.now();
    this._errorTimestamps.push(now);
    // Keep only errors within the last 60 seconds
    this._errorTimestamps = this._errorTimestamps.filter(t => now - t < 60000);
  }

  /**
   * Req 11.6: If 3+ consecutive errors within 60 seconds, show persistent warning.
   * @param {HTMLElement} container - Chat container
   */
  _checkConsecutiveErrors(container) {
    if (this._errorTimestamps.length < 3) return;

    // Don't show duplicate warnings
    if (container.querySelector('.error-persistent-warning')) return;

    const warning = document.createElement('div');
    warning.className = 'error-inline error-persistent-warning';
    warning.setAttribute('role', 'alert');

    const msgEl = document.createElement('div');
    msgEl.className = 'error-inline-message';
    msgEl.textContent = '⚠ Multiple errors detected. Please check your API key and provider settings.';
    warning.appendChild(msgEl);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'retry-btn';
    settingsBtn.textContent = 'Open Settings';
    settingsBtn.setAttribute('aria-label', 'Open AI provider settings');
    settingsBtn.addEventListener('click', async () => {
      if (this.onOpenSettingsModal) await this.onOpenSettingsModal();
    });
    warning.appendChild(settingsBtn);

    container.appendChild(warning);
  }

  /**
   * Parse retry-after seconds from a rate limit error message.
   * @param {string} errorMsg - Error message
   * @returns {number} Seconds to wait (default 30)
   */
  _parseRetryAfter(errorMsg) {
    const match = errorMsg.match(/(\d+)\s*s(?:ec(?:ond)?s?)?/i);
    return match ? parseInt(match[1], 10) : 30;
  }

  /**
   * Heuristic check if a response looks truncated/incomplete.
   * @param {string} text - Response text
   * @returns {boolean}
   */
  _looksIncomplete(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 20) return false;

    // Check for mid-code-block truncation (unclosed code fences)
    const fenceCount = (trimmed.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) return true;

    // Check if ends mid-sentence (no terminal punctuation or block closure)
    const lastChar = trimmed.slice(-1);
    const terminalChars = '.!?:;)]\'"}`>';
    if (!terminalChars.includes(lastChar)) return true;

    return false;
  }

  /**
   * Finalize a streamed message: parse markdown, add action buttons, persist.
   * @param {HTMLElement} messageEl - The message wrapper element
   * @param {HTMLElement} contentEl - The content element
   * @param {string} fullResponse - The complete response text
   * @param {Array|null} sourceNotes - Source notes for global chat
   * @param {'note'|'global'} scope - Chat scope
   */
  _finalizeStreamedMessage(messageEl, contentEl, fullResponse, sourceNotes, scope) {
    contentEl.classList.remove('ai-streaming');

    // Parse markdown
    contentEl.innerHTML = sanitizeHtml(Utils.parseMarkdown(fullResponse));

    // Add source notes for global chat
    if (sourceNotes && sourceNotes.length > 0) {
      const sourcesEl = this._buildSourceNotesEl(sourceNotes);
      messageEl.appendChild(sourcesEl);
    }

    // Add action buttons
    const actionsEl = this._buildMessageActions(fullResponse, scope);
    messageEl.appendChild(actionsEl);

    // Persist
    if (scope === 'global') {
      if (!this.globalChatMessages) this.globalChatMessages = [];
      this.globalChatMessages.push({ content: fullResponse, type: 'assistant', sourceNotes });
      this.saveGlobalChatHistory();
    } else {
      if (!this.noteChatMessages) this.noteChatMessages = [];
      this.noteChatMessages.push({ content: fullResponse, type: 'assistant' });
      this.saveNoteChatHistory();
    }
  }

  /**
   * Build action buttons for a finalized assistant message.
   * @param {string} content - The response text
   * @param {'note'|'global'} scope - Chat scope
   * @returns {HTMLElement}
   */
  _buildMessageActions(content, scope) {
    const actionsEl = document.createElement('div');
    actionsEl.className = 'ai-message-actions';

    if (scope === 'note') {
      // Append to note button
      const appendBtn = document.createElement('button');
      appendBtn.className = 'ai-message-action-btn';
      appendBtn.title = 'Append to current note';
      appendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14"></path>
      </svg>`;
      appendBtn.addEventListener('click', () => this.openAIInsertPreview('append', content));
      actionsEl.appendChild(appendBtn);
    }

    // Create new note button
    const newNoteBtn = document.createElement('button');
    newNoteBtn.className = 'ai-message-action-btn';
    newNoteBtn.title = 'Create new note';
    newNoteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="12" y1="18" x2="12" y2="12"></line>
      <line x1="9" y1="15" x2="15" y2="15"></line>
    </svg>`;
    newNoteBtn.addEventListener('click', () => this.openAIInsertPreview('new-note', content));
    actionsEl.appendChild(newNoteBtn);

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'ai-message-action-btn';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>`;
    copyBtn.addEventListener('click', () => this.copyAIResponse(content, copyBtn));
    actionsEl.appendChild(copyBtn);

    return actionsEl;
  }

  /**
   * Build source notes element for global chat messages.
   * @param {Array<{id: string, title: string}>} sourceNotes
   * @returns {HTMLElement}
   */
  _buildSourceNotesEl(sourceNotes) {
    const sourcesEl = document.createElement('div');
    sourcesEl.className = 'ai-message-sources';

    const titleEl = document.createElement('div');
    titleEl.className = 'ai-sources-title';
    titleEl.textContent = 'Sources used:';
    sourcesEl.appendChild(titleEl);

    const listEl = document.createElement('div');
    listEl.className = 'ai-sources-list';

    sourceNotes.forEach(note => {
      const badgeEl = document.createElement('div');
      badgeEl.className = 'ai-source-badge';
      badgeEl.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
      `;
      const badgeTitleSpan = document.createElement('span');
      badgeTitleSpan.textContent = note.title;
      badgeEl.appendChild(badgeTitleSpan);
      badgeEl.addEventListener('click', () => {
        this.closeAISidebar();
        if (this.onOpenNoteById) this.onOpenNoteById(note.id);
      });
      listEl.appendChild(badgeEl);
    });

    sourcesEl.appendChild(listEl);
    return sourcesEl;
  }

  // ─── Extract insights from chat ───

  async extractInsightsFromChat() {
    const editor = this.getEditor ? this.getEditor() : null;
    if (!editor || !editor.noteId) {
      Utils.showToast('No note selected', 'error');
      return;
    }

    if (!this.llm.isConfigured()) {
      Utils.showToast('AI not configured. Please set up in Settings.', 'error');
      return;
    }

    const welcome = document.querySelector('.ai-chat-welcome');
    const stickySuggestions = document.getElementById('ai-sticky-suggestions');
    if (welcome) welcome.style.display = 'none';
    if (stickySuggestions) stickySuggestions.classList.remove('hidden');

    this.addChatMessage('Extract insights from this note', 'user');

    const loading = document.getElementById('ai-chat-loading');
    loading?.classList.remove('hidden');

    const sendBtn = document.getElementById('ai-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const noteContent = this.getNoteContent();

      if (!noteContent || noteContent.trim().length < 20) {
        this.addChatMessage('Not enough content in this note to extract insights. Please add more content first.', 'assistant');
        return;
      }

      const insights = await this.llm.extractInsights(noteContent, editor.noteData?.name);

      if (!insights) {
        this.addChatMessage('Could not extract any insights from this note. The content may not contain actionable items, reminders, or deadlines.', 'assistant');
        return;
      }

      if (editor.noteData) {
        editor.noteData.insights = insights;
        editor.noteData.lastInsightsExtractedAt = Date.now();
        await this.storage.updateNote(editor.noteData);
        editor.renderInsights();
      }

      let response = '✅ **Insights extracted and saved to note!**\n\n';

      if (insights.tags && insights.tags.length > 0) {
        response += '**🏷️ Tags:** ' + insights.tags.join(', ') + '\n\n';
      }

      if (insights.deadlines && insights.deadlines.length > 0) {
        response += '**📅 Deadlines:**\n';
        insights.deadlines.forEach(d => {
          const dateStr = d.date ? ` (${d.date})` : '';
          response += `- ${d.text}${dateStr}\n`;
        });
        response += '\n';
      }

      if (insights.todos && insights.todos.length > 0) {
        response += '**✓ Action Items:**\n';
        insights.todos.forEach(t => response += `- ${t}\n`);
        response += '\n';
      }

      if (insights.reminders && insights.reminders.length > 0) {
        response += '**💡 Reminders:**\n';
        insights.reminders.forEach(r => response += `- ${r}\n`);
        response += '\n';
      }

      if (insights.highlights && insights.highlights.length > 0) {
        response += '**⭐ Key Points:**\n';
        insights.highlights.forEach(h => response += `- ${h}\n`);
      }

      this.addChatMessage(response.trim(), 'assistant');
      Utils.showToast('Insights extracted', 'success');

    } catch (error) {
      console.error('Extract insights error:', error);
      this.addChatMessage('Error extracting insights: ' + error.message, 'error');
    } finally {
      loading?.classList.add('hidden');
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  // ─── Global Chat (RAG) ───

  setupGlobalChat() {
    const chatInput = document.getElementById('global-chat-input');
    const sendBtn = document.getElementById('global-chat-send');
    const suggestionButtons = document.getElementById('ai-global-suggestion-buttons');

    if (!chatInput) return;

    sendBtn?.addEventListener('click', () => {
      this.sendGlobalChatMessage();
    });

    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendGlobalChatMessage();
      }
    });

    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });

    suggestionButtons?.addEventListener('click', (event) => {
      this.handleAIPromptSuggestionClick(event, 'global');
    });

    const clearGlobalBtn = document.getElementById('global-chat-clear');
    clearGlobalBtn?.addEventListener('click', () => {
      this.clearGlobalChat();
    });
  }

  async sendGlobalChatMessage() {
    const input = document.getElementById('global-chat-input');
    const message = input?.value.trim();

    if (!message) return;

    input.value = '';
    input.style.height = 'auto';

    const welcome = document.querySelector('.global-chat-welcome');
    if (welcome) welcome.style.display = 'none';

    this.addGlobalChatMessage(message, 'user');

    const loading = document.getElementById('global-chat-loading');
    const loadingText = document.getElementById('global-chat-loading-text');
    loading?.classList.remove('hidden');
    if (loadingText) loadingText.textContent = 'Analyzing query...';

    const sendBtn = document.getElementById('global-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const allNotes = await this.storage.getAllNotes();

      if (allNotes.length === 0) {
        this.addGlobalChatMessage('You don\'t have any notes yet. Create some notes first to search across them.', 'assistant');
        return;
      }

      if (loadingText) loadingText.textContent = 'Searching your notes...';

      // Sync search index data to SearchEngine before searching
      if (this.searchEngine) {
        const searchIndexData = await this.storage.getSearchIndex();
        this.searchEngine.updateIndex(searchIndexData);
      }

      const searchResults = this.searchEngine ? await this.searchEngine.search(message) : [];
      const relevantResults = searchResults.slice(0, 5).filter(r => r.score > 0.3);

      if (relevantResults.length === 0) {
        this.addGlobalChatMessage('I couldn\'t find any notes that seem relevant to your question. Try adding more detail to your query.', 'assistant');
        return;
      }

      if (loadingText) loadingText.textContent = 'Reading relevant notes...';

      const notesContent = [];
      for (const result of relevantResults) {
        const note = allNotes.find(n => n.id === result.id);
        if (note) {
          const blocks = await this.storage.getElementsByNote(note.id);
          const content = blocks
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .map(b => this.extractBlockText(b))
            .filter(t => t.trim())
            .join('\n\n');

          if (content.trim()) {
            notesContent.push({
              id: note.id,
              title: note.name || 'Untitled',
              content: content
            });
          }
        }
      }

      if (notesContent.length === 0) {
        this.addGlobalChatMessage('The relevant notes appear to be empty. Please add content to your notes first.', 'assistant');
        return;
      }

      if (loadingText) loadingText.textContent = 'Synthesizing answer...';

      // Build RAG messages for streaming
      const followUpPrompt = `Answer the user query based on the following ${notesContent.length} notes. Be thorough and mention the note titles in your explanation.`;
      const notesContext = notesContent.map(n => `## ${n.title}\n${n.content}`).join('\n\n---\n\n');
      const ragMessages = [
        { role: 'system', content: `${followUpPrompt}\n\nNotes:\n${notesContext}` },
        { role: 'user', content: message }
      ];

      loading?.classList.add('hidden');

      const messagesContainer = document.getElementById('global-chat-messages');
      const sourceNotesRef = notesContent.map(n => ({ id: n.id, title: n.title }));

      const result = await this._streamResponse(messagesContainer, ragMessages, () => {
        if (sendBtn) sendBtn.disabled = false;
        // Req 12.5: Return focus to global chat input after response completes
        document.getElementById('global-chat-input')?.focus();
      }, { sourceNotes: sourceNotesRef, scope: 'global' });

      if (!result) {
        // Stream failed or was aborted — onDone already called
        return;
      }

    } catch (error) {
      console.error('Global chat error:', error);
      this.addGlobalChatMessage('Error: ' + error.message, 'error');
      loading?.classList.add('hidden');
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  // ─── Chat message rendering ───

  addChatMessage(content, type, persist = true, timestamp = null) {
    const messagesContainer = document.getElementById('ai-chat-messages');
    if (!messagesContainer) return;

    const ts = timestamp ? new Date(timestamp) : new Date();

    if (persist) {
      if (!this.noteChatMessages) this.noteChatMessages = [];
      this.noteChatMessages.push({ content, type, timestamp: ts.toISOString() });
      this.saveNoteChatHistory();
    }

    // Use UserRequestCard for user messages when available
    const { createUserRequestCard } = window.ChatUIComponents || {};
    if (type === 'user' && createUserRequestCard) {
      const card = createUserRequestCard({
        content,
        displayName: this._cachedDisplayName || 'U',
        timestamp: ts,
      });
      messagesContainer.appendChild(card.el);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      return;
    }

    const messageEl = document.createElement('div');
    messageEl.className = `ai-chat-message ${type}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'ai-message-content';

    if (type === 'assistant') {
      contentEl.innerHTML = sanitizeHtml(Utils.parseMarkdown(content));
    } else {
      contentEl.textContent = content;
    }
    messageEl.appendChild(contentEl);

    if (type === 'assistant') {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'ai-message-actions';

      // Append to note button
      const appendBtn = document.createElement('button');
      appendBtn.className = 'ai-message-action-btn';
      appendBtn.title = 'Append to current note';
      appendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14"></path>
      </svg>`;
      appendBtn.addEventListener('click', () => this.openAIInsertPreview('append', content));
      actionsEl.appendChild(appendBtn);

      // Create new note button
      const newNoteBtn = document.createElement('button');
      newNoteBtn.className = 'ai-message-action-btn';
      newNoteBtn.title = 'Create new note';
      newNoteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="12" y1="18" x2="12" y2="12"></line>
        <line x1="9" y1="15" x2="15" y2="15"></line>
      </svg>`;
      newNoteBtn.addEventListener('click', () => this.openAIInsertPreview('new-note', content));
      actionsEl.appendChild(newNoteBtn);

      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'ai-message-action-btn';
      copyBtn.title = 'Copy to clipboard';
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>`;
      copyBtn.addEventListener('click', () => this.copyAIResponse(content, copyBtn));
      actionsEl.appendChild(copyBtn);

      messageEl.appendChild(actionsEl);
    }

    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  addGlobalChatMessage(content, type, sourceNotes = null, persist = true) {
    const messagesContainer = document.getElementById('global-chat-messages');
    if (!messagesContainer) return;

    if (persist) {
      if (!this.globalChatMessages) this.globalChatMessages = [];
      this.globalChatMessages.push({ content, type, sourceNotes });
      this.saveGlobalChatHistory();
    }

    const messageEl = document.createElement('div');
    messageEl.className = `ai-chat-message ${type}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'ai-message-content';

    if (type === 'assistant') {
      contentEl.innerHTML = sanitizeHtml(Utils.parseMarkdown(content));
    } else {
      contentEl.textContent = content;
    }
    messageEl.appendChild(contentEl);

    // Add source notes indicator for assistant messages
    if (type === 'assistant' && sourceNotes && sourceNotes.length > 0) {
      const sourcesEl = document.createElement('div');
      sourcesEl.className = 'ai-message-sources';

      const titleEl = document.createElement('div');
      titleEl.className = 'ai-sources-title';
      titleEl.textContent = 'Sources used:';
      sourcesEl.appendChild(titleEl);

      const listEl = document.createElement('div');
      listEl.className = 'ai-sources-list';

      sourceNotes.forEach(note => {
        const badgeEl = document.createElement('div');
        badgeEl.className = 'ai-source-badge';
        badgeEl.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        `;
        const badgeTitleSpan = document.createElement('span');
        badgeTitleSpan.textContent = note.title;
        badgeEl.appendChild(badgeTitleSpan);
        badgeEl.addEventListener('click', () => {
          this.closeAISidebar();
          if (this.onOpenNoteById) this.onOpenNoteById(note.id);
        });
        listEl.appendChild(badgeEl);
      });

      sourcesEl.appendChild(listEl);
      messageEl.appendChild(sourcesEl);
    }

    // Add action buttons for assistant messages
    if (type === 'assistant') {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'ai-message-actions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'ai-message-action-btn';
      copyBtn.title = 'Copy to clipboard';
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>`;
      copyBtn.addEventListener('click', () => this.copyAIResponse(content, copyBtn));
      actionsEl.appendChild(copyBtn);

      const newNoteBtn = document.createElement('button');
      newNoteBtn.className = 'ai-message-action-btn';
      newNoteBtn.title = 'Create new note from this';
      newNoteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="12" y1="18" x2="12" y2="12"></line>
        <line x1="9" y1="15" x2="15" y2="15"></line>
      </svg>`;
      newNoteBtn.addEventListener('click', () => this.openAIInsertPreview('new-note', content));
      actionsEl.appendChild(newNoteBtn);

      messageEl.appendChild(actionsEl);
    }

    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // ─── AI response actions ───

  async copyAIResponse(content, button) {
    try {
      await navigator.clipboard.writeText(content);

      const originalHTML = button.innerHTML;
      button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>`;
      button.classList.add('copied');

      setTimeout(() => {
        button.innerHTML = originalHTML;
        button.classList.remove('copied');
      }, 2000);

    } catch (error) {
      console.error('Failed to copy:', error);
      Utils.showToast('Failed to copy', 'error');
    }
  }

  async handleGeneratedTitle(response) {
    let title = response.split('\n')[0].trim();
    title = title.replace(/^["']|["']$/g, '').trim();

    if (title && title.length < 100) {
      const apply = await confirmDialog({ title: 'Apply Title', message: `Apply this title to your note?\n\n"${title}"` });
      if (apply) {
        this.applyGeneratedTitle(title);
      }
    }
  }

  async applyGeneratedTitle(title) {
    const editor = this.getEditor ? this.getEditor() : null;
    if (!editor || !editor.noteId) return;

    try {
      const note = await this.storage.getNote(editor.noteId);
      if (note) {
        note.name = title;
        note.lastAutoTitleAt = Date.now();
        await this.storage.updateNote(note);

        editor.setTitleProgrammatically(title);

        const openTabs = this.onGetOpenTabs ? this.onGetOpenTabs() : [];
        const tabIndex = openTabs.findIndex(t => t.noteId === editor.noteId);
        if (tabIndex !== -1) {
          openTabs[tabIndex].name = title;
          if (this.onRenderTabs) this.onRenderTabs();
          if (this.onSaveTabs) await this.onSaveTabs();
        }

        if (this.onRenderNotesList) await this.onRenderNotesList();
        Utils.showToast('Title updated', 'success');
      }
    } catch (error) {
      console.error('Failed to apply title:', error);
      Utils.showToast('Failed to apply title', 'error');
    }
  }

  clearAIChatHistory() {
    this.aiChatHistory = [];
    const messagesContainer = document.getElementById('ai-chat-messages');
    const stickySuggestions = document.getElementById('ai-sticky-suggestions');

    if (messagesContainer) {
      const welcome = messagesContainer.querySelector('.ai-chat-welcome');
      messagesContainer.innerHTML = '';
      if (welcome) {
        welcome.style.display = 'block';
        messagesContainer.appendChild(welcome);
      }
    }

    if (stickySuggestions) {
      stickySuggestions.classList.add('hidden');
    }
  }

  // ─── Insert preview ───

  setupAIInsertPreview() {
    const modal = document.getElementById('ai-insert-preview-modal');
    const closeBtn = document.getElementById('ai-insert-preview-close');
    const cancelBtn = document.getElementById('ai-insert-preview-cancel');
    const confirmBtn = document.getElementById('ai-insert-preview-confirm');

    if (!modal) return;

    closeBtn?.addEventListener('click', () => {
      this.closeAIInsertPreview();
    });

    cancelBtn?.addEventListener('click', () => {
      this.closeAIInsertPreview();
    });

    confirmBtn?.addEventListener('click', async () => {
      await this.confirmAIInsertPreview();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeAIInsertPreview();
      }
    });
  }

  closeAIInsertPreview() {
    const modal = document.getElementById('ai-insert-preview-modal');
    if (modal) modal.classList.add('hidden');
    this.aiInsertPreviewState = null;
  }

  buildAIInsertBlocks(content) {
    if (typeof AIResponseUtils === 'undefined') {
      return [{ type: 'text', content }];
    }
    return AIResponseUtils.parseAIResponseToBlocks(content);
  }

  getAIInsertPreviewData(blocks) {
    if (typeof AIResponseUtils === 'undefined') {
      return {
        totalBlocks: blocks.length,
        counts: [{ type: 'text', count: blocks.length }],
        summary: '',
        items: blocks.map(block => ({ type: block.type || 'text', content: block.content || '', checked: Boolean(block.checked) })),
      };
    }
    return AIResponseUtils.buildAIInsertPreview(blocks);
  }

  openAIInsertPreview(action, content) {
    const editor = this.getEditor ? this.getEditor() : null;
    if (action === 'append' && (!editor || !editor.noteId)) {
      Utils.showToast('No note is currently open', 'error');
      return;
    }

    const modal = document.getElementById('ai-insert-preview-modal');
    if (!modal) return;

    const blocks = this.buildAIInsertBlocks(content);
    const preview = this.getAIInsertPreviewData(blocks);

    this.aiInsertPreviewState = {
      action,
      blocks,
      content,
      preview,
    };

    this.renderAIInsertPreview();
    if (this.onCloseAllModals) this.onCloseAllModals();
    modal.classList.remove('hidden');
  }

  renderAIInsertPreview() {
    if (!this.aiInsertPreviewState) return;

    const titleEl = document.getElementById('ai-insert-preview-title');
    const summaryEl = document.getElementById('ai-insert-preview-summary');
    const countsEl = document.getElementById('ai-insert-preview-counts');
    const itemsEl = document.getElementById('ai-insert-preview-items');
    const confirmBtn = document.getElementById('ai-insert-preview-confirm');
    const { action, preview } = this.aiInsertPreviewState;

    if (titleEl) {
      titleEl.textContent = action === 'append' ? 'Preview Append to Note' : 'Preview New Note';
    }

    if (summaryEl) {
      summaryEl.textContent = preview.summary
        ? `This will insert ${preview.totalBlocks} block${preview.totalBlocks === 1 ? '' : 's'}: ${preview.summary}`
        : `This will insert ${preview.totalBlocks} block${preview.totalBlocks === 1 ? '' : 's'}.`;
    }

    if (confirmBtn) {
      confirmBtn.textContent = action === 'append' ? 'Append Blocks' : 'Create Note';
    }

    if (countsEl) {
      countsEl.innerHTML = '';
      preview.counts.forEach(entry => {
        const badge = document.createElement('span');
        badge.className = 'ai-insert-preview-count';
        badge.textContent = `${entry.count} ${entry.type}`;
        countsEl.appendChild(badge);
      });
    }

    if (itemsEl) {
      itemsEl.innerHTML = '';
      preview.items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'ai-insert-preview-item';

        const typeEl = document.createElement('div');
        typeEl.className = 'ai-insert-preview-item-type';
        typeEl.textContent = item.checked ? `${item.type} (done)` : item.type;

        const textEl = document.createElement('div');
        textEl.className = `ai-insert-preview-item-text ${item.content ? '' : 'ai-insert-preview-item-empty'}`.trim();
        textEl.textContent = item.content || 'No text preview for this block';

        row.appendChild(typeEl);
        row.appendChild(textEl);
        itemsEl.appendChild(row);
      });
    }
  }

  async confirmAIInsertPreview() {
    if (!this.aiInsertPreviewState) return;

    const { action, blocks, content } = this.aiInsertPreviewState;
    this.closeAIInsertPreview();

    if (action === 'append') {
      await this.appendAIResponseToNote(blocks);
      return;
    }

    await this.createNoteFromAIResponse(blocks, content);
  }

  // ─── Append / Create note from AI response ───

  createPersistentBlocksForNote(noteId, blocks, startOrder = 0) {
    const timestamp = Date.now();
    return blocks.map((block, index) => ({
      ...block,
      id: Utils.generateId(),
      canvasId: noteId,
      order: startOrder + index,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  async refreshNoteMetadataAfterInsert(noteId) {
    const note = await this.storage.getNote(noteId);
    if (!note) return;

    const blocks = (await this.storage.getElementsByNote(noteId))
      .sort((left, right) => (left.order || 0) - (right.order || 0));

    if (typeof SidebarUtils !== 'undefined') {
      const metadata = SidebarUtils.buildNoteSaveMetadata(blocks);
      note.preview = metadata.preview;
      note.todoProgress = metadata.todoProgress;
    }

    await this.storage.updateNote(note);

    const linkNames = Utils.extractWikiLinks(
      blocks
        .map(block => block.content || block.title || block.caption || '')
        .filter(Boolean)
        .join('\n')
    );
    await this.storage.updateNoteLinks(noteId, linkNames);

    if (this.onTriggerIndexing) this.onTriggerIndexing(noteId);
  }

  async appendAIResponseToNote(blocksOrContent) {
    const editor = this.getEditor ? this.getEditor() : null;
    if (!editor || !editor.noteId) {
      Utils.showToast('No note is currently open', 'error');
      return;
    }

    try {
      const parsedBlocks = Array.isArray(blocksOrContent)
        ? blocksOrContent
        : this.buildAIInsertBlocks(blocksOrContent);

      await editor.save();

      // Insert at cursor position if a block is focused, otherwise append at end (Req 19.3)
      let startOrder;
      if (editor.activeBlock) {
        const activeIdx = editor.blocks.findIndex(b => b.id === editor.activeBlock);
        if (activeIdx !== -1) {
          startOrder = (editor.blocks[activeIdx].order || activeIdx) + 1;
          // Shift subsequent blocks to make room
          const existingElements = await this.storage.getElementsByNote(editor.noteId);
          const toShift = existingElements.filter(el => (el.order || 0) >= startOrder);
          for (const el of toShift) {
            el.order = (el.order || 0) + parsedBlocks.length;
            await this.storage.saveElement(el);
          }
        } else {
          startOrder = await editor.getNextBlockOrder();
        }
      } else {
        startOrder = await editor.getNextBlockOrder();
      }

      const elements = this.createPersistentBlocksForNote(editor.noteId, parsedBlocks, startOrder);

      await this.storage.saveElements(elements);
      await this.refreshNoteMetadataAfterInsert(editor.noteId);
      await editor.loadNote(editor.noteId);
      if (this.onRefreshNotesList) await this.onRefreshNotesList();

      Utils.showToast(`Added ${elements.length} AI block${elements.length === 1 ? '' : 's'} to note`, 'success');
    } catch (error) {
      console.error('Failed to append content:', error);
      Utils.showToast('Failed to add content', 'error');
    }
  }

  async createNoteFromAIResponse(blocksOrContent, rawContent = '') {
    try {
      const parsedBlocks = Array.isArray(blocksOrContent)
        ? blocksOrContent
        : this.buildAIInsertBlocks(blocksOrContent);
      const note = await this.storage.createNote('AI Generated');
      const elements = this.createPersistentBlocksForNote(note.id, parsedBlocks, 0);

      await this.storage.saveElements(elements);
      await this.refreshNoteMetadataAfterInsert(note.id);
      if (this.onRefreshNotesList) await this.onRefreshNotesList();
      if (this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(note.id);

      Utils.showToast('New note created from AI response', 'success');

      if (this.llm.isConfigured()) {
        this.generateTitleForNewNote(note.id, rawContent || parsedBlocks.map(block => block.content || '').join('\n'));
      }
    } catch (error) {
      console.error('Failed to create note:', error);
      Utils.showToast('Failed to create note', 'error');
    }
  }

  async generateTitleForNewNote(noteId, content) {
    try {
      const newTitle = await this.llm.generateTitle(content);

      if (!newTitle || !newTitle.trim()) return;

      const note = await this.storage.getNote(noteId);
      if (!note) return;

      note.name = newTitle;
      note.lastAutoTitleAt = Date.now();
      await this.storage.updateNote(note);

      const editor = this.getEditor ? this.getEditor() : null;
      if (editor && editor.noteId === noteId) {
        editor.setTitleProgrammatically(newTitle);
      }

      const openTabs = this.onGetOpenTabs ? this.onGetOpenTabs() : [];
      const tabIndex = openTabs.findIndex(t => t.noteId === noteId);
      if (tabIndex !== -1) {
        openTabs[tabIndex].name = newTitle;
        if (this.onRenderTabs) this.onRenderTabs();
        if (this.onSaveTabs) await this.onSaveTabs();
      }

      if (this.onRenderNotesList) this.onRenderNotesList();

      Utils.showToast(`Title generated: "${newTitle}"`, 'success');
    } catch (error) {
      console.error('Failed to generate title for new note:', error);
    }
  }

  // ─── LLM settings ───

  setupLLMSettings() {
    const providerSelect = document.getElementById('llm-provider-select');
    const apiKeyInput = document.getElementById('llm-api-key');
    const modelSelect = document.getElementById('llm-model-select');
    const ollamaUrlInput = document.getElementById('ollama-url');
    const refreshModelsBtn = document.getElementById('refresh-models-btn');

    if (!providerSelect) return;

    providerSelect.addEventListener('change', async (e) => {
      const provider = e.target.value;
      await this.llm.setProvider(provider);
      this.updateLLMSettingsVisibility(provider);
      await this.loadAndPopulateModels(provider, this.llm.apiKey);
      this.updateAISidebarState();
    });

    const debouncedApiKeySave = Utils.debounce(async (value) => {
      await this.llm.setApiKey(value);
      if (value && this.llm.provider !== 'none') {
        await this.loadAndPopulateModels(this.llm.provider, value);
      }
      this.updateAISidebarState();
    }, 800);

    apiKeyInput?.addEventListener('input', (e) => {
      debouncedApiKeySave(e.target.value);
    });

    modelSelect?.addEventListener('change', async (e) => {
      await this.llm.setModel(e.target.value);
      this.updateAISidebarState();
    });

    if (ollamaUrlInput) {
      const debouncedOllamaUrlSave = Utils.debounce(async (value) => {
        await this.llm.setOllamaUrl(value);
        if (this.llm.provider === 'ollama') {
          await this.loadAndPopulateModels('ollama', '');
        }
        this.updateAISidebarState();
      }, 800);

      ollamaUrlInput.addEventListener('input', (e) => {
        debouncedOllamaUrlSave(e.target.value);
      });
    }

    if (refreshModelsBtn) {
      refreshModelsBtn.addEventListener('click', async () => {
        await this.loadAndPopulateModels(this.llm.provider, this.llm.apiKey, true);
      });
    }

    // API key reveal toggle (Req 38.3)
    document.querySelectorAll('.api-key-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.api-key-input-group');
        const input = group?.querySelector('input');
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.title = isPassword ? 'Hide API key' : 'Show API key';
        btn.querySelector('.eye-icon')?.classList.toggle('hidden', isPassword);
        btn.querySelector('.eye-off-icon')?.classList.toggle('hidden', !isPassword);
      });
    });

    // Clear API key button (Req 38.2)
    document.querySelectorAll('.api-key-clear-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const group = btn.closest('.api-key-input-group');
        const input = group?.querySelector('input');
        if (!input || !input.value) return;
        await this.llm.setApiKey('');
        // Clear all API key inputs in both settings sections
        document.querySelectorAll('#llm-api-key').forEach(el => { el.value = ''; });
        this.updateAISidebarState();
        Utils.showToast('API key cleared', 'success');
      });
    });
  }

  updateLLMSettingsVisibility(provider) {
    const apiKeyRows = document.querySelectorAll('.llm-api-key-row');
    const modelRow = document.querySelector('.llm-model-row');
    const ollamaUrlRow = document.querySelector('.llm-ollama-url-row');
    const ollamaHint = document.querySelector('.llm-ollama-hint');
    const autoTitleRow = document.querySelector('.llm-auto-title-row');
    const autoTitleIntervalRow = document.querySelector('.llm-auto-title-interval-row');
    const autoTitleHint = document.querySelector('.llm-auto-title-hint');
    const insightsRow = document.querySelector('.llm-insights-row');
    const insightsIntervalRow = document.querySelector('.llm-insights-interval-row');
    const insightsHint = document.querySelector('.llm-insights-hint');

    const isConfigured = provider !== 'none';
    const isOllama = provider === 'ollama';

    if (provider === 'none') {
      apiKeyRows.forEach(el => el.classList.add('hidden'));
      modelRow.classList.add('hidden');
      if (ollamaUrlRow) ollamaUrlRow.classList.add('hidden');
    } else if (isOllama) {
      apiKeyRows.forEach(el => el.classList.add('hidden'));
      modelRow.classList.remove('hidden');
      if (ollamaUrlRow) ollamaUrlRow.classList.remove('hidden');
    } else {
      apiKeyRows.forEach(el => el.classList.remove('hidden'));
      modelRow.classList.remove('hidden');
      if (ollamaUrlRow) ollamaUrlRow.classList.add('hidden');
    }

    if (ollamaHint) ollamaHint.classList.toggle('hidden', !isOllama);

    if (autoTitleRow) autoTitleRow.classList.toggle('hidden', !isConfigured);
    if (autoTitleHint) autoTitleHint.classList.toggle('hidden', !isConfigured);

    const autoTitleEnabled = document.getElementById('auto-title-enabled');
    if (autoTitleIntervalRow) {
      autoTitleIntervalRow.classList.toggle('hidden', !isConfigured || !autoTitleEnabled?.checked);
    }

    if (insightsRow) insightsRow.classList.toggle('hidden', !isConfigured);
    if (insightsHint) insightsHint.classList.toggle('hidden', !isConfigured);

    const insightsEnabled = document.getElementById('insights-enabled');
    if (insightsIntervalRow) {
      insightsIntervalRow.classList.toggle('hidden', !isConfigured || !insightsEnabled?.checked);
    }
  }

  /**
   * Populate LLM settings values when settings modal opens.
   */
  async updateLLMSettingsUI() {
    const provider = await this.storage.getSetting('llmProvider', 'none');
    const apiKey = await this.storage.getSetting('llmApiKey', '');
    const model = await this.storage.getSetting('llmModel', '');
    const ollamaUrl = await this.storage.getSetting('ollamaUrl', 'http://localhost:11434');

    const providerSelect = document.getElementById('llm-provider-select');
    if (providerSelect) providerSelect.value = provider;

    const apiKeyInput = document.getElementById('llm-api-key');
    if (apiKeyInput) apiKeyInput.value = apiKey;

    const ollamaUrlInput = document.getElementById('ollama-url');
    if (ollamaUrlInput) ollamaUrlInput.value = ollamaUrl;

    this.updateLLMSettingsVisibility(provider);
    await this.loadAndPopulateModels(provider, apiKey);

    if (model) {
      const modelSelect = document.getElementById('llm-model-select');
      if (modelSelect) modelSelect.value = model;
    }

    // Auto-title settings
    const autoTitleEnabled = await this.storage.getSetting('autoTitleEnabled', false);
    const autoTitleInterval = await this.storage.getSetting('autoTitleInterval', 15);

    const autoTitleEnabledCheckbox = document.getElementById('auto-title-enabled');
    const autoTitleIntervalSelect = document.getElementById('auto-title-interval');

    if (autoTitleEnabledCheckbox) autoTitleEnabledCheckbox.checked = autoTitleEnabled;
    if (autoTitleIntervalSelect) autoTitleIntervalSelect.value = autoTitleInterval.toString();

    // Insights extraction settings
    const insightsEnabled = await this.storage.getSetting('insightsEnabled', false);
    const insightsInterval = await this.storage.getSetting('insightsInterval', 360);

    const insightsEnabledCheckbox = document.getElementById('insights-enabled');
    const insightsIntervalSelect = document.getElementById('insights-interval');

    if (insightsEnabledCheckbox) insightsEnabledCheckbox.checked = insightsEnabled;
    if (insightsIntervalSelect) insightsIntervalSelect.value = insightsInterval.toString();
  }

  async loadAndPopulateModels(provider, apiKey, forceRefresh = false) {
    const modelSelect = document.getElementById('llm-model-select');
    const refreshBtn = document.getElementById('refresh-models-btn');

    if (!modelSelect) return;

    modelSelect.innerHTML = '<option value="">Loading models...</option>';
    modelSelect.disabled = true;
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('loading');
    }

    try {
      const models = await this.llm.fetchModels(provider, apiKey);

      modelSelect.innerHTML = '';

      if (models.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = provider === 'ollama'
          ? 'No models found. Is Ollama running?'
          : 'No models available';
        modelSelect.appendChild(option);
      } else {
        models.forEach((model) => {
          const option = document.createElement('option');
          option.value = model.id;
          option.textContent = model.name;
          option.selected = model.id === this.llm.model;
          modelSelect.appendChild(option);
        });

        if (!models.find(m => m.id === this.llm.model) && models.length > 0) {
          await this.llm.setModel(models[0].id);
          modelSelect.value = models[0].id;
        }
      }
    } catch (error) {
      console.error('Failed to load models:', error);
      modelSelect.innerHTML = '<option value="">Failed to load models</option>';
    } finally {
      modelSelect.disabled = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('loading');
      }
    }
  }

  // ─── Prompt templates ───

  getAIPromptTemplateApi() {
    return typeof AIPromptTemplates !== 'undefined' ? AIPromptTemplates : null;
  }

  getDefaultAIPromptTemplates() {
    const api = this.getAIPromptTemplateApi();
    return api ? api.getDefaultAIPromptTemplates() : [];
  }

  sanitizeAIPromptTemplates(templates) {
    const api = this.getAIPromptTemplateApi();
    if (!api) {
      return Array.isArray(templates) ? templates.slice() : [];
    }
    return api.sanitizeAIPromptTemplates(templates);
  }

  getAIPromptTemplatesForScope(scope) {
    const api = this.getAIPromptTemplateApi();
    if (!api) return [];
    return api.getAIPromptTemplatesForScope(this.aiPromptTemplates, scope);
  }

  async loadAIPromptTemplates() {
    const savedTemplates = await this.storage.getSetting('aiPromptTemplates', null);
    this.aiPromptTemplates = this.sanitizeAIPromptTemplates(savedTemplates);

    if (savedTemplates === null || !Array.isArray(savedTemplates)) {
      try {
        await this.storage.setSetting('aiPromptTemplates', this.aiPromptTemplates);
      } catch (error) {
        console.warn('Failed to seed AI prompt templates:', error);
      }
    }

    this.renderAIPromptSuggestions();
    return this.aiPromptTemplates;
  }

  async persistAIPromptTemplates(templates, successMessage = '') {
    const sanitized = this.sanitizeAIPromptTemplates(templates);

    try {
      await this.storage.setSetting('aiPromptTemplates', sanitized);
      this.aiPromptTemplates = sanitized;
      this.renderAIPromptSuggestions();
      this.renderAIPromptTemplateSettings();
      if (successMessage) {
        Utils.showToast(successMessage, 'success');
      }
      return true;
    } catch (error) {
      console.error('Failed to save AI prompt templates:', error);
      Utils.showToast('Failed to save AI prompt templates', 'error');
      return false;
    }
  }

  createAIPromptSuggestionButton(template, variant = 'note') {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.templateId = template.id;
    button.title = template.prompt;
    button.textContent = template.label;

    if (variant === 'sticky') {
      button.className = 'ai-sticky-template-btn';
    } else if (variant === 'global') {
      button.className = 'global-chat-suggestion';
    } else {
      button.className = 'ai-suggestion-btn';
    }

    return button;
  }

  renderAIPromptSuggestions() {
    const noteSuggestions = document.getElementById('ai-note-suggestion-buttons');
    const stickySuggestions = document.getElementById('ai-sticky-template-buttons');
    const globalSuggestions = document.getElementById('ai-global-suggestion-buttons');

    if (noteSuggestions) {
      noteSuggestions.innerHTML = '';
      this.getAIPromptTemplatesForScope('note').forEach(template => {
        noteSuggestions.appendChild(this.createAIPromptSuggestionButton(template, 'note'));
      });
    }

    if (stickySuggestions) {
      stickySuggestions.innerHTML = '';
      this.getAIPromptTemplatesForScope('note').slice(0, 4).forEach(template => {
        stickySuggestions.appendChild(this.createAIPromptSuggestionButton(template, 'sticky'));
      });
    }

    if (globalSuggestions) {
      globalSuggestions.innerHTML = '';
      this.getAIPromptTemplatesForScope('global').forEach(template => {
        globalSuggestions.appendChild(this.createAIPromptSuggestionButton(template, 'global'));
      });
    }
  }

  applyAIPromptTemplate(template, scope) {
    const input = document.getElementById(scope === 'global' ? 'global-chat-input' : 'ai-chat-input');
    if (!input || !template) return;

    input.value = template.prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));

    if (template.behavior === 'prefill') {
      input.focus();
      if (typeof input.setSelectionRange === 'function') {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
      return;
    }

    if (scope === 'global') {
      this.sendGlobalChatMessage();
    } else {
      this.sendAIChatMessage();
    }
  }

  handleAIPromptSuggestionClick(event, scope) {
    const button = event.target.closest('[data-template-id]');
    if (!button) return;

    const template = this.aiPromptTemplates.find(item => item.id === button.dataset.templateId);
    if (!template) return;

    this.applyAIPromptTemplate(template, scope);
  }

  // ─── Prompt template settings UI ───

  setupAIPromptTemplateSettings() {
    const list = document.getElementById('ai-prompt-template-list');
    const addBtn = document.getElementById('ai-template-add-btn');
    const resetBtn = document.getElementById('ai-template-reset-btn');
    const form = document.getElementById('ai-prompt-template-form');
    const cancelBtn = document.getElementById('ai-template-cancel-btn');

    addBtn?.addEventListener('click', () => {
      this.openAIPromptTemplateEditor();
    });

    resetBtn?.addEventListener('click', async () => {
      await this.resetAIPromptTemplates();
    });

    list?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action][data-template-id]');
      if (!button) return;

      const { action, templateId } = button.dataset;

      if (action === 'edit') {
        this.openAIPromptTemplateEditor(templateId);
        return;
      }

      if (action === 'delete') {
        await this.deleteAIPromptTemplate(templateId);
        return;
      }

      if (action === 'move-up' || action === 'move-down') {
        await this.moveAIPromptTemplateSetting(templateId, action === 'move-up' ? 'up' : 'down');
      }
    });

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await this.submitAIPromptTemplateForm();
    });

    cancelBtn?.addEventListener('click', () => {
      this.closeAIPromptTemplateEditor();
    });
  }

  renderAIPromptTemplateSettings() {
    const list = document.getElementById('ai-prompt-template-list');
    const empty = document.getElementById('ai-prompt-template-empty');
    if (!list || !empty) return;

    list.innerHTML = '';
    empty.classList.toggle('hidden', this.aiPromptTemplates.length > 0);

    this.aiPromptTemplates.forEach((template, index) => {
      const row = document.createElement('div');
      row.className = 'ai-prompt-template-item';

      const main = document.createElement('div');
      main.className = 'ai-prompt-template-main';

      const meta = document.createElement('div');
      meta.className = 'ai-prompt-template-meta';

      const label = document.createElement('span');
      label.className = 'ai-prompt-template-label';
      label.textContent = template.label;
      meta.appendChild(label);

      const scopeBadge = document.createElement('span');
      scopeBadge.className = 'ai-prompt-template-badge';
      scopeBadge.textContent = template.scope === 'both' ? 'Both' : template.scope === 'note' ? 'This Note' : 'All Notes';
      meta.appendChild(scopeBadge);

      const behaviorBadge = document.createElement('span');
      behaviorBadge.className = 'ai-prompt-template-badge';
      behaviorBadge.textContent = template.behavior === 'prefill' ? 'Prefill' : 'Send';
      meta.appendChild(behaviorBadge);

      const prompt = document.createElement('div');
      prompt.className = 'ai-prompt-template-prompt';
      prompt.textContent = template.prompt;

      main.appendChild(meta);
      main.appendChild(prompt);

      const actions = document.createElement('div');
      actions.className = 'ai-prompt-template-actions';

      const moveUpBtn = document.createElement('button');
      moveUpBtn.type = 'button';
      moveUpBtn.className = 'secondary-btn-small';
      moveUpBtn.dataset.action = 'move-up';
      moveUpBtn.dataset.templateId = template.id;
      moveUpBtn.textContent = 'Up';
      moveUpBtn.disabled = index === 0;
      actions.appendChild(moveUpBtn);

      const moveDownBtn = document.createElement('button');
      moveDownBtn.type = 'button';
      moveDownBtn.className = 'secondary-btn-small';
      moveDownBtn.dataset.action = 'move-down';
      moveDownBtn.dataset.templateId = template.id;
      moveDownBtn.textContent = 'Down';
      moveDownBtn.disabled = index === this.aiPromptTemplates.length - 1;
      actions.appendChild(moveDownBtn);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'secondary-btn-small';
      editBtn.dataset.action = 'edit';
      editBtn.dataset.templateId = template.id;
      editBtn.textContent = 'Edit';
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'secondary-btn-small';
      deleteBtn.dataset.action = 'delete';
      deleteBtn.dataset.templateId = template.id;
      deleteBtn.textContent = 'Delete';
      actions.appendChild(deleteBtn);

      row.appendChild(main);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  openAIPromptTemplateEditor(templateId = '') {
    const form = document.getElementById('ai-prompt-template-form');
    const idInput = document.getElementById('ai-prompt-template-edit-id');
    const labelInput = document.getElementById('ai-prompt-template-label');
    const scopeInput = document.getElementById('ai-prompt-template-scope');
    const behaviorInput = document.getElementById('ai-prompt-template-behavior');
    const promptInput = document.getElementById('ai-prompt-template-prompt');
    const saveBtn = document.getElementById('ai-template-save-btn');

    if (!form || !labelInput || !scopeInput || !behaviorInput || !promptInput || !idInput) return;

    const template = templateId
      ? this.aiPromptTemplates.find(item => item.id === templateId)
      : null;

    this.aiPromptTemplateEditingId = template ? template.id : null;
    idInput.value = template ? template.id : '';
    labelInput.value = template ? template.label : '';
    scopeInput.value = template ? template.scope : 'note';
    behaviorInput.value = template ? template.behavior : 'send';
    promptInput.value = template ? template.prompt : '';
    if (saveBtn) {
      saveBtn.textContent = template ? 'Save changes' : 'Save template';
    }

    form.classList.remove('hidden');
    labelInput.focus();
  }

  closeAIPromptTemplateEditor() {
    const form = document.getElementById('ai-prompt-template-form');
    const idInput = document.getElementById('ai-prompt-template-edit-id');
    const labelInput = document.getElementById('ai-prompt-template-label');
    const scopeInput = document.getElementById('ai-prompt-template-scope');
    const behaviorInput = document.getElementById('ai-prompt-template-behavior');
    const promptInput = document.getElementById('ai-prompt-template-prompt');
    const saveBtn = document.getElementById('ai-template-save-btn');

    this.aiPromptTemplateEditingId = null;

    if (form) form.classList.add('hidden');
    if (idInput) idInput.value = '';
    if (labelInput) labelInput.value = '';
    if (scopeInput) scopeInput.value = 'note';
    if (behaviorInput) behaviorInput.value = 'send';
    if (promptInput) promptInput.value = '';
    if (saveBtn) saveBtn.textContent = 'Save template';
  }

  async submitAIPromptTemplateForm() {
    const idInput = document.getElementById('ai-prompt-template-edit-id');
    const labelInput = document.getElementById('ai-prompt-template-label');
    const scopeInput = document.getElementById('ai-prompt-template-scope');
    const behaviorInput = document.getElementById('ai-prompt-template-behavior');
    const promptInput = document.getElementById('ai-prompt-template-prompt');

    const label = labelInput?.value.trim() || '';
    const prompt = promptInput?.value.trim() || '';
    const scope = scopeInput?.value || 'note';
    const behavior = behaviorInput?.value || 'send';
    const editingId = idInput?.value || '';

    if (!label || !prompt) {
      Utils.showToast('Template label and prompt are required', 'error');
      return;
    }

    const nextTemplates = this.aiPromptTemplates.slice();
    const nextTemplate = {
      id: editingId || undefined,
      label,
      prompt,
      scope,
      behavior,
    };

    if (editingId) {
      const index = nextTemplates.findIndex(template => template.id === editingId);
      if (index !== -1) {
        nextTemplates[index] = nextTemplate;
      }
    } else {
      nextTemplates.push(nextTemplate);
    }

    const saved = await this.persistAIPromptTemplates(nextTemplates, 'AI prompt templates updated');
    if (saved) {
      this.closeAIPromptTemplateEditor();
    }
  }

  async moveAIPromptTemplateSetting(templateId, direction) {
    const api = this.getAIPromptTemplateApi();
    if (!api) return;

    const reordered = api.moveAIPromptTemplate(this.aiPromptTemplates, templateId, direction);
    await this.persistAIPromptTemplates(reordered);
  }

  async deleteAIPromptTemplate(templateId) {
    const nextTemplates = this.aiPromptTemplates.filter(template => template.id !== templateId);
    const saved = await this.persistAIPromptTemplates(nextTemplates, 'AI prompt template removed');
    if (saved && this.aiPromptTemplateEditingId === templateId) {
      this.closeAIPromptTemplateEditor();
    }
  }

  async resetAIPromptTemplates() {
    const saved = await this.persistAIPromptTemplates(this.getDefaultAIPromptTemplates(), 'Default AI prompt templates restored');
    if (saved) {
      this.closeAIPromptTemplateEditor();
    }
  }

  // ─── Smart suggestions ───

  async updateSmartSuggestions(force = false) {
    if (this.aiActiveTab !== 'smart' && !force) return;

    const editor = this.getEditor ? this.getEditor() : null;
    if (!editor || !editor.noteId) return;

    const text = editor.getAllBlocksTextContent();
    if (text.trim().length < 20) {
      document.getElementById('ai-smart-empty')?.classList.remove('hidden');
      document.getElementById('ai-smart-results')?.classList.add('hidden');
      return;
    }

    const loading = document.getElementById('ai-smart-loading');
    if (force) loading?.classList.remove('hidden');

    try {
      const searchResults = this.searchEngine ? await this.searchEngine.search(text) : [];
      const relatedResults = searchResults
        .filter(r => r.id !== editor.noteId)
        .slice(0, 5)
        .filter(r => r.score > 0.4);

      let insights = null;
      const note = editor.noteData;

      if (note && note.insights) {
        const currentContentHash = this.generateContentHash(text);
        const storedContentHash = note.lastInsightsContentHash;

        if (!storedContentHash || storedContentHash === currentContentHash) {
          insights = note.insights;
        }
      }

      if (!insights) {
        insights = await this.llm.extractInsights(text, editor.titleEl?.textContent || '');
      }

      this.renderSmartInsights(insights, relatedResults);

    } catch (error) {
      console.error('Smart suggestions failed:', error);
    } finally {
      loading?.classList.add('hidden');
    }
  }

  renderSmartInsights(insights, related) {
    const emptyState = document.getElementById('ai-smart-empty');
    const resultsArea = document.getElementById('ai-smart-results');

    emptyState?.classList.add('hidden');
    resultsArea?.classList.remove('hidden');

    // Tags
    const tagsContainer = document.getElementById('ai-suggested-tags');
    if (tagsContainer) {
      tagsContainer.innerHTML = '';
      if (insights?.tags?.length > 0) {
        insights.tags.forEach(tag => {
          const el = document.createElement('span');
          el.className = 'global-chat-source-tag';
          el.textContent = `#${tag}`;
          tagsContainer.appendChild(el);
        });
      } else {
        tagsContainer.innerHTML = '<span class="ai-sources-title" style="text-transform:none">No tags suggested</span>';
      }
    }

    // Action Items
    const actionContainer = document.getElementById('ai-extracted-actions');
    if (actionContainer) {
      actionContainer.innerHTML = '';
      const items = [
        ...(insights?.todos || []).map(t => ({ text: t, icon: 'check-square' })),
        ...(insights?.deadlines || []).map(d => ({ text: `${d.text} (${d.date || 'Soon'})`, icon: 'calendar' })),
        ...(insights?.reminders || []).map(r => ({ text: r, icon: 'bell' }))
      ];

      if (items.length > 0) {
        items.forEach(item => {
          const el = document.createElement('div');
          el.className = 'ai-action-item';
          const iconDiv = document.createElement('div');
          iconDiv.className = 'ai-action-icon';
          iconDiv.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${item.icon === 'check-square' ? '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><polyline points="9 11 12 14 22 4"></polyline>' :
              item.icon === 'calendar' ? '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>' :
                '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>'}
              </svg>
          `;
          el.appendChild(iconDiv);
          const textSpan = document.createElement('span');
          textSpan.textContent = item.text;
          el.appendChild(textSpan);
          actionContainer.appendChild(el);
        });
      } else {
        actionContainer.innerHTML = '<span class="ai-sources-title" style="text-transform:none">No action items found</span>';
      }
    }

    // Related Notes
    const relatedContainer = document.getElementById('ai-related-notes');
    if (relatedContainer) {
      relatedContainer.innerHTML = '';
      const notes = this.onGetNotes ? this.onGetNotes() : [];
      if (related.length > 0) {
        related.forEach(res => {
          const note = notes.find(n => n.id === res.id);
          const el = document.createElement('div');
          el.className = 'ai-related-item';
          el.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
          `;
          const titleSpan = document.createElement('span');
          titleSpan.className = 'ai-related-title';
          titleSpan.textContent = note?.name || 'Untitled';
          el.appendChild(titleSpan);
          el.addEventListener('click', () => {
            if (this.onOpenNoteById) this.onOpenNoteById(res.id);
          });
          relatedContainer.appendChild(el);
        });
      } else {
        relatedContainer.innerHTML = '<span class="ai-sources-title" style="text-transform:none">No related notes found</span>';
      }
    }
  }

  // ─── Context indicator ───

  /**
   * Show a context indicator badge in the chat UI.
   * @param {number} percentage - Percentage of note content included
   */
  showContextIndicator(percentage) {
    const container = document.getElementById('ai-chat-messages');
    if (!container) return;

    let indicator = container.querySelector('.ai-context-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'ai-context-indicator';
      container.appendChild(indicator);
    }
    indicator.textContent = `Using ${percentage}% of note content`;
    indicator.style.display = '';
  }

  /**
   * Hide the context indicator badge.
   */
  hideContextIndicator() {
    const indicator = document.querySelector('.ai-context-indicator');
    if (indicator) indicator.style.display = 'none';
  }

  // ─── Context windowing ───

  /**
   * Build a smart context window for long notes, prioritizing relevant blocks.
   * Returns the windowed content string and a percentage indicator.
   *
   * Prioritization order:
   *   1. Headings (for structural context)
   *   2. Blocks near the cursor (±5 blocks)
   *   3. Recently edited blocks (by updatedAt)
   *   4. Remaining blocks in order
   *
   * @param {Array<Object>} blocks - Array of block data objects from the editor
   * @param {number} cursorIndex - Index of the currently focused block (-1 if none)
   * @param {Object} [options]
   * @param {number} [options.tokenLimit=6000] - Max estimated tokens (chars / 4)
   * @returns {{ content: string, percentage: number, isWindowed: boolean }}
   */
  buildContextWindow(blocks, cursorIndex, options = {}) {
    const tokenLimit = options.tokenLimit || 6000;
    const charLimit = tokenLimit * 4;

    // Extract text from each block with its index
    const entries = blocks.map((block, index) => ({
      index,
      text: this.extractBlockText(block),
      type: block.type,
      updatedAt: block.updatedAt || 0,
    }));

    const totalChars = entries.reduce((sum, e) => sum + e.text.length, 0);

    // If under limit, return everything
    if (totalChars <= charLimit) {
      const content = entries.map(e => e.text).filter(t => t).join('\n\n');
      return { content, percentage: 100, isWindowed: false };
    }

    // Score each block for priority
    const headingTypes = new Set(['h1', 'h2', 'h3']);
    const cursorRadius = 5;

    // Sort blocks by updatedAt descending to rank recency
    const byRecency = entries
      .filter(e => e.updatedAt > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const recentSet = new Set(byRecency.slice(0, 10).map(e => e.index));

    const scored = entries.map(entry => {
      let score = 0;

      // Headings always included for structure
      if (headingTypes.has(entry.type)) score += 100;

      // Blocks near cursor
      if (cursorIndex >= 0) {
        const distance = Math.abs(entry.index - cursorIndex);
        if (distance === 0) score += 80;
        else if (distance <= cursorRadius) score += 60 - (distance * 5);
      }

      // Recently edited
      if (recentSet.has(entry.index)) score += 40;

      return { ...entry, score };
    });

    // Sort by score descending, then by original index for stability
    scored.sort((a, b) => b.score - a.score || a.index - b.index);

    // Greedily pick blocks until we hit the char limit
    const selected = new Set();
    let usedChars = 0;

    for (const entry of scored) {
      if (!entry.text) continue;
      if (usedChars + entry.text.length > charLimit) continue;
      selected.add(entry.index);
      usedChars += entry.text.length;
    }

    // Rebuild content in original block order
    const content = entries
      .filter(e => selected.has(e.index))
      .map(e => e.text)
      .filter(t => t)
      .join('\n\n');

    const percentage = Math.round((usedChars / totalChars) * 100);

    return { content, percentage, isWindowed: true };
  }

  // ─── Utility methods ───

  getNoteContent() {
    const blocks = document.querySelectorAll('#blocks-container .block');
    const contentParts = [];

    blocks.forEach((block) => {
      const content = block.querySelector('.block-content');
      if (content) {
        const text = content.textContent.trim();
        if (text) {
          contentParts.push(text);
        }
      }
    });

    return contentParts.join('\n\n');
  }

  extractBlockText(block) {
    if (!block) return '';

    switch (block.type) {
      case 'text':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'bullet':
      case 'numbered':
      case 'todo':
      case 'quote':
      case 'callout':
        return this.stripHtml(block.content || '');

      case 'code':
        return block.content || '';

      case 'toggle':
        const mainText = this.stripHtml(block.content || '');
        const childText = this.stripHtml(block.children || '');
        return [mainText, childText].filter(t => t).join('\n');

      case 'table':
        if (block.tableData && Array.isArray(block.tableData)) {
          return block.tableData.map(row => row.join(' ')).join('\n');
        }
        return '';

      case 'bookmark':
        return block.title || block.url || '';

      case 'equation':
        return block.equation || '';

      default:
        return '';
    }
  }

  stripHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  generateContentHash(content) {
    let hash = 0;
    const str = content.trim();
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  // ─── Accessibility (Req 12) ───

  /**
   * Set up accessibility features: hidden aria-live region for batched
   * screen reader announcements, and Escape key handler for collapsing
   * expanded sections.
   */
  _setupAccessibility() {
    // Req 12.2: Create a hidden aria-live region for batched announcements
    this._srLiveRegion = document.createElement('div');
    this._srLiveRegion.setAttribute('aria-live', 'polite');
    this._srLiveRegion.setAttribute('aria-atomic', 'true');
    this._srLiveRegion.setAttribute('role', 'status');
    this._srLiveRegion.className = 'sr-only';
    this._srLiveRegion.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
    document.getElementById('ai-sidebar')?.appendChild(this._srLiveRegion);

    // Req 12.4: Escape key handler to collapse expanded sections
    this._escapeHandler = (e) => {
      if (e.key !== 'Escape') return;
      const sidebar = document.getElementById('ai-sidebar');
      if (!sidebar || sidebar.classList.contains('hidden')) return;

      // Collapse any expanded thinking details
      const expandedThinking = sidebar.querySelectorAll('.thinking-detail:not(.hidden)');
      expandedThinking.forEach(el => {
        el.classList.add('hidden');
        const toggle = el.parentElement?.querySelector('[aria-expanded]');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      });

      // Collapse any expanded timeline step content
      const expandedSteps = sidebar.querySelectorAll('.timeline-step-content.expanded');
      expandedSteps.forEach(el => {
        el.classList.remove('expanded');
        const label = el.parentElement?.querySelector('.timeline-step-label');
        if (label) label.setAttribute('aria-expanded', 'false');
      });

      // Collapse any expanded tool card sections (show-more / show-full-output)
      const expandedToolSections = sidebar.querySelectorAll('.tool-card-input.expanded, .tool-card-output.expanded');
      expandedToolSections.forEach(el => {
        el.classList.remove('expanded');
        const toggle = el.querySelector('[aria-expanded]');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      });
    };
    document.addEventListener('keydown', this._escapeHandler);
  }

  /**
   * Batched screen reader announcement. Accumulates text and announces
   * a summary at most once every 3 seconds via the hidden aria-live region.
   * @param {string} text - New content text to announce
   * @param {boolean} [flush=false] - If true, announce immediately (e.g. on stream end)
   */
  _announceToScreenReader(text, flush = false) {
    if (!this._srLiveRegion) return;

    if (flush) {
      // Clear any pending timer and announce final summary
      if (this._srAnnouncementTimer) {
        clearTimeout(this._srAnnouncementTimer);
        this._srAnnouncementTimer = null;
      }
      const summary = this._srAnnouncementBuffer.trim() || text;
      this._srAnnouncementBuffer = '';
      if (summary) {
        // Truncate to a reasonable length for screen readers
        const truncated = summary.length > 300 ? summary.slice(0, 300) + '…' : summary;
        this._srLiveRegion.textContent = truncated;
      }
      return;
    }

    this._srAnnouncementBuffer += text;

    if (!this._srAnnouncementTimer) {
      this._srAnnouncementTimer = setTimeout(() => {
        this._srAnnouncementTimer = null;
        const content = this._srAnnouncementBuffer.trim();
        this._srAnnouncementBuffer = '';
        if (content && this._srLiveRegion) {
          const truncated = content.length > 300 ? content.slice(0, 300) + '…' : content;
          this._srLiveRegion.textContent = truncated;
        }
      }, 3000);
    }
  }

  /**
   * Clean up accessibility listeners and DOM elements.
   */
  _cleanupAccessibility() {
    if (this._escapeHandler) {
      document.removeEventListener('keydown', this._escapeHandler);
      this._escapeHandler = null;
    }
    if (this._srAnnouncementTimer) {
      clearTimeout(this._srAnnouncementTimer);
      this._srAnnouncementTimer = null;
    }
    if (this._srLiveRegion) {
      this._srLiveRegion.remove();
      this._srLiveRegion = null;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AIChatController };
} else if (typeof window !== 'undefined') {
  window.AIChatController = AIChatController;
}
