import { action, el } from './lora_archives_ui.js';
import { DEFAULT_PRIMARY, DEFAULT_SECONDARY } from './lora_archives_state.js';

export function openArchiveCategoryMenu({ anchor, x, y, item, siblings, primaries, t, label, onRename, onReorder, onMove, onDelete, onClose }) {
  const root = el('div', 'lm-archive-category-menu-root');
  const menu = el('div', 'lm-popover lm-archive-category-menu');
  menu.tabIndex = -1;
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label(item));
  root.append(menu); document.body.append(root);
  let closed = false, submenu = null, moveButton = null;
  const protectedItem = [DEFAULT_PRIMARY, DEFAULT_SECONDARY].includes(item.id);
  const index = siblings.findIndex(value => value.id === item.id);
  const choices = panel => [...panel.querySelectorAll('button:not(:disabled)')];
  const hideSubmenu = () => { submenu?.remove(); submenu = null; moveButton?.setAttribute('aria-expanded', 'false'); };
  const close = (restoreFocus = false) => {
    if (closed) return;
    closed = true; root.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('contextmenu', outside, true);
    document.removeEventListener('scroll', scroll, true);
    window.removeEventListener('resize', dismiss);
    window.removeEventListener('blur', dismiss);
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    onClose?.();
  };
  const outside = event => { if (!root.contains(event.target)) close(); };
  const scroll = event => { if (!root.contains(event.target)) close(); };
  const dismiss = () => close();
  const position = (panel, left, top) => {
    panel.style.maxHeight = `${Math.max(60, window.innerHeight - 16)}px`;
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - rect.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))}px`;
  };
  const add = (key, callback, disabled = false) => {
    const button = action(t(key), () => { close(true); callback(); });
    button.setAttribute('role', 'menuitem'); button.disabled = disabled;
    button.addEventListener('pointerenter', hideSubmenu);
    menu.append(button); return button;
  };
  add('archiveRename', onRename);
  add('archiveMoveTop', () => onReorder(0), index <= 0);
  add('archiveMoveUp', () => onReorder(index - 1), index <= 0);
  add('archiveMoveDown', () => onReorder(index + 1), index >= siblings.length - 1);
  add('archiveMoveBottom', () => onReorder(siblings.length - 1), index >= siblings.length - 1);
  const showSubmenu = () => {
    if (submenu || moveButton.disabled) return;
    submenu = el('div', 'lm-popover lm-archive-category-menu');
    submenu.setAttribute('role', 'menu'); submenu.setAttribute('aria-label', t('archiveMoveToCategory'));
    for (const primary of primaries) {
      const button = action(label(primary), () => { close(true); onMove(primary.id); });
      button.setAttribute('role', 'menuitem'); button.disabled = primary.id === item.parentId;
      submenu.append(button);
    }
    root.append(submenu); moveButton.setAttribute('aria-expanded', 'true');
    const rect = menu.getBoundingClientRect(), owner = moveButton.getBoundingClientRect();
    const width = submenu.getBoundingClientRect().width;
    position(submenu, rect.right + width + 2 <= window.innerWidth - 8 ? rect.right + 2 : rect.left - width - 2, owner.top);
  };
  if (item.parentId !== null) {
    moveButton = action(t('archiveMoveToCategory'), () => { showSubmenu(); choices(submenu || menu)[0]?.focus(); });
    moveButton.setAttribute('role', 'menuitem'); moveButton.setAttribute('aria-haspopup', 'menu'); moveButton.setAttribute('aria-expanded', 'false');
    moveButton.disabled = protectedItem || !primaries.some(primary => primary.id !== item.parentId);
    if (protectedItem) moveButton.title = t('archiveProtected');
    moveButton.append(el('span', 'lm-archive-category-menu-arrow', '›'));
    moveButton.addEventListener('pointerenter', showSubmenu); menu.append(moveButton);
  }
  const remove = add('archiveDelete', onDelete, protectedItem);
  remove.classList.add('lm-archive-category-menu-delete');
  if (protectedItem) remove.title = t('archiveProtected');
  position(menu, x, y);
  root.addEventListener('pointerdown', event => event.stopPropagation());
  root.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); });
  root.addEventListener('keydown', event => {
    event.stopPropagation();
    const panel = event.target.closest('[role="menu"]');
    const buttons = choices(panel), current = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (event.key === 'Tab') close(true);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'ArrowRight' && document.activeElement === moveButton) {
      event.preventDefault(); showSubmenu(); if (submenu) choices(submenu)[0]?.focus();
    } else if (event.key === 'ArrowLeft' && panel === submenu) {
      event.preventDefault(); hideSubmenu(); moveButton.focus();
    }
  });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('contextmenu', outside, true);
  document.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss);
  (choices(menu)[0] || menu).focus({ preventScroll: true });
  return close;
}
