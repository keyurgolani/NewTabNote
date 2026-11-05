/**
 * The block menus' roles and keys (#14 slice 4), under #24's menu pattern: a block's menu,
 * "Block actions", and its Turn into's types, "Turn into", each a menu of menu items. It's a
 * chunk of its own, which the page's loader loads at a menu's first open, by key or by click
 * (BlockEditor._menuKeys, App's loadMenuKeys), so the new tab's start holds none of it.
 *
 * - A menu a key opened (Mod+/ in a block's text, or Shift+F10 or the menu key on a divider's or
 *   an image's stop) takes focus on its first item. ArrowDown and ArrowUp move it, wrapping, Home
 *   and End go to the first and last items, and a letter to the next item whose name starts with
 *   it. Enter or Space chooses. On "Turn into...", ArrowRight, Enter or Space opens its types,
 *   with focus on the first, and there ArrowLeft or Escape goes back to it.
 * - Escape or Tab closes the menu and puts focus back where its key was pressed, with the
 *   selection it had. The menu takes the keys it answers first, so the app's close-all doesn't
 *   also run on its Escape. After a choice, focus goes back there too, or to the end of the
 *   block's text when a Turn into drew the block again, unless the choice put focus elsewhere,
 *   as a question does.
 * - A press on a menu takes no focus, so a click leaves focus where it was, as before.
 *
 * The items' icons and Turn into's arrow are hidden from the accessibility tree, so an item's
 * name is its words, which a letter finds it by.
 */

/**
 * Where focus goes back to from each block menu a key opened: where its key was pressed, the
 * selection then, and its block
 * @type {WeakMap<HTMLElement, {opener: HTMLElement, range: Range | null, id: string}>}
 */
const ways = new WeakMap();

/**
 * An item's name, lowercased: its words, without what's hidden from the accessibility tree
 * @param {HTMLElement} item
 * @returns {string}
 */
function nameOf(item) {
  return Array.from(item.children).filter((part) => !part.ariaHidden).map((part) => part.textContent).join('').trim().toLowerCase();
}

/**
 * Give `menu` its roles and keys: a block's menu, or with `item`, the Turn into item whose types
 * it lists
 * @param {any} editor - the BlockEditor that opened it
 * @param {HTMLElement} menu
 * @param {{opener?: HTMLElement, item?: HTMLElement}} how - the opener of a block's menu a key
 *   opened, or the types' item
 */
export function menuKeys(editor, menu, { opener, item }) {
  const doc = menu.ownerDocument;
  menu.role = 'menu';
  menu.ariaLabel = item ? 'Turn into' : 'Block actions';
  for (const child of /** @type {HTMLCollectionOf<HTMLElement>} */ (menu.children)) {
    if (!child.classList.contains('context-menu-item')) {
      child.role = 'separator';
      continue;
    }
    child.role = 'menuitem';
    child.tabIndex = -1;
    for (const part of child.querySelectorAll('.ai-action-icon, .turn-into-icon, .submenu-arrow')) part.ariaHidden = 'true';
    if (child.querySelector('.submenu-arrow')) {
      child.ariaHasPopup = 'menu';
      child.ariaExpanded = 'false';
    }
  }
  if (item) item.ariaExpanded = 'true';
  if (opener) {
    // The selection goes back only when it's the opener's: a stop's is often still the text above
    const selection = doc.getSelection();
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    ways.set(menu, { opener, range: range && opener.contains(range.startContainer) ? range.cloneRange() : null, id: menu.dataset.blockId || '' });
  }
  const way = ways.get(item ? /** @type {HTMLElement} */ (item.parentElement) : menu);

  /** Focus back where the menu's key was pressed, with its selection, or at the end of its block's text drawn again */
  const back = () => {
    if (!way) return;
    if (!way.opener.isConnected) {
      editor.focusBlock(way.id, true, true);
      return;
    }
    way.opener.focus();
    const selection = doc.getSelection();
    if (way.range && selection) {
      selection.removeAllRanges();
      selection.addRange(way.range);
    }
  };

  // A press takes no focus, so a click leaves it where it was, and the browser's own menu stays
  // shut over this one: on Windows the menu key opens it as the key comes up, on the focused item
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  // After a choice that closed the menu, by key or by pointer, focus goes back unless the choice
  // put it elsewhere. The item's own handler runs first: this looks a task later.
  menu.addEventListener('click', () => setTimeout(() => {
    if (!menu.isConnected && way && (!way.opener.isConnected || !doc.activeElement || doc.activeElement === doc.body)) back();
  }), true);
  menu.addEventListener('keydown', (e) => {
    const items = /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('[role="menuitem"]')));
    const at = items.indexOf(/** @type {HTMLElement} */ (doc.activeElement));
    const count = items.length;
    const { key } = e;
    let to = -1;
    if (key === 'ArrowDown') to = (at + 1) % count;
    else if (key === 'ArrowUp') to = (at < 1 ? count : at) - 1;
    else if (key === 'Home') to = 0;
    else if (key === 'End') to = count - 1;
    else if (key === 'Enter' || key === ' ' || (key === 'ArrowRight' && at >= 0 && items[at].ariaHasPopup)) {
      if (at >= 0) items[at].click();
    } else if (key === 'Escape' || key === 'Tab' || (key === 'ArrowLeft' && item)) {
      if (item && key !== 'Tab') {
        menu.remove();
        item.ariaExpanded = 'false';
        item.focus();
      } else {
        editor.hideBlockActionMenu();
        back();
      }
    } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const letter = key.toLowerCase();
      for (let step = 1; step <= count && to < 0; step++) {
        if (nameOf(items[(at + step) % count]).startsWith(letter)) to = (at + step) % count;
      }
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (to >= 0) items[to].focus();
  });

  const first = /** @type {HTMLElement | null} */ (menu.querySelector('[role="menuitem"]'));
  // focusVisible, since a menu opened by Mod+/ right after a click into the text would otherwise
  // show no ring: a modified key leaves the page out of keyboard modality. The DOM types this
  // TypeScript ships don't have the option yet.
  /** @type {FocusOptions & { focusVisible?: boolean }} */
  const visibly = { focusVisible: true };
  if (first && (item ? doc.activeElement === item : opener)) first.focus(visibly);
}
