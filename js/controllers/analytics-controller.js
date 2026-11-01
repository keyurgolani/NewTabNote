/**
 * AnalyticsController — manages the stats dashboard rendering,
 * chart initialization, and data aggregation from notes/folders.
 *
 * @param {Object} deps
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 * @param {((name: string) => Promise<any>)|null} [deps.loadLibrary] - The page loader's
 *   (js/runtime/lazy.js), which Chart.js loads through at the first Stats (#27 slice 3). Without
 *   it, Chart.js is the global its script defined, as before.
 * @param {any} [deps.partReload] - App's guarded Reload for the charts' failure (App.partReload,
 *   js/ui/part-state.js); null for the browser's
 */
class AnalyticsController {
  constructor({ domRefs, logger, loadLibrary = null, partReload = null }) {
    this.domRefs = domRefs;
    this.logger = logger;
    this.loadLibrary = loadLibrary;
    this.partReload = partReload;
    /** @type {any} The charts' place's state (#27 slice 3b), made at init with its live region */
    this.chartsPart = undefined;

    // Analytics state
    this.statsOpen = false;
    this.charts = {};

    /** @type {any} The tab's note list (js/kernel/core/application/note-list.js), set by App */
    this.noteList = null;

    // App-level callbacks (set by App after construction)
    this.onGetSidebarOpen = null;
    this.onGetAISidebarOpen = null;
  }

  /**
   * The active notes, as the note list lists them
   * @returns {ReadonlyArray<any>}
   */
  get notes() {
    return this.noteList ? this.noteList.view('active') : [];
  }

  /** @returns {ReadonlyArray<any>} */
  get folders() {
    return this.noteList ? this.noteList.folders() : [];
  }

  /** Initialize: wire DOM listeners for stats dashboard. */
  async init() {
    this._bindStatsListeners();
  }

  /** Tear down: destroy chart instances. */
  destroy() {
    Object.values(this.charts).forEach(chart => chart.destroy());
    this.charts = {};
  }

  // ─── Private: bind stats button listeners ───

  _bindStatsListeners() {
    const statsBtn = document.getElementById('sidebar-stats');
    if (statsBtn) {
      statsBtn.addEventListener('click', () => this.toggleStats());
    }
    const statsCloseBtn = document.getElementById('stats-close-btn');
    if (statsCloseBtn) {
      statsCloseBtn.addEventListener('click', () => this.toggleStats());
    }
    // Its live region goes on the page now, before it has anything to say
    this.chartsPlace();
  }

  /**
   * Where the four charts go says how Chart.js's load went (#27 slice 3b, js/ui/part-state.js):
   * one failure for the four, in their place and at their width, with the counts kept, or their
   * status line once the load has run 400 ms. Null without the dashboard's markup.
   * @returns {any}
   */
  chartsPlace() {
    if (this.chartsPart !== undefined) return this.chartsPart;
    const dashboard = document.getElementById('stats-dashboard');
    const grid = dashboard ? dashboard.querySelector('.charts-grid') : null;
    if (!grid || typeof PartState === 'undefined') {
      this.chartsPart = null;
      return null;
    }
    const cards = () => /** @type {HTMLElement[]} */ (Array.from(grid.children)).filter((child) => !child.classList.contains('part-state'));
    this.chartsPart = new PartState({
      doc: document,
      words: PART_WORDS.charts,
      live: dashboard,
      place: (/** @type {HTMLElement | null} */ element) => {
        for (const card of cards()) card.style.display = element ? 'none' : '';
        const drawn = this.chartsPart.element;
        if (element && element.parentNode !== grid) grid.appendChild(element);
        if (!element && drawn && drawn.parentNode) drawn.remove();
      },
      reload: this.partReload,
      loaded: (/** @type {any} */ result) => this.drawCharts(result.module),
      // Try again worked: focus goes to the first chart's heading
      focusAfter: () => {
        const heading = grid.querySelector('h3');
        if (heading) heading.setAttribute('tabindex', '-1');
        return heading;
      },
    });
    return this.chartsPart;
  }

  // ─── Toggle stats dashboard ───

  /**
   * Toggle the statistics dashboard open/closed.
   */
  async toggleStats() {
    const dashboard = document.getElementById('stats-dashboard');
    const main = document.querySelector('main');
    const sidebar = document.getElementById('sidebar');
    const aiSidebar = document.getElementById('ai-sidebar');

    if (this.statsOpen) {
      // Closing stats
      dashboard.classList.add('hidden');
      dashboard.classList.remove('active');
      main.classList.remove('hidden');
      const sidebarOpen = this.onGetSidebarOpen ? this.onGetSidebarOpen() : true;
      const aiSidebarOpen = this.onGetAISidebarOpen ? this.onGetAISidebarOpen() : false;
      if (sidebarOpen) sidebar.classList.remove('hidden');
      if (aiSidebarOpen) aiSidebar.classList.remove('hidden');
      this.statsOpen = false;
    } else {
      // Opening stats
      this.statsOpen = true;
      dashboard.classList.remove('hidden');
      setTimeout(() => dashboard.classList.add('active'), 10);
      main.classList.add('hidden');
      sidebar.classList.add('hidden');
      aiSidebar.classList.add('hidden');

      await this.renderAnalytics();
    }
  }

  // ─── Render analytics ───

  /**
   * Render analytics charts and stats.
   */
  async renderAnalytics() {
    if (typeof Analytics === 'undefined') return;
    // Chart.js loads at the first Stats, while the counts are read (#27 slice 3), through the
    // charts' place, which draws them once the counts are read or says how the load went (#27
    // slice 3b). The loader's answer never rejects.
    /** @type {() => void} */
    let countsRead = () => {};
    this.countsRead = new Promise((resolve) => { countsRead = () => resolve(undefined); });
    const load = () => (this.loadLibrary ? this.loadLibrary('chart') : Promise.resolve({ status: 'loaded', module: Chart }));
    const place = this.chartsPlace();
    const charts = place
      ? place.load(load)
      : load().then((/** @type {any} */ result) => (result.status === 'loaded' ? this.drawCharts(result.module) : null));

    // The note list reads every list again first, so the stats count what's stored, other
    // tabs' notes included, as they did when they read storage
    if (this.noteList) await this.noteList.reload();

    // Show loading state or refresh counts
    const stats = await Analytics.getGlobalStats();
    document.getElementById('stat-total-notes').textContent = stats.totalNotes;
    document.getElementById('stat-total-words').textContent = stats.totalWords.toLocaleString();

    const dailyNotes = this.notes.filter(n => n.name && /^\d{4}-\d{2}-\d{2}$/.test(n.name));
    document.getElementById('stat-daily-notes').textContent = dailyNotes.length;

    const allText = this.notes.map(n => n.name).join(' ');
    const tags = Analytics.extractTags(allText);
    document.getElementById('stat-active-tags').textContent = tags.length;
    countsRead();
    await charts;
  }

  /**
   * Draw the four charts with Chart.js, in place of the ones drawn before, once this Stats' counts
   * are read, since the charts read the same lists
   * @param {any} ChartLibrary
   * @returns {Promise<void>}
   */
  async drawCharts(ChartLibrary) {
    if (this.countsRead) await this.countsRead;
    // Destroy existing charts to prevent memory leaks/overlap
    Object.values(this.charts).forEach(chart => chart.destroy());

    // 1. Activity Chart
    const activityData = await Analytics.getActivityData(30);
    this.charts.activity = new ChartLibrary(document.getElementById('activity-chart'), {
      type: 'line',
      data: {
        labels: activityData.map(d => d.date),
        datasets: [{
          label: 'Updates',
          data: activityData.map(d => d.updated),
          borderColor: '#4d9eff',
          backgroundColor: 'rgba(77, 158, 255, 0.1)',
          fill: true,
          tension: 0.4
        }, {
          label: 'Created',
          data: activityData.map(d => d.created),
          borderColor: '#8e44ad',
          backgroundColor: 'rgba(142, 68, 173, 0.1)',
          fill: true,
          tension: 0.4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });

    // 2. Content Type Chart
    const typeBreakdown = await Analytics.getContentTypeBreakdown();
    this.charts.type = new ChartLibrary(document.getElementById('content-chart'), {
      type: 'doughnut',
      data: {
        labels: Object.keys(typeBreakdown),
        datasets: [{
          data: Object.values(typeBreakdown),
          backgroundColor: ['#4d9eff', '#27ae60', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#34495e']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } }
      }
    });

    // 3. Tags Chart
    const topTags = await Analytics.getTagDistribution();
    this.charts.tags = new ChartLibrary(document.getElementById('tags-chart'), {
      type: 'bar',
      data: {
        labels: topTags.map(t => t[0]),
        datasets: [{
          label: 'Usage Count',
          data: topTags.map(t => t[1]),
          backgroundColor: '#4d9eff'
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } }
      }
    });

    // 4. Folders Chart
    const folderStats = this.folders.map(f => ({
      name: f.name,
      count: this.notes.filter(n => n.folderId === f.id).length
    })).sort((a, b) => b.count - a.count).slice(0, 7);

    this.charts.folders = new ChartLibrary(document.getElementById('folders-chart'), {
      type: 'polarArea',
      data: {
        labels: folderStats.map(f => f.name),
        datasets: [{
          data: folderStats.map(f => f.count),
          backgroundColor: ['rgba(77, 158, 255, 0.6)', 'rgba(46, 204, 113, 0.6)', 'rgba(231, 76, 60, 0.6)', 'rgba(241, 196, 15, 0.6)']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } }
      }
    });
  }
}

// Dual CommonJS/browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AnalyticsController };
} else if (typeof window !== 'undefined') {
  window.AnalyticsController = AnalyticsController;
}
