/**
 * Virtual Scroller - efficiently renders long lists by only rendering visible items
 */
class VirtualScroller {
  constructor(options) {
    this.container = options.container;     // The scrollable container
    this.itemHeight = options.itemHeight;   // Fixed height of each item
    this.renderItem = options.renderItem;   // Function to create DOM element for an item
    this.items = options.items || [];       // All items to render
    this.buffer = options.buffer || 3;      // Number of extra items to render above/below
    
    this.onScroll = this.onScroll.bind(this);
    this.init();
  }

  init() {
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'virtual-scroller-wrapper';
    this.wrapper.style.position = 'relative';
    this.wrapper.style.width = '100%';
    
    // Clear and setup container
    this.container.innerHTML = '';
    this.container.appendChild(this.wrapper);
    this.container.addEventListener('scroll', this.onScroll);
    
    this.update();
  }

  setItems(items) {
    this.items = items;
    this.update();
  }

  onScroll() {
    requestAnimationFrame(() => this.update());
  }

  update() {
    const totalItems = this.items.length;
    const containerHeight = this.container.clientHeight;
    const scrollTop = this.container.scrollTop;
    
    // Set total wrapper height
    this.wrapper.style.height = `${totalItems * this.itemHeight}px`;
    
    // Calculate visible range
    let startIdx = Math.floor(scrollTop / this.itemHeight) - this.buffer;
    let endIdx = Math.ceil((scrollTop + containerHeight) / this.itemHeight) + this.buffer;
    
    // Clamp range
    startIdx = Math.max(0, startIdx);
    endIdx = Math.min(totalItems, endIdx);
    
    // Clear wrapper and render only visible items
    this.wrapper.innerHTML = '';
    
    for (let i = startIdx; i < endIdx; i++) {
        const itemData = this.items[i];
        const itemEl = this.renderItem(itemData, i);
        
        itemEl.style.position = 'absolute';
        itemEl.style.top = `${i * this.itemHeight}px`;
        itemEl.style.left = '0';
        itemEl.style.right = '0';
        itemEl.style.height = `${this.itemHeight}px`;
        
        this.wrapper.appendChild(itemEl);
    }
  }

  refresh() {
    this.update();
  }

  destroy() {
    this.container.removeEventListener('scroll', this.onScroll);
  }
}

window.VirtualScroller = VirtualScroller;
