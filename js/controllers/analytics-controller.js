/**
 * AnalyticsController — manages the stats dashboard rendering,
 * chart initialization, and data aggregation from notes/folders.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {EventBus} deps.eventBus
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 */
class AnalyticsController {
  constructor({ storage, eventBus, domRefs, logger }) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.domRefs = domRefs;
    this.logger = logger;

    // Analytics state
    this.statsOpen = false;
    this.charts = {};

    // Data arrays (synced from App)
    this.notes = [];
    this.folders = [];

    // App-level callbacks (set by App after construction)
    this.onGetSidebarOpen = null;
    this.onGetAISidebarOpen = null;
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

    // Show loading state or refresh counts
    const stats = await Analytics.getGlobalStats();
    document.getElementById('stat-total-notes').textContent = stats.totalNotes;
    document.getElementById('stat-total-words').textContent = stats.totalWords.toLocaleString();

    const dailyNotes = this.notes.filter(n => n.name && /^\d{4}-\d{2}-\d{2}$/.test(n.name));
    document.getElementById('stat-daily-notes').textContent = dailyNotes.length;

    const allText = this.notes.map(n => n.name).join(' ');
    const tags = Analytics.extractTags(allText);
    document.getElementById('stat-active-tags').textContent = tags.length;

    // Destroy existing charts to prevent memory leaks/overlap
    Object.values(this.charts).forEach(chart => chart.destroy());

    // 1. Activity Chart
    const activityData = await Analytics.getActivityData(30);
    this.charts.activity = new Chart(document.getElementById('activity-chart'), {
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
    this.charts.type = new Chart(document.getElementById('content-chart'), {
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
    this.charts.tags = new Chart(document.getElementById('tags-chart'), {
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

    this.charts.folders = new Chart(document.getElementById('folders-chart'), {
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
