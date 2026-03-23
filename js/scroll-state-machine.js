/**
 * ScrollStateMachine — Three-state scroll manager: stuck → free → returning → stuck.
 *
 * States:
 *   'stuck'     — Auto-scrolling to bottom on new content.
 *   'free'      — User has scrolled away; new content increments unread count.
 *   'returning' — Smooth-scrolling back to bottom after FAB click or near-bottom scroll.
 *
 * Registered on window.ScrollStateMachine.
 */
class ScrollStateMachine {
  /**
   * @param {HTMLElement} container - The scrollable chat container
   * @param {Object} opts
   * @param {function(number): void} opts.onNewContentCount - Called with unread count when in free state
   */
  constructor(container, { onNewContentCount } = {}) {
    this._container = container;
    this._onNewContentCount = onNewContentCount || (() => {});

    this._state = 'stuck';
    this._unreadCount = 0;
    this._scrollThreshold = 50;
    this._returnThreshold = 30;
    this._resizeObserver = null;
    this._scrollendFallbackTimer = null;

    // Bind handlers for clean removal
    this._handleScroll = this._onScroll.bind(this);
    this._handleScrollend = null;

    // Set up passive scroll listener
    this._container.addEventListener('scroll', this._handleScroll, { passive: true });

    // Set up ResizeObserver on a sentinel element to detect content growth
    this._sentinel = document.createElement('div');
    this._sentinel.setAttribute('aria-hidden', 'true');
    this._sentinel.style.height = '0';
    this._sentinel.style.overflow = 'hidden';
    this._container.appendChild(this._sentinel);

    this._resizeObserver = new ResizeObserver(() => {
      this.notifyContentGrowth();
    });
    this._resizeObserver.observe(this._sentinel);
  }

  /** Get current state: 'stuck' | 'free' | 'returning' */
  get state() {
    return this._state;
  }

  /**
   * Check how far the container is from the bottom.
   * @returns {number} Distance in pixels from the bottom.
   * @private
   */
  _distanceFromBottom() {
    const { scrollHeight, scrollTop, clientHeight } = this._container;
    return scrollHeight - scrollTop - clientHeight;
  }

  /**
   * Passive scroll listener. Handles state transitions based on scroll position.
   * @private
   */
  _onScroll() {
    const dist = this._distanceFromBottom();

    if (this._state === 'stuck') {
      // User scrolled away from bottom
      if (dist > this._scrollThreshold) {
        this._state = 'free';
      }
    } else if (this._state === 'free') {
      // Auto-return: user scrolled back near bottom
      if (dist <= this._returnThreshold) {
        this._state = 'stuck';
        this._unreadCount = 0;
      }
    }
    // 'returning' state is managed by scrollToBottom — don't interfere
  }

  /**
   * Notify that content was added to the container.
   * If stuck, scrolls to bottom. If free, increments unread count.
   */
  notifyContentGrowth() {
    if (this._state === 'stuck') {
      this._container.scrollTop = this._container.scrollHeight;
    } else if (this._state === 'free') {
      this._unreadCount++;
      this._onNewContentCount(this._unreadCount);
    }
    // 'returning' — do nothing, smooth scroll is in progress
  }

  /**
   * Scroll to bottom (e.g. user clicked FAB).
   * Transitions to 'returning', smooth-scrolls, then transitions to 'stuck'.
   */
  scrollToBottom() {
    if (this._state === 'returning') return;

    this._state = 'returning';
    this._unreadCount = 0;

    this._container.scrollTo({
      top: this._container.scrollHeight,
      behavior: 'smooth'
    });

    // Listen for scrollend to finalize transition
    this._handleScrollend = () => {
      this._cleanupScrollend();
      this._state = 'stuck';
    };

    this._container.addEventListener('scrollend', this._handleScrollend, { once: true });

    // Fallback timeout in case scrollend doesn't fire (e.g. older browsers)
    this._scrollendFallbackTimer = setTimeout(() => {
      this._cleanupScrollend();
      this._state = 'stuck';
    }, 500);
  }

  /**
   * Clean up scrollend listener and fallback timer.
   * @private
   */
  _cleanupScrollend() {
    if (this._scrollendFallbackTimer) {
      clearTimeout(this._scrollendFallbackTimer);
      this._scrollendFallbackTimer = null;
    }
    if (this._handleScrollend) {
      this._container.removeEventListener('scrollend', this._handleScrollend);
      this._handleScrollend = null;
    }
  }

  /**
   * Destroy: disconnect ResizeObserver, remove scroll listener, remove sentinel.
   */
  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    this._cleanupScrollend();

    if (this._container) {
      this._container.removeEventListener('scroll', this._handleScroll);
      if (this._sentinel && this._sentinel.parentNode === this._container) {
        this._container.removeChild(this._sentinel);
      }
    }

    this._container = null;
    this._sentinel = null;
    this._onNewContentCount = null;
  }
}

window.ScrollStateMachine = ScrollStateMachine;
