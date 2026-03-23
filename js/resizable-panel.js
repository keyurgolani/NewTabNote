(function (global) {
  /**
   * Clamp a value between min and max.
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Calculate the new panel width during a resize operation.
   * @param {Object} params - Calculation parameters
   * @param {number} params.startWidth - Width at drag start
   * @param {number} params.startX - Mouse X at drag start
   * @param {number} params.currentX - Current mouse X
   * @param {number} params.min - Minimum width
   * @param {number} params.max - Maximum width
   * @param {'left'|'right'} [params.direction='right'] - Resize direction
   * @returns {number} Clamped panel width
   */
  function calculatePanelWidth({
    startWidth,
    startX,
    currentX,
    min,
    max,
    direction = 'right',
  }) {
    const delta = direction === 'left'
      ? startX - currentX
      : currentX - startX;

    return clamp(startWidth + delta, min, max);
  }

  class ResizablePanel {
    constructor({
      panel,
      handle,
      min,
      max,
      direction = 'right',
      doc = typeof document !== 'undefined' ? document : null,
      onResize,
      onResizeEnd,
    }) {
      this.panel = panel;
      this.handle = handle;
      this.min = min;
      this.max = max;
      this.direction = direction;
      this.doc = doc;
      this.onResize = onResize;
      this.onResizeEnd = onResizeEnd;
      this.isResizing = false;
      this.startX = 0;
      this.startWidth = 0;

      this.handleMouseDown = this.handleMouseDown.bind(this);
      this.handleMouseMove = this.handleMouseMove.bind(this);
      this.handleMouseUp = this.handleMouseUp.bind(this);

      this.attach();
    }

    attach() {
      if (!this.panel || !this.handle || !this.doc) {
        return;
      }

      this.handle.addEventListener('mousedown', this.handleMouseDown);
      this.doc.addEventListener('mousemove', this.handleMouseMove);
      this.doc.addEventListener('mouseup', this.handleMouseUp);
    }

    destroy() {
      if (!this.handle || !this.doc) {
        return;
      }

      this.handle.removeEventListener('mousedown', this.handleMouseDown);
      this.doc.removeEventListener('mousemove', this.handleMouseMove);
      this.doc.removeEventListener('mouseup', this.handleMouseUp);
    }

    handleMouseDown(event) {
      if (event.button !== 0 || !this.panel) {
        return;
      }

      this.isResizing = true;
      this.startX = event.clientX;
      this.startWidth = this.panel.offsetWidth;

      this.panel.classList.add('resizing');
      this.handle.classList.add('dragging');

      if (this.doc.body) {
        this.doc.body.style.cursor = 'col-resize';
        this.doc.body.style.userSelect = 'none';
      }

      event.preventDefault();
    }

    handleMouseMove(event) {
      if (!this.isResizing || !this.panel) {
        return;
      }

      const width = calculatePanelWidth({
        startWidth: this.startWidth,
        startX: this.startX,
        currentX: event.clientX,
        min: this.min,
        max: this.max,
        direction: this.direction,
      });

      this.panel.style.width = `${width}px`;

      if (typeof this.onResize === 'function') {
        this.onResize(width);
      }
    }

    async handleMouseUp() {
      if (!this.isResizing || !this.panel) {
        return;
      }

      this.isResizing = false;
      this.panel.classList.remove('resizing');
      this.handle.classList.remove('dragging');

      if (this.doc.body) {
        this.doc.body.style.cursor = '';
        this.doc.body.style.userSelect = '';
      }

      if (typeof this.onResizeEnd === 'function') {
        await this.onResizeEnd(this.panel.offsetWidth);
      }
    }
  }

  const api = {
    ResizablePanel,
    calculatePanelWidth,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.ResizablePanel = ResizablePanel;
  global.calculatePanelWidth = calculatePanelWidth;
})(typeof window !== 'undefined' ? window : globalThis);
