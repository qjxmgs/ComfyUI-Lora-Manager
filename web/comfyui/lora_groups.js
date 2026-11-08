import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';
import { GROUP_MESSAGES, loadGroupMessages } from './lora_groups_i18n.js';
import { openGroupSort } from './lora_groups_sort.js';
import { createArchiveController } from './lora_archives.js';
import { ARCHIVE_PROPERTY, gridSnapshot } from './lora_archives_state.js';
import { getStrengthStepPreference } from './settings.js';
import { applyStrengthRangeCue, getLoraStrengthRange } from './loras_widget_utils.js';
import {
  GROUP_COLORS, GROUPS_PROPERTY, GROUP_MIN_WIDTH, GROUP_MIN_HEIGHT, normalizeGroupConfig,
  normalizeGroupedEntries, changeGroupMode, setGroupedActive, moveGroupedEntry, moveGroupedEntries,
  previewGroupResize, resolveGroupResize,
  assignAddedOrders, sortGroupEntries, setGroupEnabled,
} from './lora_groups_state.js';

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(text, action, title = text) {
  const el = element('button', 'lm-group-button', text);
  el.type = 'button';
  el.title = title;
  el.setAttribute('aria-label', title);
  el.addEventListener('click', event => { event.stopPropagation(); action(event); });
  return el;
}

export function createLoraGroupsController({ node, container, widget, getSelected, getSelection = () => [getSelected()].filter(Boolean), select }) {
  let messages = GROUP_MESSAGES;
  let archives = null;
  let messagesLoaded = false;
  const pendingDefaultTitles = new Map();
  let activeGroupId = null;
  let removed = false;
  let closeOverlay = null;
  let closeStats = null;
  let statsButton = null;
  let statsPopup = null;
  let cancelDrag = null;
  let previousEntries = [];
  let strengthHistoryOpen = false;
  let selectionAnchor = null;
  let suppressClick = false;
  let lastNameClick = null;
  let handledDoubleClick = null;
  let clickTimer = null;
  const scrollPositions = new Map();
  const bodies = new Map();
  const t = (key, args = {}) => Object.entries(args).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[key] || key);
  const config = () => {
    const source = node.properties?.[GROUPS_PROPERTY];
    const state = normalizeGroupConfig(source, t('defaultGroup'));
    state.groups.forEach((group, index) => {
      const title = source?.groups?.[index]?.title;
      if (typeof title === 'string' && title.trim()) return;
      group.title = index === 0 ? t('defaultGroup') : t('group', { number: index + 1 });
      if (!messagesLoaded) pendingDefaultTitles.set(group.id, { title: group.title, index });
    });
    return state;
  };
  const getEntries = () => widget.value || [];
  const notice = detail => app.extensionManager?.toast?.add?.({ severity: 'info', summary: 'LoRA Manager', detail, life: 5000 });

  function selectItem(name, event = {}) {
    const entries = getEntries();
    const item = entries.find(entry => entry.name === name);
    if (!item) return;
    const additive = event.ctrlKey || event.metaKey;
    let names = new Set(additive ? getSelection() : []);
    const members = entries.filter(entry => entry.groupId === item.groupId);
    const from = members.findIndex(entry => entry.name === selectionAnchor);
    const to = members.findIndex(entry => entry.name === name);
    if (event.shiftKey && from >= 0) {
      members.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(entry => names.add(entry.name));
    } else {
      if (additive && names.has(name)) names.delete(name); else names.add(name);
      selectionAnchor = name;
    }
    select(names.has(name) ? name : [...names].at(-1) || null, { names: [...names] });
  }
  const blockDragClick = event => {
    if (!suppressClick) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  container.addEventListener('click', blockDragClick, true);

  function commit(entries, nextConfig = config(), archive = null) {
    const before = getEntries();
    app.canvas?.emitBeforeChange?.();
    node.graph?.beforeChange?.(node);
    try {
      node.properties ||= {};
      if (archive) {
        node.properties[ARCHIVE_PROPERTY] = archive.id;
        if (archive.snapshot) {
          previousEntries = []; activeGroupId = null; selectionAnchor = null;
          pendingDefaultTitles.clear(); scrollPositions.clear(); bodies.clear();
          select(null, { names: [] });
          if (node.setSize) node.setSize([...archive.snapshot.nodeSize]);
          else node.size = [...archive.snapshot.nodeSize];
        }
      }
      node.properties[GROUPS_PROPERTY] = nextConfig;
      widget.value = entries;
      node.onWidgetChanged?.(widget.name, widget.value, before, widget);
      widget.callback?.(widget.value);
      node._lmFlushLoraText?.();
      if (typeof node.graph?.incrementVersion === 'function') node.graph.incrementVersion();
      else if (typeof node.graph?._version === 'number') node.graph._version += 1;
    } finally {
      node.graph?.afterChange?.(node);
      app.canvas?.emitAfterChange?.();
    }
    node.graph?.change?.();
    node.graph?.setDirtyCanvas?.(true, true);
    archives?.schedule();
  }

  function setTarget(id) {
    activeGroupId = id;
    container.querySelectorAll('.lm-lora-group').forEach(panel => {
      panel.dataset.target = String(panel.dataset.groupId === id);
    });
  }

  function modal(title) {
    closeOverlay?.();
    const restoreFocus = document.activeElement;
    const backdrop = element('div', 'lm-popover lm-groups-backdrop');
    const dialog = element('section', 'lm-groups-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', title);
    const content = element('div', 'lm-groups-dialog-content');
    const footer = element('div', 'lm-groups-dialog-footer');
    dialog.append(element('h3', '', title), content, footer);
    backdrop.append(dialog);
    const close = () => {
      backdrop.remove();
      if (closeOverlay === close) closeOverlay = null;
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    };
    closeOverlay = close;
    backdrop.addEventListener('pointerdown', event => { if (event.target === backdrop) close(); event.stopPropagation(); });
    backdrop.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
    backdrop.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const items = [...dialog.querySelectorAll('button,input,select,[tabindex="0"]')].filter(el => !el.disabled);
        const index = items.indexOf(document.activeElement);
        if (items.length && (index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1))) {
          event.preventDefault();
          items[event.shiftKey ? items.length - 1 : 0].focus();
        }
      }
    });
    footer.append(button(t('cancel'), close));
    document.body.append(backdrop);
    queueMicrotask(() => { if (backdrop.isConnected) dialog.querySelector('input,select,button')?.focus(); });
    return { content, footer, close, alive: () => backdrop.isConnected };
  }

  function chooseTitleColor(group, anchor, event) {
    closeOverlay?.();
    setTarget(group.id);
    const menu = element('div', 'lm-popover lm-group-colors');
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', t('titleColor'));
    menu.append(element('div', 'lm-group-colors-label', t('titleColor')));
    const palette = element('div', 'lm-group-color-grid');
    const close = () => {
      menu.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keydown, true);
    };
    const outside = e => { if (!menu.contains(e.target)) close(); };
    const keydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor.querySelector('.lm-group-title')?.focus(); }
    };
    for (const color of [null, ...GROUP_COLORS]) {
      const label = t(color ? `color_${color}` : 'defaultColor');
      const swatch = button(color ? '' : '∕', () => {
        const next = config();
        const target = next.groups.find(item => item.id === group.id);
        close();
        if (target.titleColor === color) return;
        target.titleColor = color;
        commit(getEntries(), next);
      }, label);
      swatch.className = 'lm-group-color-swatch';
      swatch.dataset.color = color || 'default';
      swatch.setAttribute('aria-pressed', String(group.titleColor === color));
      if (color) swatch.style.background = `var(--lm-group-color-${color})`;
      palette.append(swatch);
    }
    menu.append(palette);
    menu.addEventListener('pointerdown', e => e.stopPropagation());
    menu.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 4))}px`;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keydown, true);
    closeOverlay = close;
    palette.querySelector('[aria-pressed="true"]')?.focus();
  }

  function rename(group, title) {
    const input = element('input', 'lm-group-title-input');
    input.value = group.title;
    input.maxLength = 100;
    input.setAttribute('aria-label', t('rename'));
    let finished = false;
    const finish = save => {
      if (finished) return;
      finished = true;
      input.replaceWith(title);
      const name = input.value.trim();
      if (!save || !name || name === group.title) return;
      const next = config();
      const current = next.groups.find(item => item.id === group.id);
      if (!current) return;
      current.title = name;
      pendingDefaultTitles.delete(group.id);
      commit(getEntries(), next);
    };
    input.addEventListener('pointerdown', event => event.stopPropagation());
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault(); finish(event.key === 'Enter');
      }
    });
    input.addEventListener('blur', () => finish(true));
    title.replaceWith(input);
    input.focus(); input.select();
  }

  async function addLoras(groupId) {
    setTarget(groupId);
    const view = modal(t('add'));
    const search = element('input');
    search.type = 'search';
    search.placeholder = t('search');
    search.setAttribute('aria-label', t('search'));
    const actions = element('div', 'lm-group-actions');
    const list = element('div', 'lm-group-picker-list');
    const status = element('div', 'lm-group-status', t('loading'));
    view.content.append(search, actions, list, status);
    const chosen = new Set();
    let library = [];
    const existing = () => new Map(getEntries().map(item => [item.name, item]));
    const matching = () => library.filter(item => `${item.file_name} ${item.model_name || ''}`.toLowerCase().includes(search.value.toLowerCase().trim()));
    const submit = button(t('add'), () => {
      const old = getEntries();
      const known = new Set(old.map(item => item.name));
      const additions = library.filter(item => chosen.has(item.file_name) && !known.has(item.file_name)).map(item => ({
        name: item.file_name, groupId, strength: 1, clipStrength: 1, expanded: false, active: true,
      }));
      view.close();
      if (additions.length) commit([...old, ...additions]);
    });
    submit.disabled = true;
    view.footer.append(submit);
    function draw() {
      list.replaceChildren();
      const matches = matching();
      const known = existing();
      for (const item of matches.slice(0, 200)) {
        const label = element('label', 'lm-group-picker-row');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.checked = chosen.has(item.file_name);
        checkbox.disabled = known.has(item.file_name);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) chosen.add(item.file_name); else chosen.delete(item.file_name);
          updateCount();
        });
        const name = element('span', '', item.file_name);
        label.title = item.file_name;
        label.append(checkbox, name);
        if (known.has(item.file_name)) {
          const title = config().groups.find(group => group.id === known.get(item.file_name).groupId)?.title;
          label.append(element('small', '', t('existing', { group: title })));
        }
        list.append(label);
      }
      status.textContent = matches.length > 200 ? t('more', { shown: 200, total: matches.length }) : '';
      updateCount();
    }
    function updateCount() {
      submit.textContent = `${t('add')} (${chosen.size})`;
      submit.disabled = chosen.size === 0;
    }
    actions.append(button(t('selectResults'), () => {
      const known = existing();
      matching().forEach(item => { if (!known.has(item.file_name)) chosen.add(item.file_name); });
      draw();
    }), button(t('clearSelection'), () => { chosen.clear(); draw(); }));
    search.addEventListener('input', draw);
    try {
      const response = await api.fetchApi('/lm/loras/cycler-list', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response?.ok) throw new Error('Library request failed');
      const data = await response.json();
      if (!view.alive()) return;
      library = [...new Map((data.loras || []).filter(item => item?.file_name).map(item => [item.file_name, item])).values()];
      draw();
    } catch {
      if (view.alive()) status.textContent = t('loadFailed');
    }
  }

  function groupActions(group) {
    const view = modal(group.title);
    const setAll = active => {
      view.close();
      commit(getEntries().map(entry => entry.groupId === group.id ? { ...entry, active } : entry));
    };
    view.content.append(button(t('disableAll'), () => setAll(false)));
    if (group.mode === 'multi') view.content.append(button(t('enableAll'), () => setAll(true)));
    const inputs = {};
    for (const [key, label] of [['strength', 'strength'], ['clipStrength', 'clip']]) {
      const row = element('label', 'lm-group-field', t(label));
      const input = element('input');
      input.type = 'number'; input.step = '0.05'; input.min = '-10'; input.max = '10';
      input.placeholder = '—';
      row.append(input); view.content.append(row); inputs[key] = input;
    }
    view.footer.append(button(t('apply'), () => {
      const updates = {};
      for (const [key, input] of Object.entries(inputs)) {
        if (input.value === '') continue;
        if (!input.checkValidity() || !Number.isFinite(Number(input.value))) return input.reportValidity();
        updates[key] = Number(input.value);
      }
      const entries = getEntries().map(entry => {
        if (entry.groupId !== group.id) return entry;
        const next = { ...entry, ...updates };
        if (updates.clipStrength !== undefined) next.expanded = Number(next.strength) !== next.clipStrength || entry.expanded;
        else if (updates.strength !== undefined && !entry.expanded) next.clipStrength = updates.strength;
        return next;
      });
      view.close(); commit(entries);
    }));
  }

  function resize(rows, columns) {
    const grid = container.querySelector('.lm-groups-grid');
    const old = config();
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1 || rows * columns > 256) {
      notice(t('invalidSize')); return false;
    }
    if (grid && ((columns > old.columns && (grid.clientWidth - (columns - 1) * 6) / columns < GROUP_MIN_WIDTH)
      || (rows > old.rows && (grid.clientHeight - (rows - 1) * 6) / rows < GROUP_MIN_HEIGHT))) {
      notice(t('tooSmall')); return false;
    }
    const entries = getEntries();
    const initial = previewGroupResize(old, entries, rows, columns);
    initial.config.groups.forEach((group, i) => { if (i >= old.groups.length) group.title = t('group', { number: i + 1 }); });
    if (!initial.pending.length) { commit(entries, initial.config); return true; }
    const view = modal(t('resize'));
    const targets = {};
    const winners = {};
    const details = element('div', 'lm-group-merge-details');
    const conflicts = element('div');
    const confirm = button(t('confirm'), () => {
      const preview = previewGroupResize(old, entries, rows, columns, targets);
      const result = resolveGroupResize(preview, winners);
      view.close(); commit(result.entries, result.config);
    });
    confirm.disabled = true;
    const updateValidity = () => {
      const preview = previewGroupResize(old, entries, rows, columns, targets);
      confirm.disabled = !!preview.pending.length || preview.conflicts.some(conflict =>
        winners[conflict.group.id] !== null && !conflict.entries.some(entry => entry.name === winners[conflict.group.id]));
    };
    const drawConflicts = () => {
      conflicts.replaceChildren();
      Object.keys(winners).forEach(key => delete winners[key]);
      const preview = previewGroupResize(old, entries, rows, columns, targets);
      for (const conflict of preview.conflicts) {
        const label = element('label', 'lm-group-field', t('keepActive', { group: conflict.group.title }));
        const select = element('select');
        select.append(new Option(t('choose'), ''), new Option(t('none'), 'none'));
        conflict.entries.forEach((entry, i) => select.append(new Option(entry.name, String(i))));
        select.addEventListener('change', () => {
          winners[conflict.group.id] = select.value === 'none' ? null : conflict.entries[Number(select.value)]?.name;
          if (select.value === '') delete winners[conflict.group.id];
          updateValidity();
        });
        label.append(select); conflicts.append(label);
      }
      updateValidity();
    };
    for (const group of initial.pending) {
      const label = element('label', 'lm-group-field', t('destination', { group: group.title }));
      const target = element('select');
      target.append(new Option(t('choose'), ''));
      initial.config.groups.forEach(group => target.append(new Option(group.title, group.id)));
      target.addEventListener('change', () => { targets[group.id] = target.value; drawConflicts(); });
      label.append(target); details.append(label);
      const list = element('ul');
      entries.filter(entry => entry.groupId === group.id).forEach(entry => {
        list.append(element('li', '', `${entry.name} · ${entry.strength} / ${entry.clipStrength ?? entry.strength} · ${t(entry.active ? 'enabled' : 'disabled')}`));
      });
      details.append(list);
    }
    view.content.append(details, conflicts);
    view.footer.append(confirm);
    return true;
  }

  function activeEntries(entries = getEntries()) {
    const state = config();
    return state.groups.flatMap(group => group.enabled
      ? entries.filter(entry => entry.groupId === group.id && entry.active) : []);
  }

  function updateStats(entries = getEntries()) {
    const active = activeEntries(entries);
    if (statsButton) {
      const [before, ...after] = t('activeCount', { count: '{count}' }).split('{count}');
      statsButton.replaceChildren(
        document.createTextNode(before),
        element('strong', 'lm-active-count-number', String(active.length)),
        document.createTextNode(after.join('{count}')),
      );
    }
    if (!statsPopup) return;
    statsPopup.replaceChildren();
    statsPopup.append(element('div', 'lm-active-summary-heading', `LoRA (${active.length})`));
    if (!active.length) statsPopup.append(element('div', '', t('noActive')));
    for (const entry of active) {
      const row = element('div', 'lm-active-summary-row');
      row.append(element('span', 'lm-active-summary-name', entry.name));
      const model = Number(entry.strength);
      const clip = Number(entry.clipStrength ?? entry.strength);
      const weights = element('span', 'lm-active-summary-weights');
      weights.append(element('span', 'lm-active-summary-weight', String(model)));
      if (clip !== model) weights.append(element('span', 'lm-active-summary-weight', `CLIP ${clip}`));
      row.append(weights);
      statsPopup.append(row);
    }
  }

  function bindStats(anchor) {
    let timer;
    const hide = () => {
      clearTimeout(timer);
      statsPopup?.remove(); statsPopup = null;
      anchor.removeAttribute('aria-describedby');
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', hide);
    };
    const scheduleHide = () => { clearTimeout(timer); timer = setTimeout(hide, 180); };
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); }
    };
    const show = () => {
      clearTimeout(timer);
      if (statsPopup) return;
      statsPopup = element('div', 'lm-popover lm-active-summary');
      statsPopup.id = `lm-active-summary-${node.id ?? 'node'}`;
      statsPopup.setAttribute('role', 'tooltip');
      statsPopup.tabIndex = 0;
      anchor.setAttribute('aria-describedby', statsPopup.id);
      statsPopup.addEventListener('pointerenter', () => clearTimeout(timer));
      statsPopup.addEventListener('pointerleave', scheduleHide);
      statsPopup.addEventListener('focusin', () => clearTimeout(timer));
      statsPopup.addEventListener('focusout', scheduleHide);
      statsPopup.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
      document.body.append(statsPopup);
      updateStats();
      const rect = anchor.getBoundingClientRect();
      const bounds = statsPopup.getBoundingClientRect();
      statsPopup.style.left = `${Math.max(8, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 8))}px`;
      statsPopup.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - bounds.height - 8))}px`;
      document.addEventListener('keydown', keydown, true);
      window.addEventListener('resize', hide);
    };
    anchor.addEventListener('pointerenter', show);
    anchor.addEventListener('pointerleave', scheduleHide);
    anchor.addEventListener('focus', show);
    anchor.addEventListener('blur', scheduleHide);
    closeStats = hide;
  }

  function openSettings() {
    closeStats?.();
    const backing = node._animaModeWidget || node.widgets?.find(item => item.name === 'anima_mode');
    const view = modal(t('nodeSettings'));
    view.content.parentElement.classList.add('lm-node-settings-dialog');
    const label = element('label', 'lm-node-settings-option');
    const input = element('input'); input.type = 'checkbox';
    input.checked = backing?.value === true || backing?.value === 'true';
    input.disabled = !backing;
    label.append(input, document.createTextNode(t('animaMode')));
    view.content.append(label, element('p', 'lm-node-settings-help', t('animaHelp')));
    view.footer.append(button(t('apply'), () => {
      const value = input.checked;
      view.close();
      if (!backing || value === (backing.value === true || backing.value === 'true')) return;
      app.canvas?.emitBeforeChange?.(); node.graph?.beforeChange?.(node);
      try {
        backing.value = value;
        node.properties ||= {}; node.properties.anima_mode = value;
        backing.callback?.(value);
        widget.value = widget.value;
        node.graph?.incrementVersion?.();
      } finally {
        node.graph?.afterChange?.(node); app.canvas?.emitAfterChange?.();
      }
      node.graph?.change?.(); node.graph?.setDirtyCanvas?.(true, true);
    }));
  }

  function render(animaControl) {
    const state = config();
    node.properties ||= {};
    node.properties[GROUPS_PROPERTY] = state;
    if (!state.groups.some(group => group.id === activeGroupId)) activeGroupId = state.groups[0].id;
    bodies.clear();
    const toolbar = element('div', 'lm-groups-toolbar');
    const dimensions = {};
    for (const [key, value] of [['rows', state.rows], ['columns', state.columns]]) {
      const label = element('label', 'lm-group-dimension', t(key));
      const input = element('input');
      input.type = 'number'; input.min = '1'; input.step = '1'; input.value = value;
      input.setAttribute('aria-label', t(key));
      dimensions[key] = input;
      label.append(input); toolbar.append(label);
    }
    const apply = () => {
      resize(Number(dimensions.rows.value), Number(dimensions.columns.value));
      const current = config();
      dimensions.rows.value = current.rows;
      dimensions.columns.value = current.columns;
    };
    toolbar.append(button(t('apply'), apply));
    if (archives) toolbar.append(archives.render());
    toolbar.addEventListener('keydown', event => { if (event.key === 'Enter') apply(); });
    closeStats?.();
    const status = element('div', 'lm-groups-status');
    statsButton = button('', () => {}, '');
    statsButton.className = 'lm-active-count';
    statsButton.removeAttribute('title'); statsButton.removeAttribute('aria-label');
    bindStats(statsButton); updateStats();
    status.append(statsButton);
    if (animaControl) {
      const settings = button('⚙', openSettings, t('nodeSettings'));
      settings.classList.add('lm-node-settings');
      status.append(settings);
    }
    toolbar.append(status);
    const grid = element('div', 'lm-groups-grid');
    grid.style.gridTemplateColumns = `repeat(${state.columns}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${state.rows}, minmax(0, 1fr))`;
    for (const group of state.groups) {
      const panel = element('section', 'lm-lora-group');
      panel.dataset.groupId = group.id;
      panel.dataset.enabled = String(group.enabled);
      if (group.titleColor) {
        panel.style.setProperty('--lm-group-title-bg', `var(--lm-group-color-${group.titleColor})`);
        panel.style.setProperty('--lm-group-title-selected-bg', `var(--lm-group-color-${group.titleColor})`);
        panel.style.setProperty('--lm-group-title-fg', ['yellow', 'cyan', 'gray', 'white', 'orange', 'coral', 'peach', 'amber', 'mint', 'sky', 'lavender', 'rose'].includes(group.titleColor) ? 'var(--lm-group-color-black)' : 'var(--lm-group-color-white)');
      }
      panel.dataset.target = String(group.id === activeGroupId);
      const header = element('header', 'lm-group-header');
      header.title = t('target');
      header.addEventListener('pointerdown', () => setTarget(group.id));
      header.addEventListener('click', () => setTarget(group.id));
      header.addEventListener('focusin', () => setTarget(group.id));
      bindDrag(header, group.title, group.id);
      const titleSlot = element('div', 'lm-group-title-slot');
      titleSlot.addEventListener('contextmenu', event => {
        if (event.target.closest('input')) return;
        event.preventDefault(); event.stopPropagation(); chooseTitleColor(group, titleSlot, event);
      });
      const title = element('span', 'lm-group-title', group.title);
      title.title = group.title;
      title.tabIndex = 0;
      title.setAttribute('role', 'button');
      title.setAttribute('aria-label', `${t('rename')}: ${group.title}`);
      title.addEventListener('pointerdown', event => { if (event.button === 0) event.stopPropagation(); });
      title.addEventListener('click', event => { event.stopPropagation(); setTarget(group.id); rename(group, title); });
      title.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); rename(group, title);
        }
      });
      titleSlot.append(title);
      const power = button('', () => {
        const next = setGroupEnabled(config(), getEntries(), group.id, !group.enabled);
        commit(next.entries, next.config);
      }, t(group.enabled ? 'disableGroup' : 'enableGroup'));
      power.className = 'lm-group-power';
      // Shared CSS is injected into the page, so resolve assets against this module.
      power.style.setProperty('--lm-group-power-icon', `url("${new URL('./assets/on-off.png', import.meta.url).href}")`);
      power.setAttribute('role', 'switch');
      power.setAttribute('aria-checked', String(group.enabled));
      power.addEventListener('pointerdown', event => event.stopPropagation());
      power.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); });
      const controls = element('div', 'lm-group-actions');
      const modeSwitch = element('div', 'lm-group-mode-switch');
      modeSwitch.setAttribute('role', 'group');
      modeSwitch.setAttribute('aria-label', `${t('single')} / ${t('multi')}`);
      modeSwitch.inert = !group.enabled;
      for (const mode of ['single', 'multi']) {
        const toggle = button(t(mode), () => {
          const old = getEntries();
          const next = changeGroupMode(config(), old, group.id, mode, getSelected());
          commit(next.entries, next.config);
          if (mode === 'single' && old.filter(entry => entry.groupId === group.id && entry.active).length > 1) {
            notice(t('modeChanged', { name: next.entries.find(entry => entry.groupId === group.id && entry.active)?.name || t('none') }));
          }
        });
        toggle.setAttribute('aria-pressed', String(group.mode === mode));
        modeSwitch.append(toggle);
      }
      titleSlot.append(modeSwitch, power);
      controls.inert = !group.enabled;
      const sort = button('⇅', () => {
        closeOverlay?.();
        closeOverlay = openGroupSort({ anchor: sort, rules: config().groups.find(item => item.id === group.id).sortRules, t,
          onApply: rules => {
            const next = config();
            const current = next.groups.find(item => item.id === group.id);
            if (!current) return;
            current.sortRules = rules;
            const locale = app.ui?.settings?.getSettingValue?.('Comfy.Locale') || 'en';
            commit(sortGroupEntries(getEntries(), group.id, rules, locale), next);
          },
        });
      }, t('sort'));
      sort.classList.add('lm-group-sort-button');
      sort.append(element('span', 'lm-group-sort-label', t('sort')));
      controls.append(sort, button('+', () => addLoras(group.id), t('add')), button('⋯', () => groupActions(group), t('menu')));
      const members = getEntries().filter(entry => entry.groupId === group.id);
      const strengths = members.map(entry => Number(entry.strength));
      const uniform = strengths.length > 0 && strengths.every(value => Number.isFinite(value) && value === strengths[0]);
      const initialStrength = uniform ? strengths[0].toFixed(2) : '';
      const bulkStrength = element('input', 'lm-group-bulk-strength-input');
      bulkStrength.type = 'text';
      bulkStrength.inputMode = 'decimal';
      bulkStrength.value = initialStrength;
      bulkStrength.placeholder = members.length ? t('mixedWeights') : '—';
      bulkStrength.setAttribute('aria-label', t('allWeights'));
      bulkStrength.title = t('allWeights');
      bulkStrength.addEventListener('focus', () => bulkStrength.select());
      bulkStrength.addEventListener('pointerdown', event => event.stopPropagation());
      bulkStrength.addEventListener('keydown', event => {
        event.stopPropagation();
        if (!event.isComposing && event.key === 'Enter') {
          event.preventDefault();
          bulkStrength.blur();
        }
      });
      bulkStrength.addEventListener('blur', () => {
        const raw = bulkStrength.value.trim();
        if (bulkStrength.value === initialStrength || !members.length
          || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
          bulkStrength.value = initialStrength;
          return;
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < -10 || value > 10) {
          bulkStrength.value = initialStrength;
          return;
        }
        const normalized = value.toFixed(2);
        const entries = getEntries();
        const changed = entries.some(entry => entry.groupId === group.id
          && (Number(entry.strength) !== value || Number(entry.clipStrength ?? entry.strength) !== value));
        if (!changed) {
          bulkStrength.value = initialStrength;
          return;
        }
        commit(entries.map(entry => entry.groupId === group.id
          ? { ...entry, strength: normalized, clipStrength: normalized } : entry));
      });
      controls.append(bulkStrength);
      header.append(titleSlot, controls);
      const body = element('div', 'lm-group-body');
      body.dataset.groupId = group.id;
      body.inert = !group.enabled;
      body.tabIndex = 0;
      panel.addEventListener('click', event => {
        if (event.button === 0 && (event.target === panel || event.target === body)) setTarget(group.id);
      });
      panel.append(header, body); grid.append(panel); bodies.set(group.id, body);
    }
    container.append(toolbar, grid);
  }

  function move(name, groupId, beforeName) {
    const old = getEntries();
    const next = moveGroupedEntry(old, config(), name, groupId, beforeName);
    setTarget(groupId);
    commit(next);
    if (old.find(entry => entry.name === name)?.active && !next.find(entry => entry.name === name)?.active) notice(t('movedInactive'));
  }

  function moveDialog(name) {
    const view = modal(t('moveTo'));
    const current = getEntries().find(entry => entry.name === name);
    for (const group of config().groups) {
      const target = button(group.title, () => { view.close(); move(name, group.id); });
      target.disabled = group.id === current?.groupId;
      view.content.append(target);
    }
  }

  function bindDrag(handle, name, groupId = null) {
    let start = null;
    let dragging = false;
    let destination = null;
    let animation = null;
    let pointer = null;
    let indicator = null;
    let ghost = null;
    let dragNames = [name];
    const clearMarks = () => {
      container.querySelectorAll('.lm-group-drop-target').forEach(el => el.classList.remove('lm-group-drop-target', 'lm-group-sort-target'));
      if (indicator) indicator.hidden = true;
    };
    const groupMarker = (panels, boundary, columns) => {
      const rects = panels.map(panel => panel.getBoundingClientRect());
      const before = rects[boundary - 1];
      const after = rects[boundary];
      const rect = after || before;
      const horizontal = columns === 1 || (before && after && boundary % columns === 0);
      const grid = panels[0].parentElement;
      const scale = grid.getBoundingClientRect().width / grid.clientWidth || 1;
      const fallbackGap = (parseFloat(getComputedStyle(grid)[horizontal ? 'rowGap' : 'columnGap']) || 6) * scale;
      const gap = before && after ? (horizontal ? after.top - before.bottom : after.left - before.right) : fallbackGap;
      const thickness = Math.min(3, Math.max(1, gap / 2));
      if (horizontal) {
        const center = before && after ? (before.bottom + after.top) / 2 : after ? rect.top - gap / 2 : rect.bottom + gap / 2;
        const left = Math.min(...rects.map(rect => rect.left));
        return { left, top: center - thickness / 2, width: Math.max(...rects.map(rect => rect.right)) - left, height: thickness };
      }
      const center = before && after ? (before.right + after.left) / 2 : after ? rect.left - gap / 2 : rect.right + gap / 2;
      return { left: center - thickness / 2, top: rect.top, width: thickness, height: rect.height };
    };
    const locate = () => {
      clearMarks(); destination = null;
      if (!pointer) return;
      const hit = document.elementFromPoint?.(pointer.x, pointer.y);
      let panel = hit?.closest('.lm-lora-group');
      if (groupId) {
        const grid = container.querySelector('.lm-groups-grid');
        if (!grid || !hit || !grid.contains(hit)) return;
        const state = config();
        const groups = state.groups;
        const panels = [...grid.querySelectorAll('.lm-lora-group')];
        const from = groups.findIndex(group => group.id === groupId);
        let to = groups.findIndex(group => group.id === panel?.dataset.groupId);
        let boundary;
        if (!panel) {
          // Keep the gap itself droppable instead of losing the marker between panels.
          let closest = Infinity;
          for (let index = 1; index < panels.length; index++) {
            const marker = groupMarker(panels, index, state.columns);
            const dx = Math.max(marker.left - pointer.x, 0, pointer.x - marker.left - marker.width);
            const dy = Math.max(marker.top - pointer.y, 0, pointer.y - marker.top - marker.height);
            const distance = Math.hypot(dx, dy);
            if (distance < closest) { closest = distance; boundary = index; }
          }
          if (boundary === undefined) return;
          to = boundary > from ? boundary - 1 : boundary;
          panel = panels[to];
        } else boundary = from < to ? to + 1 : to;
        if (from === to) return;
        if (from < 0 || to < 0) return;
        destination = { id: panel.dataset.groupId };
        panel.classList.add('lm-group-drop-target', 'lm-group-sort-target');
        const marker = groupMarker(panels, boundary, state.columns);
        for (const [key, value] of Object.entries(marker)) indicator.style[key] = `${value}px`;
        indicator.hidden = false;
        return;
      }
      const body = panel?.querySelector('.lm-group-body');
      if (!body || !container.contains(body)) return;
      const candidates = [...body.querySelectorAll('.lm-lora-entry')].filter(el => !dragNames.includes(el.dataset.loraName));
      const before = candidates.find(el => { const rect = el.getBoundingClientRect(); return pointer.y < rect.top + rect.height / 2; });
      destination = { id: body.dataset.groupId, before: before?.dataset.loraName || null };
      panel.classList.add('lm-group-drop-target');
      const rect = body.getBoundingClientRect();
      const last = candidates.at(-1);
      const lastRow = last?.nextElementSibling?.classList.contains('lm-lora-clip-entry') ? last.nextElementSibling : last;
      const scale = rect.height / body.clientHeight || 1;
      const previous = before?.previousElementSibling;
      const previousRow = previous?.matches('.lm-lora-entry,.lm-lora-clip-entry') ? previous : null;
      const gap = before && previousRow
        ? Math.max(0, before.getBoundingClientRect().top - previousRow.getBoundingClientRect().bottom)
        : 3 * scale;
      const thickness = Math.min(3, Math.max(1, gap / 2));
      const center = before ? before.getBoundingClientRect().top - gap / 2
        : lastRow ? lastRow.getBoundingClientRect().bottom + gap / 2 : rect.top + 4;
      const lineY = center - thickness / 2;
      Object.assign(indicator.style, {
        left: `${rect.left + 4}px`, width: `${Math.max(0, rect.width - 8)}px`,
        top: `${Math.max(rect.top, Math.min(rect.bottom - thickness, lineY))}px`, height: `${thickness}px`,
      });
      indicator.hidden = false;
      const edge = Math.min(40 * scale, rect.height / 3);
      if (pointer.y < rect.top + edge) body.scrollTop -= Math.min(20, (rect.top + edge - pointer.y) / scale / 2);
      else if (pointer.y > rect.bottom - edge) body.scrollTop += Math.min(20, (pointer.y - rect.bottom + edge) / scale / 2);
    };
    const tick = () => { locate(); animation = requestAnimationFrame(tick); };
    const finish = (event, accept) => {
      if (!start || (event?.pointerId !== undefined && event.pointerId !== start.id)) return;
      const clickSelection = accept && !dragging && !groupId;
      const modifiers = start;
      if (dragging || clickSelection) { event?.stopPropagation(); event?.preventDefault(); }
      const target = destination;
      const didDrag = dragging;
      if (didDrag || !accept) lastNameClick = null;
      if (didDrag || clickSelection) {
        suppressClick = true;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { suppressClick = false; }, 0);
      }
      const pointerId = start.id;
      start = null; dragging = false; destination = null;
      try { if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* Detached host node. */ }
      if (animation !== null) cancelAnimationFrame(animation);
      animation = null;
      widget.__dragActive = false;
      document.body.classList.remove('lm-lora-reordering');
      container.querySelectorAll('.lm-lora-entry--dragging').forEach(entry => entry.classList.remove('lm-lora-entry--dragging'));
      if (groupId) handle.closest('.lm-lora-group')?.classList.remove('lm-group--dragging');
      clearMarks(); cancelDrag = null;
      indicator?.remove(); ghost?.remove(); indicator = ghost = null;
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
      if (clickSelection) {
        selectItem(name, modifiers);
        container.focus({ preventScroll: true });
        const now = performance.now();
        const plain = !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.shiftKey;
        const twice = plain && lastNameClick?.name === name && now - lastNameClick.time <= 500
          && Math.hypot(modifiers.x - lastNameClick.x, modifiers.y - lastNameClick.y) <= 6;
        lastNameClick = plain && !twice ? { name, time: now, x: modifiers.x, y: modifiers.y } : null;
        if (twice) {
          handledDoubleClick = { name, time: now };
          const entry = getEntries().find(item => item.name === name);
          const group = config().groups.find(item => item.id === entry?.groupId);
          if (entry && group?.enabled) commit(setGroupedActive(getEntries(), config(), name, !entry.active));
        }
      } else if (accept && didDrag && target && groupId) {
        const next = config();
        const from = next.groups.findIndex(group => group.id === groupId);
        const to = next.groups.findIndex(group => group.id === target.id);
        if (from >= 0 && to >= 0 && from !== to) {
          const [group] = next.groups.splice(from, 1);
          next.groups.splice(to, 0, group);
          commit(getEntries(), next);
        }
      } else if (accept && didDrag && target) {
        const old = getEntries();
        const next = moveGroupedEntries(old, config(), dragNames, target.id, target.before);
        setTarget(target.id);
        commit(next);
        if (next.some(entry => dragNames.includes(entry.name) && !entry.active && old.find(item => item.name === entry.name)?.active)) notice(t('movedInactive'));
      }
      else if (didDrag && !removed) widget.value = widget.value;
    };
    const cancel = () => finish(null, false);
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (groupId && event.target.closest('button,input,select,textarea,a,[contenteditable="true"]')) return;
      cancelDrag?.();
      event.preventDefault(); event.stopPropagation();
      start = { x: event.clientX, y: event.clientY, id: event.pointerId, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey };
      widget.__dragActive = true;
      handle.setPointerCapture?.(event.pointerId);
      cancelDrag = cancel;
      window.addEventListener('keydown', escape, true);
      window.addEventListener('blur', cancel);
    });
    handle.addEventListener('pointermove', event => {
      if (!start || event.pointerId !== start.id) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!dragging && Math.hypot(pointer.x - start.x, pointer.y - start.y) >= 3) {
        dragging = true; widget.__dragActive = true;
        if (!groupId) {
          if (!getSelection().includes(name)) selectItem(name, start);
          const selection = new Set(getSelection());
          dragNames = getEntries().filter(entry => selection.has(entry.name)).map(entry => entry.name);
        }
        indicator = element('div', 'lm-popover lm-group-insertion-line');
        ghost = element('div', 'lm-popover lm-group-drag-ghost', !groupId && dragNames.length > 1 ? `${t('selected', { count: dragNames.length })} · ${name}` : name);
        indicator.setAttribute('aria-hidden', 'true'); ghost.setAttribute('aria-hidden', 'true');
        document.body.append(indicator, ghost);
        document.body.classList.add('lm-lora-reordering');
        if (!groupId) container.querySelectorAll('.lm-lora-entry').forEach(entry => {
          if (dragNames.includes(entry.dataset.loraName)) entry.classList.add('lm-lora-entry--dragging');
        });
        if (groupId) handle.closest('.lm-lora-group')?.classList.add('lm-group--dragging');
        tick();
      }
      if (dragging) {
        Object.assign(ghost.style, { left: `${Math.min(pointer.x + 14, window.innerWidth - 280)}px`, top: `${Math.min(pointer.y + 14, window.innerHeight - 40)}px` });
        event.preventDefault(); event.stopPropagation(); locate();
      }
    });
    handle.addEventListener('pointerup', event => finish(event, true));
    handle.addEventListener('pointercancel', event => finish(event, false));
    handle.addEventListener('lostpointercapture', event => finish(event, false));
  }

  function keydown(event) {
    if (event.target.closest('input,textarea,select,button,[contenteditable="true"]')) return false;
    const selected = getEntries().find(entry => entry.name === getSelected());
    if (!selected) return false;
    const members = getEntries().filter(entry => entry.groupId === selected.groupId);
    const index = members.findIndex(entry => entry.name === selected.name);
    let targetIndex;
    if (event.key === 'ArrowUp') targetIndex = Math.max(0, index - 1);
    else if (event.key === 'ArrowDown') targetIndex = Math.min(members.length - 1, index + 1);
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = members.length - 1;
    if (targetIndex !== undefined) {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const others = members.filter(entry => entry.name !== selected.name);
        move(selected.name, selected.groupId, others[targetIndex]?.name || null);
      } else selectItem(members[targetIndex].name, event);
      const focused = [...container.querySelectorAll('.lm-lora-entry')].find(el => el.dataset.loraName === getSelected());
      if (focused) {
        const body = focused.parentElement;
        if (focused.offsetTop < body.scrollTop) body.scrollTop = focused.offsetTop;
        else if (focused.offsetTop + focused.offsetHeight > body.scrollTop + body.clientHeight) body.scrollTop = focused.offsetTop + focused.offsetHeight - body.clientHeight;
      }
      return true;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); commit(getEntries().filter(entry => entry.name !== selected.name)); select(null); return true;
    }
    if (event.key === ' ') {
      event.preventDefault(); commit(setGroupedActive(getEntries(), config(), selected.name, !selected.active)); return true;
    }
    return false;
  }

  // Capture before ComfyUI's canvas handlers, including non-overflowing groups.
  const wheel = event => {
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const body = event.target.closest?.('.lm-group-body');
    if (!body || !container.contains(body)) return;
    const input = event.target.closest?.('.lm-lora-strength-input');
    if (input && document.activeElement === input && event.deltaY !== 0) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      const name = input.closest('[data-lora-name]')?.dataset.loraName;
      const entries = getEntries();
      const entry = entries.find(entry => entry.name === name);
      if (!entry) return;
      const clip = input.classList.contains('lm-lora-clip-strength-input');
      const field = clip ? 'clipStrength' : 'strength';
      const typed = Number.parseFloat(input.value);
      const current = Number.isFinite(typed) ? typed : Number(entry[field]) || 0;
      const next = (current + (event.deltaY < 0 ? 1 : -1) * getStrengthStepPreference()).toFixed(2);
      const changed = entries.map(item => item.name !== name ? item : {
        ...item, [field]: next, ...(!clip && !item.expanded ? { clipStrength: next } : {}),
      });
      // Keep the focused input mounted across consecutive wheel events.
      const wasDragging = widget.__dragActive;
      widget.__dragActive = true;
      try { commit(changed); } finally { widget.__dragActive = wasDragging; }
      input.value = next;
      applyStrengthRangeCue(input, Number(next), getLoraStrengthRange(name));
      return;
    }
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? body.clientHeight : 1;
    body.scrollTop += event.deltaY * unit;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
  };
  window.addEventListener('wheel', wheel, { capture: true, passive: false });
  container.classList.add('lm-loras-grouped');
  archives = createArchiveController({
    node, t,
    snapshot: () => gridSnapshot(config(), getEntries(), node.size),
    associate: id => commit(getEntries(), config(), { id }),
    apply: (snapshot, id) => {
      const copy = JSON.parse(JSON.stringify(snapshot));
      commit(copy.entries, copy.groupConfig, { id, snapshot: copy });
    },
  });
  loadGroupMessages().then(value => {
    if (removed) return;
    messages = value;
    messagesLoaded = true;
    // Only localize names generated while loading; saved and edited titles belong to the user.
    node.properties?.[GROUPS_PROPERTY]?.groups?.forEach(group => {
      const pending = pendingDefaultTitles.get(group.id);
      if (pending && group.title === pending.title) {
        group.title = pending.index === 0 ? t('defaultGroup') : t('group', { number: pending.index + 1 });
      }
    });
    pendingDefaultTitles.clear();
    if (container.isConnected && !widget.__dragActive) widget.value = widget.value;
  });

  return {
    commit, config, render, bindDrag, keydown, moveDialog, selectItem, t,
    handledNameDoubleClick(name) { return handledDoubleClick?.name === name && performance.now() - handledDoubleClick.time < 750; },
    beginStrengthEdit() {
      if (strengthHistoryOpen) return;
      strengthHistoryOpen = true;
      app.canvas?.emitBeforeChange?.();
      node.graph?.beforeChange?.(node);
    },
    endStrengthEdit() {
      if (!strengthHistoryOpen) return;
      strengthHistoryOpen = false;
      node._lmFlushLoraText?.();
      node.graph?.afterChange?.(node);
      app.canvas?.emitAfterChange?.();
      archives?.schedule();
    },
    normalize(entries) {
      const state = config();
      const assigned = assignAddedOrders(entries, state.nextAddedOrder, previousEntries);
      state.nextAddedOrder = assigned.nextAddedOrder;
      node.properties ||= {};
      node.properties[GROUPS_PROPERTY] = state;
      const normalized = normalizeGroupedEntries(assigned.entries, state, previousEntries, activeGroupId);
      previousEntries = normalized.map(entry => ({ ...entry }));
      updateStats(normalized);
      archives?.schedule();
      return normalized;
    },
    restore() { previousEntries = []; activeGroupId = null; selectionAnchor = null; pendingDefaultTitles.clear(); scrollPositions.clear(); bodies.clear(); closeOverlay?.(); archives?.schedule(); },
    setActive(name, active) { commit(setGroupedActive(getEntries(), config(), name, active)); },
    isSingle(id) { return config().groups.find(group => group.id === id)?.mode === 'single'; },
    body(id) { return bodies.get(id); },
    beforeRender() { bodies.forEach((body, id) => scrollPositions.set(id, body.scrollTop)); },
    afterRender() {
      bodies.forEach((body, id) => {
        if (!body.children.length) body.append(button(t('empty'), () => addLoras(id)));
        body.scrollTop = scrollPositions.get(id) || 0;
      });
    },
    dispose() { archives?.dispose(); closeStats?.(); removed = true; cancelDrag?.(); clearTimeout(clickTimer); container.removeEventListener('click', blockDragClick, true); closeOverlay?.(); window.removeEventListener('wheel', wheel, true); },
  };
}
