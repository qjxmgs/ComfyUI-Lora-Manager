// Group metadata stays in the workflow; execution still consumes flat entries.
export const GROUPS_PROPERTY = 'lmLoraGroups';
export const GROUP_MIN_WIDTH = 200;
export const GROUP_MIN_HEIGHT = 120;
export const GROUP_COLORS = ['red', 'coral', 'orange', 'peach', 'amber', 'yellow', 'olive', 'green', 'mint', 'teal', 'cyan', 'sky', 'blue', 'navy', 'indigo', 'purple', 'lavender', 'pink', 'rose', 'brown', 'slate', 'gray', 'white', 'black', 'rgb', 'gbr', 'brg'];
export const SORT_FIELDS = ['addedOrder', 'active', 'strength', 'name'];

export function normalizeSortRules(rules) {
  const seen = new Set();
  const result = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!SORT_FIELDS.includes(rule?.field) || seen.has(rule.field)) continue;
    seen.add(rule.field);
    result.push({ field: rule.field, direction: rule.direction === 'desc' ? 'desc' : 'asc' });
  }
  return result.length ? result : [{ field: 'addedOrder', direction: 'asc' }];
}

// Allocate before grouping so legacy lists and batch additions retain their original order.
export function assignAddedOrders(entries, counter = 0, previous = []) {
  const valid = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
  const old = new Map(previous.map(entry => [entry.name, entry.addedOrder]));
  const values = Array.isArray(entries) ? entries : [];
  let next = valid(counter) ? counter : 0;
  for (const entry of [...previous, ...values]) {
    if (valid(entry?.addedOrder)) next = Math.max(next, entry.addedOrder + 1);
  }
  const assigned = new Map();
  const used = new Set();
  const result = values.map(entry => {
    if (!entry || typeof entry.name !== 'string') return entry;
    if (!assigned.has(entry.name)) {
      let order = old.get(entry.name) ?? entry.addedOrder;
      if (!valid(order) || used.has(order)) order = next++;
      used.add(order); assigned.set(entry.name, order);
    }
    return { ...entry, addedOrder: assigned.get(entry.name) };
  });
  return { entries: result, nextAddedOrder: next };
}

export function sortGroupEntries(entries, groupId, rules, locale = 'en') {
  const normalized = normalizeSortRules(rules);
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const filename = name => String(name).split(/[\\/]/).pop();
  const sorted = entries.filter(entry => entry.groupId === groupId).map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      for (const { field, direction } of normalized) {
        let comparison;
        if (field === 'name') comparison = collator.compare(filename(a.entry.name), filename(b.entry.name));
        else {
          const left = field === 'active' ? Number(!!a.entry.active) : Number(a.entry[field]);
          const right = field === 'active' ? Number(!!b.entry.active) : Number(b.entry[field]);
          if (!Number.isFinite(left) || !Number.isFinite(right)) {
            comparison = Number(!Number.isFinite(left)) - Number(!Number.isFinite(right));
            if (comparison) return comparison;
            continue;
          }
          comparison = left - right;
        }
        if (comparison) return direction === 'desc' ? -comparison : comparison;
      }
      return a.index - b.index;
    }).map(item => item.entry);
  let index = 0;
  return entries.map(entry => entry.groupId === groupId ? sorted[index++] : entry);
}

export function normalizeGroupConfig(value, defaultTitle = 'Default group') {
  const dimension = n => Number.isSafeInteger(n) && n > 0 ? n : 1;
  let rows = dimension(value?.rows);
  let columns = dimension(value?.columns);
  // Bound untrusted workflow data before allocating DOM or arrays.
  if (rows * columns > 256) rows = columns = 1;
  const used = new Set();
  const groups = Array.from({ length: rows * columns }, (_, index) => {
    const source = value?.groups?.[index];
    let id = typeof source?.id === 'string' && source.id ? source.id : `group-${index + 1}`;
    while (used.has(id)) id += '-new';
    used.add(id);
    return {
      id,
      title: typeof source?.title === 'string' && source.title.trim()
        ? source.title.trim() : index === 0 ? defaultTitle : `Group ${index + 1}`,
      mode: source?.mode === 'single' ? 'single' : 'multi',
      sortRules: normalizeSortRules(source?.sortRules),
      titleColor: GROUP_COLORS.includes(source?.titleColor) ? source.titleColor : null,
    };
  });
  return { version: 2, rows, columns, groups, nextAddedOrder: Number.isSafeInteger(value?.nextAddedOrder) && value.nextAddedOrder >= 0 ? value.nextAddedOrder : 0 };
}

export function normalizeGroupedEntries(entries, config, previous = [], targetId = config.groups[0].id) {
  const ids = new Set(config.groups.map(group => group.id));
  const old = new Map(previous.map(entry => [entry.name, entry]));
  const unique = new Map();
  for (const item of Array.isArray(entries) ? entries : []) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    const previousEntry = old.get(item.name);
    const groupId = ids.has(item.groupId) ? item.groupId
      : ids.has(previousEntry?.groupId) ? previousEntry.groupId
        : ids.has(targetId) ? targetId : config.groups[0].id;
    unique.delete(item.name);
    unique.set(item.name, { ...item, groupId });
  }
  return config.groups.flatMap(group => {
    const members = [...unique.values()].filter(entry => entry.groupId === group.id);
    if (group.mode === 'single') {
      const winner = members.find(entry => entry.active && old.get(entry.name)?.active
        && old.get(entry.name)?.groupId === group.id) || members.find(entry => entry.active);
      return members.map(entry => ({ ...entry, active: entry === winner }));
    }
    return members;
  });
}

export function changeGroupMode(config, entries, groupId, mode, focusedName) {
  const next = { ...config, groups: config.groups.map(group => group.id === groupId ? { ...group, mode } : group) };
  const active = entries.filter(entry => entry.groupId === groupId && entry.active);
  const winner = active.find(entry => entry.name === focusedName) || active[0];
  const values = entries.map(entry => mode === 'single' && entry.groupId === groupId
    ? { ...entry, active: entry.name === winner?.name } : { ...entry });
  return { config: next, entries: normalizeGroupedEntries(values, next) };
}

export function setGroupedActive(entries, config, name, active) {
  const item = entries.find(entry => entry.name === name);
  const single = config.groups.find(group => group.id === item?.groupId)?.mode === 'single';
  return entries.map(entry => entry.name === name ? { ...entry, active }
    : active && single && entry.groupId === item.groupId ? { ...entry, active: false } : { ...entry });
}

export function moveGroupedEntry(entries, config, name, targetId, beforeName = null) {
  return moveGroupedEntries(entries, config, [name], targetId, beforeName);
}

export function moveGroupedEntries(entries, config, names, targetId, beforeName = null) {
  const selected = new Set(names);
  const moving = entries.filter(entry => selected.has(entry.name));
  if (!moving.length || !config.groups.some(group => group.id === targetId)) return entries;
  const next = entries.filter(entry => !selected.has(entry.name)).map(entry => ({ ...entry }));
  const before = next.findIndex(entry => entry.name === beforeName && entry.groupId === targetId);
  next.splice(before < 0 ? next.length : before, 0, ...moving.map(item => ({ ...item, groupId: targetId })));
  return normalizeGroupedEntries(next, config, entries, targetId);
}

export function previewGroupResize(config, entries, rows, columns, targets = {}) {
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1 || rows * columns > 256) {
    throw new Error('Invalid grid dimensions');
  }
  const next = normalizeGroupConfig({ ...config, rows, columns });
  const ids = new Set(next.groups.map(group => group.id));
  const removed = config.groups.filter(group => !ids.has(group.id));
  const pending = removed.filter(group => entries.some(entry => entry.groupId === group.id) && !ids.has(targets[group.id]));
  const values = entries.map(entry => ({
    ...entry,
    groupId: ids.has(entry.groupId) ? entry.groupId : targets[entry.groupId],
  }));
  const conflicts = next.groups.filter(group => group.mode === 'single').map(group => ({
    group,
    entries: values.filter(entry => entry.groupId === group.id && entry.active),
  })).filter(conflict => conflict.entries.length > 1);
  return { config: next, entries: values, removed, pending, conflicts };
}

export function resolveGroupResize(preview, winners = {}) {
  if (preview.pending.length) throw new Error('Choose a destination for every non-empty group');
  for (const conflict of preview.conflicts) {
    const winner = winners[conflict.group.id];
    if (winner !== null && !conflict.entries.some(entry => entry.name === winner)) {
      throw new Error('Choose which LoRA remains enabled');
    }
  }
  const conflicting = new Set(preview.conflicts.map(conflict => conflict.group.id));
  return {
    config: preview.config,
    entries: normalizeGroupedEntries(preview.entries.map(entry => conflicting.has(entry.groupId)
      ? { ...entry, active: entry.name === winners[entry.groupId] } : entry), preview.config),
  };
}
