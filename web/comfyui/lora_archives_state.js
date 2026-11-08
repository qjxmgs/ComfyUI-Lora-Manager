import { normalizeGroupConfig } from './lora_groups_state.js';

export const ARCHIVE_PROPERTY = 'lmGridArchiveId';
export const DEFAULT_PRIMARY = 'uncategorized';
export const DEFAULT_SECONDARY = 'default';

export function gridSnapshot(config, entries, size) {
  const groupConfig = normalizeGroupConfig(config);
  return {
    version: 1,
    groupConfig,
    entries: entries.map(entry => ({
      name: entry.name, groupId: entry.groupId,
      strength: Number(entry.strength), clipStrength: Number(entry.clipStrength ?? entry.strength),
      active: !!entry.active, expanded: !!entry.expanded, locked: !!entry.locked,
      addedOrder: entry.addedOrder ?? 0,
    })),
    nodeSize: Array.from(size || [600, 420]).map(Number),
  };
}

export function snapshotFingerprint(snapshot) {
  const normalized = gridSnapshot(snapshot.groupConfig, snapshot.entries, snapshot.nodeSize);
  // Allocation may advance during workflow restoration without changing any entry.
  // Keep each entry's addedOrder: it determines the user-visible added-order sort.
  delete normalized.groupConfig.nextAddedOrder;
  return JSON.stringify(normalized);
}

export function activeArchiveEntries(snapshot) {
  return snapshot.groupConfig.groups.flatMap(group => group.enabled !== false
    ? snapshot.entries.filter(entry => entry.groupId === group.id && entry.active) : []);
}

export function ordered(items) {
  return [...items].sort((a, b) => a.order - b.order);
}

export function archivePath(library, archive, label = item => item.name) {
  const secondary = library.categories.find(item => item.id === archive.categoryId);
  const primary = library.categories.find(item => item.id === secondary?.parentId);
  return [primary, secondary].filter(Boolean).map(label).join(' / ');
}
