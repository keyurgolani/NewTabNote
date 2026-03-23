/**
 * Chat UI component factory functions.
 * Each factory returns a component object with an `el` property and a `destroy()` method.
 */

/**
 * Creates a skeleton loading placeholder.
 * @param {'message'|'tool'} variant
 * @returns {{ el: HTMLElement, destroy(): void }}
 */
function createSkeletonLoader(variant) {
  const el = document.createElement('div');

  if (variant === 'tool') {
    el.className = 'skeleton-tool';
    for (let i = 0; i < 2; i++) {
      const line = document.createElement('div');
      line.className = 'shimmer-line';
      el.appendChild(line);
    }
  } else {
    el.className = 'skeleton-loader';
    const widths = ['100%', '85%', '70%', '45%'];
    for (const w of widths) {
      const line = document.createElement('div');
      line.className = 'shimmer-line';
      line.style.width = w;
      el.appendChild(line);
    }
  }

  return {
    el,
    destroy() {
      el.remove();
    }
  };
}

/**
 * Creates a thinking visualization DOM element with shimmer animation,
 * sentence crossfade, and collapsible detail view.
 * @param {Object} opts
 * @param {function(): void} [opts.onCollapse] - Called when thinking collapses to toggle
 * @returns {{ el: HTMLElement, addSentence(text: string): void, collapse(): void, destroy(): void }}
 */
function createThinkingTicker(opts) {
  opts = opts || {};

  // Internal state
  var sentences = [];
  var currentIndex = -1;
  var intervalId = null;
  var fullText = '';
  var collapsed = false;

  // Build DOM: .thinking-ticker > .thinking-ticker-glass > shimmer overlay + sentences + shimmer lines
  var el = document.createElement('div');
  el.className = 'thinking-ticker';

  var glass = document.createElement('div');
  glass.className = 'thinking-ticker-glass';

  var shimmerOverlay = document.createElement('div');
  shimmerOverlay.className = 'thinking-shimmer-overlay';

  var sentencesContainer = document.createElement('div');
  sentencesContainer.className = 'thinking-sentences';

  var shimmerLines = document.createElement('div');
  shimmerLines.className = 'thinking-shimmer-lines';
  var lineWidths = ['80%', '60%', '40%'];
  for (var i = 0; i < lineWidths.length; i++) {
    var line = document.createElement('div');
    line.className = 'shimmer-line';
    line.style.width = lineWidths[i];
    shimmerLines.appendChild(line);
  }

  glass.appendChild(shimmerOverlay);
  glass.appendChild(sentencesContainer);
  glass.appendChild(shimmerLines);
  el.appendChild(glass);

  // Crossfade interval duration (ms)
  var CROSSFADE_INTERVAL = 3000;

  function showSentence(index) {
    if (index < 0 || index >= sentences.length) return;
    sentencesContainer.innerHTML = '';
    var span = document.createElement('span');
    span.className = 'thinking-sentence';
    span.textContent = sentences[index];
    sentencesContainer.appendChild(span);
  }

  function startCrossfade() {
    if (intervalId) return;
    if (sentences.length <= 1) return;
    intervalId = setInterval(function () {
      if (sentences.length === 0 || collapsed) return;
      currentIndex = (currentIndex + 1) % sentences.length;
      showSentence(currentIndex);
    }, CROSSFADE_INTERVAL);
  }

  function addSentence(text) {
    if (collapsed) return;
    sentences.push(text);
    fullText += (fullText ? '\n' : '') + text;

    // Hide shimmer lines when first sentence arrives
    if (sentences.length === 1) {
      shimmerLines.classList.add('hidden');
    }

    // Show the new sentence immediately
    currentIndex = sentences.length - 1;
    showSentence(currentIndex);

    // Start crossfade rotation if we have multiple sentences
    if (sentences.length > 1 && !intervalId) {
      startCrossfade();
    }
  }

  function collapse() {
    if (collapsed) return;
    collapsed = true;

    // Stop crossfade interval
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }

    // Clear glass content
    glass.innerHTML = '';

    // Create toggle button
    var toggle = document.createElement('button');
    toggle.className = 'thinking-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Show thinking';

    // Create detail container
    var detail = document.createElement('div');
    detail.className = 'thinking-detail';

    var detailContent = document.createElement('div');
    detailContent.className = 'thinking-detail-content';
    detailContent.textContent = fullText;
    detail.appendChild(detailContent);

    function toggleDetail() {
      var isExpanded = toggle.getAttribute('aria-expanded') === 'true';
      if (isExpanded) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Show thinking';
        detail.classList.remove('expanded');
      } else {
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = 'Hide thinking';
        detail.classList.add('expanded');
      }
    }

    toggle.addEventListener('click', toggleDetail);
    toggle.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleDetail();
      }
    });

    glass.appendChild(toggle);
    glass.appendChild(detail);

    if (typeof opts.onCollapse === 'function') {
      opts.onCollapse();
    }
  }

  function destroy() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    el.remove();
  }

  return {
    el: el,
    addSentence: addSentence,
    collapse: collapse,
    destroy: destroy
  };
}
/**
 * Creates a vertical timeline for multi-step agent responses.
 * @returns {{
 *   el: HTMLElement,
 *   addStep(id: string, label: string, type: 'thinking'|'tool'|'answer'): HTMLElement,
 *   setStepStatus(id: string, status: 'pending'|'running'|'complete'|'error'): void,
 *   getStepContent(id: string): HTMLElement|null,
 *   destroy(): void
 * }}
 */
function createTimelineRail() {
  var steps = {};
  var listeners = [];

  var el = document.createElement('div');
  el.className = 'timeline-rail';
  el.setAttribute('role', 'list');

  function addStep(id, label, type) {
    var step = document.createElement('div');
    step.className = 'timeline-step';
    step.setAttribute('data-step-id', id);
    step.setAttribute('data-status', 'pending');
    step.setAttribute('data-type', type || 'answer');
    step.setAttribute('role', 'listitem');

    // Node column: indicator + connector
    var node = document.createElement('div');
    node.className = 'timeline-node';

    var indicator = document.createElement('div');
    indicator.className = 'timeline-node-indicator';

    var connector = document.createElement('div');
    connector.className = 'timeline-connector';

    node.appendChild(indicator);
    node.appendChild(connector);

    // Body: label + collapsible content
    var body = document.createElement('div');
    body.className = 'timeline-step-body';

    var labelEl = document.createElement('div');
    labelEl.className = 'timeline-step-label';
    labelEl.textContent = label;
    labelEl.setAttribute('tabindex', '0');
    labelEl.setAttribute('role', 'button');
    labelEl.setAttribute('aria-expanded', 'false');

    var content = document.createElement('div');
    content.className = 'timeline-step-content';

    function toggleContent() {
      var isExpanded = content.classList.contains('expanded');
      if (isExpanded) {
        content.classList.remove('expanded');
        labelEl.setAttribute('aria-expanded', 'false');
      } else {
        content.classList.add('expanded');
        labelEl.setAttribute('aria-expanded', 'true');
      }
    }

    labelEl.addEventListener('click', toggleContent);

    var keydownHandler = function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleContent();
      }
    };
    labelEl.addEventListener('keydown', keydownHandler);

    listeners.push({ el: labelEl, type: 'click', fn: toggleContent });
    listeners.push({ el: labelEl, type: 'keydown', fn: keydownHandler });

    body.appendChild(labelEl);
    body.appendChild(content);

    step.appendChild(node);
    step.appendChild(body);

    el.appendChild(step);

    steps[id] = { stepEl: step, labelEl: labelEl, contentEl: content };

    return content;
  }

  function setStepStatus(id, status) {
    var entry = steps[id];
    if (!entry) return;

    entry.stepEl.setAttribute('data-status', status);

    if (status === 'running') {
      // Auto-expand running steps
      entry.contentEl.classList.add('expanded');
      entry.labelEl.setAttribute('aria-expanded', 'true');
    } else if (status === 'complete') {
      // Auto-collapse completed steps
      entry.contentEl.classList.remove('expanded');
      entry.labelEl.setAttribute('aria-expanded', 'false');
    }
  }

  function getStepContent(id) {
    var entry = steps[id];
    return entry ? entry.contentEl : null;
  }

  function destroy() {
    for (var i = 0; i < listeners.length; i++) {
      var l = listeners[i];
      l.el.removeEventListener(l.type, l.fn);
    }
    listeners = [];
    steps = {};
    el.remove();
  }

  return {
    el: el,
    addStep: addStep,
    setStepStatus: setStepStatus,
    getStepContent: getStepContent,
    destroy: destroy
  };
}
/**
 * Lucide-style SVG path data mapped by tool type.
 * Each entry is an array of path `d` attributes for a 24x24 viewBox.
 */
var TOOL_ICON_PATHS = {
  search: ['M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M21 21l-4.35-4.35'],
  code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
  web: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z'],
  default: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z']
};

/**
 * Builds an inline SVG element for a given tool type.
 * @param {string} toolType
 * @returns {HTMLElement}
 */
function buildToolIcon(toolType) {
  var paths = TOOL_ICON_PATHS[toolType] || TOOL_ICON_PATHS['default'];
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (var i = 0; i < paths.length; i++) {
    var p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', paths[i]);
    svg.appendChild(p);
  }
  return svg;
}

/**
 * Creates a tool invocation card with progress, input preview, output summary, and error display.
 * @param {Object} opts
 * @param {string} opts.toolName - Display name of the tool
 * @param {string} opts.toolType - Used for icon mapping (search, code, file, web, default)
 * @param {function(): void} [opts.onRetry] - Retry callback for failed tools
 * @returns {{
 *   el: HTMLElement,
 *   setInput(data: string): void,
 *   setProgress(running: boolean): void,
 *   setOutput(data: string): void,
 *   setError(message: string): void,
 *   destroy(): void
 * }}
 */
function createToolCard(opts) {
  opts = opts || {};

  // Root element
  var el = document.createElement('div');
  el.className = 'tool-card';

  // Header: icon + name
  var header = document.createElement('div');
  header.className = 'tool-card-header';

  var iconWrap = document.createElement('div');
  iconWrap.className = 'tool-card-icon';
  iconWrap.appendChild(buildToolIcon(opts.toolType || 'default'));

  var nameEl = document.createElement('div');
  nameEl.className = 'tool-card-name';
  nameEl.textContent = opts.toolName || 'Tool';

  header.appendChild(iconWrap);
  header.appendChild(nameEl);
  el.appendChild(header);

  // Progress bar (shimmer, initially hidden)
  var progressBar = document.createElement('div');
  progressBar.className = 'tool-card-progress hidden';
  el.appendChild(progressBar);

  // Input area (initially empty)
  var inputArea = document.createElement('div');
  inputArea.className = 'tool-card-input';
  inputArea.style.display = 'none';
  el.appendChild(inputArea);

  // Output area (initially empty)
  var outputArea = document.createElement('div');
  outputArea.className = 'tool-card-output';
  outputArea.style.display = 'none';
  el.appendChild(outputArea);

  // Error area (initially empty)
  var errorArea = document.createElement('div');
  errorArea.className = 'tool-card-error';
  errorArea.style.display = 'none';
  el.appendChild(errorArea);

  // Track full data for toggles
  var fullInput = '';
  var fullOutput = '';

  function setInput(data) {
    fullInput = data || '';
    inputArea.innerHTML = '';
    inputArea.style.display = '';

    var preview = document.createElement('div');
    preview.className = 'tool-card-input-preview';
    var truncated = fullInput.length > 120;
    preview.textContent = truncated ? fullInput.slice(0, 120) + '…' : fullInput;
    inputArea.appendChild(preview);

    if (truncated) {
      var toggle = document.createElement('button');
      toggle.className = 'tool-card-input-toggle';
      toggle.textContent = 'Show more';
      toggle.setAttribute('aria-expanded', 'false');

      toggle.addEventListener('click', function () {
        var expanded = toggle.getAttribute('aria-expanded') === 'true';
        if (expanded) {
          preview.textContent = fullInput.slice(0, 120) + '…';
          preview.classList.remove('expanded');
          toggle.textContent = 'Show more';
          toggle.setAttribute('aria-expanded', 'false');
        } else {
          preview.textContent = fullInput;
          preview.classList.add('expanded');
          toggle.textContent = 'Show less';
          toggle.setAttribute('aria-expanded', 'true');
        }
      });

      inputArea.appendChild(toggle);
    }
  }

  function setProgress(running) {
    if (running) {
      progressBar.classList.remove('hidden');
    } else {
      progressBar.classList.add('hidden');
    }
  }

  function setOutput(data) {
    fullOutput = data || '';

    // Replace progress bar with completion indicator
    progressBar.classList.add('hidden');
    var existingComplete = el.querySelector('.tool-card-complete');
    if (!existingComplete) {
      var complete = document.createElement('div');
      complete.className = 'tool-card-complete';
      el.appendChild(complete);
    }

    outputArea.innerHTML = '';
    outputArea.style.display = '';

    var summary = document.createElement('div');
    summary.className = 'tool-card-output-summary';
    var truncated = fullOutput.length > 200;
    summary.textContent = truncated ? fullOutput.slice(0, 200) + '…' : fullOutput;
    outputArea.appendChild(summary);

    if (truncated) {
      var toggle = document.createElement('button');
      toggle.className = 'tool-card-output-toggle';
      toggle.textContent = 'Show full output';
      toggle.setAttribute('aria-expanded', 'false');

      toggle.addEventListener('click', function () {
        var expanded = toggle.getAttribute('aria-expanded') === 'true';
        if (expanded) {
          summary.textContent = fullOutput.slice(0, 200) + '…';
          summary.classList.remove('expanded');
          toggle.textContent = 'Show full output';
          toggle.setAttribute('aria-expanded', 'false');
        } else {
          summary.textContent = fullOutput;
          summary.classList.add('expanded');
          toggle.textContent = 'Hide output';
          toggle.setAttribute('aria-expanded', 'true');
        }
      });

      outputArea.appendChild(toggle);
    }
  }

  function setError(message) {
    // Hide progress
    progressBar.classList.add('hidden');

    errorArea.innerHTML = '';
    errorArea.style.display = '';

    var msgEl = document.createElement('div');
    msgEl.className = 'tool-card-error-message';
    msgEl.textContent = message || 'An error occurred';
    errorArea.appendChild(msgEl);

    var retryBtn = document.createElement('button');
    retryBtn.className = 'tool-card-retry-btn btn-press';
    retryBtn.textContent = 'Retry';
    retryBtn.setAttribute('aria-label', 'Retry tool call');
    if (typeof opts.onRetry === 'function') {
      retryBtn.addEventListener('click', opts.onRetry);
    }
    errorArea.appendChild(retryBtn);
  }

  function destroy() {
    el.remove();
  }

  return {
    el: el,
    setInput: setInput,
    setProgress: setProgress,
    setOutput: setOutput,
    setError: setError,
    destroy: destroy
  };
}
/**
 * Creates a styled user message card with avatar and hover timestamp.
 * @param {Object} opts
 * @param {string} opts.content - Message text
 * @param {string} opts.displayName - User display name (for avatar initial)
 * @param {Date} opts.timestamp
 * @returns {{ el: HTMLElement }}
 */
function createUserRequestCard(opts) {
  opts = opts || {};

  var el = document.createElement('div');
  el.className = 'user-request-card';

  // Avatar circle with first letter of displayName or "U"
  var avatar = document.createElement('div');
  avatar.className = 'user-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  var initial = (opts.displayName && opts.displayName.trim().length > 0)
    ? opts.displayName.trim().charAt(0).toUpperCase()
    : 'U';
  avatar.textContent = initial;

  // Body: content + timestamp
  var body = document.createElement('div');
  body.className = 'user-request-card-body';

  var content = document.createElement('div');
  content.className = 'user-request-card-content';
  content.textContent = opts.content || '';

  var timestamp = document.createElement('div');
  timestamp.className = 'user-timestamp';
  var ts = opts.timestamp instanceof Date ? opts.timestamp : new Date();
  var hours = String(ts.getHours()).padStart(2, '0');
  var minutes = String(ts.getMinutes()).padStart(2, '0');
  timestamp.textContent = hours + ':' + minutes;

  body.appendChild(content);
  body.appendChild(timestamp);

  el.appendChild(body);
  el.appendChild(avatar);

  return { el: el };
}
/**
 * Creates a floating scroll-to-bottom button with badge counter.
 * @param {Object} opts
 * @param {function(): void} opts.onClick - Called when the FAB is clicked
 * @returns {{ el: HTMLElement, setBadge(count: number): void, show(): void, hide(): void, destroy(): void }}
 */
function createScrollFAB(opts) {
  opts = opts || {};

  var el = document.createElement('button');
  el.className = 'scroll-fab';
  el.setAttribute('aria-label', 'Scroll to bottom');
  el.setAttribute('type', 'button');

  // Down-arrow inline SVG icon (Lucide-style chevron-down)
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  var path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  svg.appendChild(path);
  el.appendChild(svg);

  // Badge counter
  var badge = document.createElement('span');
  badge.className = 'scroll-fab-badge';
  badge.textContent = '0';
  el.appendChild(badge);

  // Click handler
  function handleClick() {
    if (typeof opts.onClick === 'function') {
      opts.onClick();
    }
  }
  el.addEventListener('click', handleClick);

  function setBadge(count) {
    badge.textContent = String(count);
    if (count > 0) {
      badge.classList.add('visible');
    } else {
      badge.classList.remove('visible');
    }
  }

  function show() {
    el.classList.add('visible');
  }

  function hide() {
    el.classList.remove('visible');
  }

  function destroy() {
    el.removeEventListener('click', handleClick);
    el.remove();
  }

  return {
    el: el,
    setBadge: setBadge,
    show: show,
    hide: hide,
    destroy: destroy
  };
}

window.ChatUIComponents = {
  createSkeletonLoader,
  createThinkingTicker,
  createTimelineRail,
  createToolCard,
  createUserRequestCard,
  createScrollFAB
};
