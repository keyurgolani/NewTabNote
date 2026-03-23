/**
 * GraphView — force-directed graph rendering of notes and wiki-link connections.
 * Uses Canvas 2D for rendering. No external dependencies.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {EventBus} deps.eventBus
 * @param {Logger} deps.logger
 */
class GraphView {
  constructor({ storage, eventBus, logger }) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.logger = logger;

    this.isOpen = false;
    this.canvas = null;
    this.ctx = null;
    this.nodes = [];
    this.edges = [];
    this.animationId = null;

    // View transform
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    // Interaction state
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.hoveredNode = null;

    // Callbacks (set by App)
    this.onOpenNote = null;
    this.onGetSidebarOpen = null;
    this.onGetAISidebarOpen = null;

    // Bound handlers for cleanup
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onClick = this._handleClick.bind(this);
    this._onWheel = this._handleWheel.bind(this);
    this._onResize = this._handleResize.bind(this);
  }

  /** Initialize: bind DOM listeners. */
  async init() {
    const graphBtn = document.getElementById('sidebar-graph');
    if (graphBtn) {
      graphBtn.addEventListener('click', () => this.toggle());
    }
    const closeBtn = document.getElementById('graph-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggle());
    }
  }

  /** Tear down. */
  destroy() {
    this._stopRendering();
    this._removeCanvasListeners();
  }

  // ─── Toggle graph view ───

  /**
   * Toggle the graph view open/closed.
   */
  async toggle() {
    const panel = document.getElementById('graph-view-panel');
    const main = document.querySelector('main');
    const sidebar = document.getElementById('sidebar');
    const aiSidebar = document.getElementById('ai-sidebar');

    if (this.isOpen) {
      // Close
      this._stopRendering();
      this._removeCanvasListeners();
      panel.classList.add('hidden');
      panel.classList.remove('active');
      main.classList.remove('hidden');
      const sidebarOpen = this.onGetSidebarOpen ? this.onGetSidebarOpen() : true;
      const aiSidebarOpen = this.onGetAISidebarOpen ? this.onGetAISidebarOpen() : false;
      if (sidebarOpen) sidebar.classList.remove('hidden');
      if (aiSidebarOpen) aiSidebar.classList.remove('hidden');
      this.isOpen = false;
    } else {
      // Open
      this.isOpen = true;
      panel.classList.remove('hidden');
      setTimeout(() => panel.classList.add('active'), 10);
      main.classList.add('hidden');
      sidebar.classList.add('hidden');
      aiSidebar.classList.add('hidden');

      await this._buildGraph();
      this._initCanvas();
      this._runLayout();
      this._startRendering();
    }
  }

  // ─── Data loading ───

  /**
   * Build nodes and edges from notes and links.
   */
  async _buildGraph() {
    const notes = await this.storage.getAllNotes(true);
    const links = await new Promise((resolve, reject) => {
      const store = this.storage.getStore('links');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    // Build node map
    const nodeMap = new Map();
    notes.forEach(note => {
      nodeMap.set(note.id, {
        id: note.id,
        label: note.name || 'Untitled',
        x: Math.random() * 600 - 300,
        y: Math.random() * 600 - 300,
        vx: 0,
        vy: 0,
        connections: 0,
      });
    });

    // Build edges and count connections
    this.edges = [];
    links.forEach(link => {
      const from = nodeMap.get(link.fromNoteId);
      const to = nodeMap.get(link.toNoteId);
      if (from && to && link.fromNoteId !== link.toNoteId) {
        this.edges.push({ from: link.fromNoteId, to: link.toNoteId });
        from.connections++;
        to.connections++;
      }
    });

    this.nodes = Array.from(nodeMap.values());
  }

  // ─── Canvas setup ───

  _initCanvas() {
    this.canvas = document.getElementById('graph-canvas');
    if (!this.canvas) return;

    this._handleResize();
    this.ctx = this.canvas.getContext('2d');

    // Reset view
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    this._addCanvasListeners();
  }

  _addCanvasListeners() {
    if (!this.canvas) return;
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('click', this._onClick);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('resize', this._onResize);
  }

  _removeCanvasListeners() {
    if (!this.canvas) return;
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('click', this._onClick);
    this.canvas.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('resize', this._onResize);
  }

  _handleResize() {
    if (!this.canvas) return;
    const container = this.canvas.parentElement;
    this.canvas.width = container.clientWidth;
    this.canvas.height = container.clientHeight;
  }

  // ─── Force-directed layout ───

  /**
   * Run force simulation for a fixed number of iterations.
   */
  _runLayout() {
    const iterations = 300;
    for (let i = 0; i < iterations; i++) {
      const alpha = 1 - i / iterations; // cooling
      this._simulateStep(alpha);
    }
    // Zero out velocities
    this.nodes.forEach(n => { n.vx = 0; n.vy = 0; });
    this._centerGraph();
  }

  /**
   * Single simulation step: repulsion between all nodes, attraction along edges.
   * @param {number} alpha - Cooling factor (1 → 0)
   */
  _simulateStep(alpha) {
    const repulsion = 5000;
    const attraction = 0.01;
    const damping = 0.9;

    // Repulsion between all node pairs
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (repulsion * alpha) / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // Attraction along edges
    const nodeById = new Map(this.nodes.map(n => [n.id, n]));
    this.edges.forEach(edge => {
      const a = nodeById.get(edge.from);
      const b = nodeById.get(edge.to);
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = dist * attraction * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    });

    // Apply velocities with damping
    this.nodes.forEach(n => {
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
    });
  }

  /**
   * Center the graph in the viewport.
   */
  _centerGraph() {
    if (this.nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.nodes.forEach(n => {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    });
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.offsetX = -cx;
    this.offsetY = -cy;

    // Auto-fit scale
    if (this.canvas) {
      const graphW = maxX - minX + 100;
      const graphH = maxY - minY + 100;
      const scaleX = this.canvas.width / graphW;
      const scaleY = this.canvas.height / graphH;
      this.scale = Math.min(scaleX, scaleY, 2);
      this.scale = Math.max(this.scale, 0.1);
    }
  }

  // ─── Rendering ───

  _startRendering() {
    this._draw();
  }

  _stopRendering() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  _draw() {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Get theme colors
    const style = getComputedStyle(document.documentElement);
    const bgColor = style.getPropertyValue('--bg-primary').trim() || '#ffffff';
    const textColor = style.getPropertyValue('--text-primary').trim() || '#333333';
    const accentColor = style.getPropertyValue('--accent-primary').trim() || '#4d9eff';
    const borderColor = style.getPropertyValue('--border-color').trim() || '#e0e0e0';

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.offsetX, this.offsetY);

    const nodeById = new Map(this.nodes.map(n => [n.id, n]));

    // Draw edges
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1 / this.scale;
    this.edges.forEach(edge => {
      const a = nodeById.get(edge.from);
      const b = nodeById.get(edge.to);
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });

    // Draw nodes
    const maxConn = Math.max(1, ...this.nodes.map(n => n.connections));
    this.nodes.forEach(node => {
      const baseRadius = 6;
      const maxRadius = 20;
      const radius = baseRadius + (node.connections / maxConn) * (maxRadius - baseRadius);

      const isHovered = this.hoveredNode && this.hoveredNode.id === node.id;

      // Node circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isHovered ? accentColor : (node.connections > 0 ? accentColor : borderColor);
      ctx.globalAlpha = isHovered ? 1 : 0.8;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Label
      const fontSize = Math.max(10, 12 / this.scale);
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.label, node.x, node.y + radius + 4);
    });

    ctx.restore();

    // Draw info text
    ctx.fillStyle = textColor;
    ctx.globalAlpha = 0.5;
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${this.nodes.length} notes · ${this.edges.length} links`, 16, h - 16);
    ctx.globalAlpha = 1;
  }

  // ─── Interaction handlers ───

  /**
   * Convert screen coordinates to graph coordinates.
   * @param {number} screenX
   * @param {number} screenY
   * @returns {{x: number, y: number}}
   */
  _screenToGraph(screenX, screenY) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    return {
      x: (screenX - w / 2) / this.scale - this.offsetX,
      y: (screenY - h / 2) / this.scale - this.offsetY,
    };
  }

  /**
   * Find the node under the given screen coordinates.
   * @param {number} screenX
   * @param {number} screenY
   * @returns {Object|null}
   */
  _hitTest(screenX, screenY) {
    const { x, y } = this._screenToGraph(screenX, screenY);
    const maxConn = Math.max(1, ...this.nodes.map(n => n.connections));
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      const radius = 6 + (node.connections / maxConn) * 14;
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy <= radius * radius) {
        return node;
      }
    }
    return null;
  }

  _handleMouseDown(e) {
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
  }

  _handleMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (this.isDragging) {
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      this.offsetX += dx / this.scale;
      this.offsetY += dy / this.scale;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this._draw();
    }

    // Hover detection
    const node = this._hitTest(x, y);
    if (node !== this.hoveredNode) {
      this.hoveredNode = node;
      this.canvas.style.cursor = node ? 'pointer' : 'grab';
      this._draw();
    }
  }

  _handleMouseUp() {
    this.isDragging = false;
  }

  _handleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = this._hitTest(x, y);
    if (node && this.onOpenNote) {
      this.toggle(); // close graph view
      this.onOpenNote(node.id);
    }
  }

  _handleWheel(e) {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    this.scale *= zoomFactor;
    this.scale = Math.max(0.1, Math.min(5, this.scale));
    this._draw();
  }
}

// Dual CommonJS/browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GraphView };
} else if (typeof window !== 'undefined') {
  window.GraphView = GraphView;
}
