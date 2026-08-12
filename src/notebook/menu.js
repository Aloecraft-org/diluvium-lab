// The menu bar, and the dropdown machinery everything else with a ▾ shares.
//
// Data-driven: a menu is a label and a list of items, an item is a label
// and a function. The File/Edit/View/Help definitions render twice -- the
// desktop menu bar and the narrow-screen drawer -- which is what keeps
// those two from drifting apart. The split buttons in the action row
// define their own items but ride the same dropdown machinery, so open,
// close, keyboard and positioning are one behaviour everywhere.
//
// Items are re-rendered every time a menu opens, so `enabled`, `checked`
// and `label` may be functions evaluated at open time -- the same
// no-retained-DOM rule the tool panel uses, and for the same reason:
// nothing to keep in step, nothing to leak.
//
// Keyboard behaviour follows the WAI-ARIA menubar pattern as far as it
// usefully goes: arrows move, Enter/Space activates, Escape closes and
// returns focus, left/right walks adjacent menus while one is open.

import { el } from './dom.js';

/** One place turns an item definition into a DOM row, for every surface. */
function itemNode(document_, item, close, { tabbable = false } = {}) {
  if (item.sep) return el('div', { class: 'menu-sep', role: 'separator' });

  const label = typeof item.label === 'function' ? item.label() : item.label;
  const enabled = item.enabled ? item.enabled() !== false : true;
  const checked = item.checked ? item.checked() === true : null;

  const attrs = {
    type: 'button',
    class: 'menu-item',
    role: checked === null ? 'menuitem' : 'menuitemcheckbox',
    // Dropdowns rove focus with the arrow keys; the drawer has no such
    // machinery, so its items must be ordinarily tabbable or a keyboard
    // cannot reach them at all.
    tabindex: tabbable ? '0' : '-1',
  };
  if (item.toolbar) attrs['data-toolbar'] = item.toolbar;
  if (checked !== null) attrs['aria-checked'] = String(checked);
  if (!enabled) attrs['aria-disabled'] = 'true';
  if (item.title) attrs.title = item.title;

  const kids = [el('span', { class: 'menu-label' }, [label])];
  if (item.accel) kids.push(el('span', { class: 'menu-accel' }, [item.accel]));

  const node = el('button', attrs, kids);
  node.addEventListener('click', () => {
    if (!enabled) return;
    // Refocus the opener, or activation drops keyboard focus to <body>.
    // An action that opens a dialog moves focus again immediately, which
    // is fine -- the dialog gives it back on close.
    close({ refocus: true });
    item.run?.();
  });
  return node;
}

/**
 * Attach a dropdown to a button. `itemsFn` is called on every open, so
 * the items can reflect current state. Used by the menu bar's labels and
 * by the split buttons in the action row -- one dropdown, one behaviour.
 *
 * Returns { open, close, isOpen } so a menu bar can coordinate several.
 */
export function attachDropdown(button, itemsFn, { onClose } = {}) {
  const document_ = button.ownerDocument;
  const menu = el('div', { class: 'menu-pop', role: 'menu', hidden: true });
  button.insertAdjacentElement('afterend', menu);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');

  let outside = null;

  const close = ({ refocus = false } = {}) => {
    if (menu.hidden) return;
    menu.hidden = true;
    // Emptied as well as hidden: two dropdowns may offer the same
    // data-toolbar item, and a stale hidden copy would make that name
    // ambiguous to anything that queries by it.
    menu.replaceChildren();
    button.setAttribute('aria-expanded', 'false');
    document_.removeEventListener('pointerdown', outside, true);
    if (refocus) button.focus();
    onClose?.();
  };

  const open = () => {
    if (!menu.hidden) return;
    menu.replaceChildren(...itemsFn().map((item) => itemNode(document_, item, close)));
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // Under the button, left-aligned -- unless that runs off the right of
    // the viewport (the kernel split lives at the far edge), in which case
    // right-aligned to the button instead.
    const anchor = button.getBoundingClientRect();
    const host = menu.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0, right: 0 };
    menu.style.left = `${anchor.left - host.left}px`;
    menu.style.top = `${anchor.bottom - host.top + 2}px`;
    const width = menu.getBoundingClientRect().width;
    if (anchor.left + width > document_.defaultView.innerWidth - 8) {
      menu.style.left = `${Math.max(0, anchor.right - host.left - width)}px`;
    }
    outside = (event) => {
      if (!menu.contains(event.target) && event.target !== button) close();
    };
    document_.addEventListener('pointerdown', outside, true);
  };

  const focusable = () => [...menu.querySelectorAll('.menu-item')];

  const move = (delta) => {
    const items = focusable();
    if (!items.length) return;
    const at = items.indexOf(document_.activeElement);
    const next = at === -1
      ? (delta > 0 ? 0 : items.length - 1)
      : (at + delta + items.length) % items.length;
    items[next].focus();
  };

  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
      focusable()[0]?.focus();
    } else if (event.key === 'Escape' && !menu.hidden) {
      // Focus stays on the label after a mouse click, so Escape has to
      // work from there too, not only from inside the menu.
      event.preventDefault();
      close();
    }
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Escape') { event.preventDefault(); close({ refocus: true }); }
    else if (event.key === 'Tab') close();
  });

  return { open, close, isOpen: () => !menu.hidden, button, menu };
}

/**
 * The menu bar: one dropdown per menu, plus the bar-level behaviour that
 * makes separate dropdowns feel like one control -- while any menu is
 * open, pointing at another label opens it, and ArrowLeft/Right walk
 * between them.
 *
 * @param {Element} container the [data-menubar] element
 * @param {() => {label: string, items: () => object[]}[]} menusFn
 */
export function renderMenuBar(container, menus) {
  const controls = [];
  const closeAll = (except) => {
    for (const c of controls) if (c !== except) c.close();
  };
  // The hover-walk can open a menu while focus stays on another label, so
  // Escape has to work at the bar, not only per-button.
  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && controls.some((c) => c.isOpen())) {
      event.preventDefault();
      closeAll();
    }
  });

  for (const menu of menus) {
    const button = el('button', {
      type: 'button', class: 'menu-top', 'data-menu': menu.label.toLowerCase(),
    }, [menu.label]);
    container.append(button);
    const control = attachDropdown(button, menu.items);
    controls.push(control);

    const openOnly = () => { closeAll(control); control.open(); };
    button.addEventListener('click', () => closeAll(control));
    button.addEventListener('pointerenter', () => {
      if (controls.some((c) => c.isOpen()) && !control.isOpen()) openOnly();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const at = controls.indexOf(control);
        const next = controls[(at + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length];
        const wasOpen = control.isOpen();
        closeAll();
        next.button.focus();
        if (wasOpen) next.open();
      }
    });
    control.menu.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const at = controls.indexOf(control);
        const next = controls[(at + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length];
        closeAll();
        next.open();
        next.button.focus();
      }
    });
  }
  return { closeAll };
}

/**
 * The same menus, rendered as a drawer for narrow screens: each menu is a
 * headed group of the same items, inside a <dialog> the hamburger opens.
 * Rendered fresh on every open, like everything else here.
 */
export function renderDrawer(dialog, menus, extraItems = []) {
  const document_ = dialog.ownerDocument;
  const body = dialog.querySelector('[data-drawer-body]');
  const close = () => dialog.close();
  body.replaceChildren(
    ...extraItems.map((item) => itemNode(document_, item, close, { tabbable: true })),
    ...menus.flatMap((menu) => [
      el('div', { class: 'drawer-head' }, [menu.label]),
      ...menu.items().filter((i) => !i.sep).map((item) => itemNode(document_, item, close, { tabbable: true })),
    ]),
  );
}
