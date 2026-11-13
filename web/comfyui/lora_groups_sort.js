import { normalizeSortRules, SORT_FIELDS } from './lora_groups_state.js';

const SORT_PREFERENCE_KEY = 'lm.loraGrid.lastSortRules';

function restoreSortRules(fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_PREFERENCE_KEY));
    if (Array.isArray(saved) && saved.some(rule => SORT_FIELDS.includes(rule?.field))) {
      return normalizeSortRules(saved);
    }
  } catch {
    // Keep workflow rules available when browser storage is unavailable or corrupt.
  }
  return normalizeSortRules(fallback);
}

export function openGroupSort({ anchor, rules, t, onApply }) {
  let draft = restoreSortRules(rules);
  let closed = false;
  let cancelDrag = null;
  const panel = document.createElement('section');
  panel.className = 'lm-popover lm-sort-popover';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('sortRules'));
  const heading = document.createElement('strong');
  heading.textContent = t('sortRules');
  const help = document.createElement('p');
  help.textContent = t('sortHelp');
  const list = document.createElement('div');
  list.className = 'lm-sort-rules';
  const summary = document.createElement('p');
  summary.className = 'lm-sort-summary';
  summary.setAttribute('aria-live', 'polite');
  const fieldLabels = { addedOrder: 'sortAdded', active: 'sortActive', strength: 'strength', name: 'sortName' };
  const directionLabels = {
    addedOrder: { asc: 'sortOldest', desc: 'sortNewest' },
    active: { asc: 'sortInactiveFirst', desc: 'sortActiveFirst' },
    strength: { asc: 'sortSmallest', desc: 'sortLargest' },
    name: { asc: 'sortAscending', desc: 'sortDescending' },
  };
  const makeButton = (text, label, action) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'lm-group-button';
    button.textContent = text; button.title = label; button.setAttribute('aria-label', label);
    button.addEventListener('click', action);
    return button;
  };
  const initialRect = anchor.getBoundingClientRect();
  const position = () => {
    const rect = anchor.isConnected ? anchor.getBoundingClientRect() : initialRect;
    panel.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`;
    panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8))}px`;
    const below = rect.bottom + 5;
    panel.style.top = `${Math.max(8, Math.min(below + panel.offsetHeight <= window.innerHeight - 8 ? below : rect.top - panel.offsetHeight - 5, window.innerHeight - panel.offsetHeight - 8))}px`;
  };
  const close = () => {
    if (closed) return;
    closed = true; cancelDrag?.(); panel.remove();
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', escape, true);
    window.removeEventListener('resize', position);
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const outside = event => { if (!panel.contains(event.target) && !anchor.contains(event.target)) close(); };
  const escape = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  };
  const move = (from, to) => {
    if (to < 0 || to >= draft.length || from === to) return;
    const [rule] = draft.splice(from, 1); draft.splice(to, 0, rule); draw();
    list.children[to]?.querySelector('select')?.focus();
  };
  const bindDrag = (handle, index) => {
    let pointerId = null;
    let target = index;
    const finish = accept => {
      if (pointerId === null) return;
      const id = pointerId; pointerId = null;
      if (handle.hasPointerCapture?.(id)) handle.releasePointerCapture(id);
      list.querySelectorAll('.lm-sort-rule-target').forEach(row => row.classList.remove('lm-sort-rule-target'));
      cancelDrag = null;
      if (accept) move(index, target);
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); cancelDrag?.();
      pointerId = event.pointerId; target = index;
      handle.setPointerCapture?.(pointerId); cancelDrag = () => finish(false);
    });
    handle.addEventListener('pointermove', event => {
      if (pointerId !== event.pointerId) return;
      const row = document.elementFromPoint?.(event.clientX, event.clientY)?.closest('.lm-sort-rule');
      if (!row || !list.contains(row)) return;
      target = Number(row.dataset.index);
      list.querySelectorAll('.lm-sort-rule-target').forEach(item => item.classList.remove('lm-sort-rule-target'));
      row.classList.add('lm-sort-rule-target');
    });
    handle.addEventListener('pointerup', event => { if (pointerId === event.pointerId) finish(true); });
    handle.addEventListener('pointercancel', () => finish(false));
    handle.addEventListener('lostpointercapture', () => finish(false));
  };
  const add = makeButton(`＋ ${t('sortAddRule')}`, t('sortAddRule'), () => {
    const field = SORT_FIELDS.find(field => !draft.some(rule => rule.field === field));
    if (!field) return;
    draft.push({ field, direction: ['active', 'strength'].includes(field) ? 'desc' : 'asc' });
    draw(); list.lastElementChild?.querySelector('select')?.focus();
  });
  function draw() {
    list.replaceChildren();
    draft.forEach((rule, index) => {
      const row = document.createElement('div'); row.className = 'lm-sort-rule'; row.dataset.index = index;
      const grip = makeButton('⠿', t('sortReorder'), () => {}); grip.classList.add('lm-sort-grip'); bindDrag(grip, index);
      const number = document.createElement('span'); number.textContent = index + 1;
      const field = document.createElement('select'); field.setAttribute('aria-label', t('sortField'));
      for (const key of SORT_FIELDS) {
        const option = new Option(t(fieldLabels[key]), key);
        option.disabled = key !== rule.field && draft.some(item => item.field === key);
        field.append(option);
      }
      field.value = rule.field;
      field.addEventListener('change', () => {
        rule.field = field.value;
        rule.direction = ['active', 'strength'].includes(rule.field) ? 'desc' : 'asc';
        draw(); list.children[index].querySelector('select').focus();
      });
      const direction = document.createElement('select'); direction.setAttribute('aria-label', t('sortDirection'));
      for (const key of ['asc', 'desc']) direction.append(new Option(t(directionLabels[rule.field][key]), key));
      direction.value = rule.direction;
      direction.addEventListener('change', () => { rule.direction = direction.value; updateSummary(); });
      const up = makeButton('↑', t('sortUp'), () => move(index, index - 1)); up.disabled = index === 0;
      const down = makeButton('↓', t('sortDown'), () => move(index, index + 1)); down.disabled = index === draft.length - 1;
      const remove = makeButton('×', t('sortRemove'), () => { draft.splice(index, 1); draw(); }); remove.disabled = draft.length === 1;
      row.append(grip, number, field, direction, up, down, remove); list.append(row);
    });
    add.disabled = draft.length === SORT_FIELDS.length;
    updateSummary(); position();
  }
  function updateSummary() {
    summary.textContent = draft.map((rule, index) => `${index + 1}. ${t(fieldLabels[rule.field])} · ${t(directionLabels[rule.field][rule.direction])}`).join(' → ');
  }
  const footer = document.createElement('div'); footer.className = 'lm-sort-footer';
  footer.append(makeButton(t('cancel'), t('cancel'), close), makeButton(t('sortApply'), t('sortApply'), () => {
    const result = normalizeSortRules(draft); close(); onApply(result);
    try {
      localStorage.setItem(SORT_PREFERENCE_KEY, JSON.stringify(result));
    } catch {
      // Sorting must still work when browser storage is unavailable.
    }
  }));
  panel.append(heading, help, list, add, summary, footer);
  panel.addEventListener('pointerdown', event => event.stopPropagation());
  panel.addEventListener('keydown', event => event.stopPropagation());
  panel.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
  document.body.append(panel); draw();
  window.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', escape, true);
  window.addEventListener('resize', position);
  list.querySelector('select')?.focus();
  return close;
}
