import { ordered, activeArchiveEntries } from './lora_archives_state.js';
import { categoryLabel } from './lora_archives_manager.js';
import { el, action, archiveDialog } from './lora_archives_ui.js';

export function openArchiveCascade({ anchor, client, t, currentId, onChoose, onClose }) {
  const root = el('div', 'lm-archive-cascade');
  const panels = [];
  const lifetime = new AbortController();
  let confirming = false, pendingRefresh = false;
  let closed = false;
  function trim(level) {
    while (panels.length > level) {
      const panel = panels.pop(); panel.owner?.setAttribute('aria-expanded', 'false'); panel.remove();
    }
  }
  function close() {
    if (closed) return;
    closed = true; lifetime.abort(); trim(0); root.remove(); unsubscribe();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('scroll', scroll, true);
    window.removeEventListener('resize', close);
    onClose();
  }
  function outside(event) { if (!confirming && !root.contains(event.target) && !anchor.contains(event.target)) close(); }
  function scroll(event) {
    if (confirming) return;
    const panel = panels.find(item => item === event.target);
    if (panel) trim(panels.indexOf(panel) + 1);
    else if (!root.contains(event.target)) close();
  }
  function show(level, owner, parentId) {
    if (panels[level]?.owner === owner) return;
    trim(level);
    owner.setAttribute('aria-expanded', 'true');
    const panel = el('div', 'lm-popover lm-archive-picker'); panel.dataset.level = level; panel.owner = owner;
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', t(['archivePrimary', 'archiveSecondary', 'archiveList'][level]));
    const items = ordered(level === 2 ? client.data.archives.filter(item => item.categoryId === parentId)
      : client.data.categories.filter(item => item.parentId === parentId));
    for (const item of items) {
      const row = action('', () => {
        if (confirming) return;
        if (level === 2) { close(); anchor.focus(); onChoose(item); }
        else if (panels[level + 1]?.owner === row) { trim(level + 1); row.focus(); }
        else { show(level + 1, row, item.id); panels[level + 1]?.querySelector('[data-choice]')?.focus(); }
      });
      row.dataset.choice = item.id; row.setAttribute('role', 'menuitem');
      row.setAttribute('aria-label', level === 2 ? item.name : categoryLabel(item, t));
      if (level < 2) {
        row.append(el('span', '', categoryLabel(item, t)));
        row.append(el('span', 'lm-archive-cascade-arrow', '›'));
        row.setAttribute('aria-haspopup', 'menu'); row.setAttribute('aria-expanded', 'false');
        row.addEventListener('pointerenter', () => {
          if (confirming) return;
          // On narrow viewports use explicit selection instead of covering the hovered row.
          const rect = panel.getBoundingClientRect();
          if (window.innerWidth - rect.right >= 198 || rect.left >= 198) show(level + 1, row, item.id);
        });
        panel.append(row);
      } else {
        const entries = activeArchiveEntries(item.snapshot);
        const title = el('span', 'lm-archive-cascade-title');
        title.append(el('strong', '', item.name), el('span', '', `(${entries.length})`));
        const summary = entries.map(entry => `${entry.name.split(/[\\/]/).pop()} · Model ${Number(entry.strength)} / CLIP ${Number(entry.clipStrength ?? entry.strength)}`).join(', ') || t('archiveNoActive');
        const subtitle = el('span', 'lm-archive-cascade-summary', summary); subtitle.title = summary;
        row.classList.add('lm-archive-cascade-choice'); row.append(title, subtitle);
        const wrapper = el('div', 'lm-archive-cascade-entry'); wrapper.setAttribute('role', 'none');
        wrapper.classList.toggle('lm-archive-cascade-current', item.id === currentId());
        const remove = action('×', () => deleteArchive(item, remove), `${t('archiveDelete')} ${item.name}`);
        remove.classList.add('lm-archive-cascade-delete'); remove.dataset.deleteId = item.id;
        remove.setAttribute('role', 'menuitem');
        wrapper.append(row, remove); panel.append(wrapper);
      }
    }
    if (!items.length) panel.append(el('div', 'lm-archive-cascade-empty', t('archiveEmpty')));
    root.append(panel); panels.push(panel);
    const rect = level ? owner.getBoundingClientRect() : anchor.parentElement.getBoundingClientRect();
    const parent = level ? panels[level - 1].getBoundingClientRect() : rect;
    const width = Math.min(196, window.innerWidth - 16);
    panel.style.width = `${width}px`; panel.style.maxHeight = `${Math.min(360, window.innerHeight - 16)}px`;
    const height = panel.getBoundingClientRect().height;
    let x = level ? parent.right + 2 : rect.left;
    if (level && x + width > window.innerWidth - 8) x = parent.left - width - 2;
    x = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    let y = level ? rect.top : rect.bottom + 4;
    if (!level && y + height > window.innerHeight - 8 && rect.top >= height + 8) y = rect.top - height - 4;
    y = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    panel.style.left = `${x}px`; panel.style.top = `${y}px`;
    panel.addEventListener('keydown', event => {
      event.stopPropagation();
      const choices = [...panel.querySelectorAll('button')];
      const index = choices.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); close(); anchor.focus(); }
      else if (event.key === 'Tab') close();
      else if (event.key === 'ArrowLeft' && level) { event.preventDefault(); trim(level); owner.focus(); }
      else if (event.key === 'ArrowRight' && level < 2) {
        event.preventDefault();
        const focused = document.activeElement;
        if (focused?.dataset.choice) {
          show(level + 1, focused, focused.dataset.choice);
          panels[level + 1]?.querySelector('[data-choice]')?.focus();
        }
      }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && choices.length) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + choices.length) % choices.length;
        choices[next].focus();
      }
    });
    panel.addEventListener('pointerdown', event => event.stopPropagation());
    panel.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
  }
  function rebuild() {
    if (closed) return;
    const branch = panels.slice(1).map(panel => panel.owner.dataset.choice);
    const scrolls = panels.map(panel => panel.scrollTop);
    const focused = document.activeElement;
    const focusId = focused?.dataset.choice, deleteId = focused?.dataset.deleteId;
    trim(0); show(0, anchor, null);
    branch.forEach((id, index) => {
      const owner = [...(panels[index]?.querySelectorAll('[data-choice]') || [])].find(row => row.dataset.choice === id);
      if (owner) show(index + 1, owner, id);
    });
    panels.forEach((panel, index) => { panel.scrollTop = scrolls[index] || 0; });
    const nextFocus = [...root.querySelectorAll('button')].find(button =>
      (focusId && button.dataset.choice === focusId) || (deleteId && button.dataset.deleteId === deleteId));
    if (nextFocus) nextFocus.focus({ preventScroll: true });
  }
  async function deleteArchive(item, button) {
    if (confirming || closed) return;
    confirming = true;
    const revision = client.data.revision;
    try {
      await archiveDialog({ title: t('archiveDelete'), t, signal: lifetime.signal,
        build: body => { body.append(el('p', '', `${item.name}\n${t('archiveDeleteConfirm')}`)); },
        actions: [{ label: t('archiveDelete'), run: () => client.write(`/archives/${item.id}`, 'DELETE', {}, revision) }],
      });
    } finally {
      confirming = false;
      if (!closed) {
        if (pendingRefresh) { pendingRefresh = false; rebuild(); }
        if (button.isConnected) button.focus({ preventScroll: true });
        else (panels.at(-1)?.querySelector('button') || anchor).focus({ preventScroll: true });
      }
    }
  }
  const unsubscribe = client.subscribe(() => { if (confirming) pendingRefresh = true; else rebuild(); });
  document.body.append(root); anchor.setAttribute('aria-expanded', 'true'); show(0, anchor, null);
  panels[0]?.querySelector('button')?.focus();
  document.addEventListener('pointerdown', outside, true); document.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', close); client.refresh().catch(() => {});
  return close;
}
