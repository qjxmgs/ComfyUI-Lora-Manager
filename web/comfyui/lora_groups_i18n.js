import { api } from '../../scripts/api.js';
import { app } from '../../scripts/app.js';

// Keep the synchronous widget factory usable before locale requests finish.
export const GROUP_MESSAGES = {
  sort: "Sort",
  sortRules: "Sort rules",
  sortHelp: "Compare rules in priority order. Sorting runs only when you apply it.",
  sortAdded: "Added order",
  sortActive: "Enabled state",
  sortName: "Filename",
  sortOldest: "Oldest first",
  sortNewest: "Newest first",
  sortActiveFirst: "Enabled first",
  sortInactiveFirst: "Disabled first",
  sortSmallest: "Smallest first",
  sortLargest: "Largest first",
  sortAscending: "Ascending",
  sortDescending: "Descending",
  sortAddRule: "Add rule",
  sortReorder: "Drag to reorder rules",
  sortField: "Sort field",
  sortDirection: "Sort direction",
  sortUp: "Move rule up",
  sortDown: "Move rule down",
  sortRemove: "Remove rule",
  sortApply: "Apply sort",
  defaultGroup: 'Default group', group: 'Group {number}', rows: 'Rows', columns: 'Columns',
  apply: 'Apply', single: 'Single', multi: 'Multi', rename: 'Rename group',
  add: 'Add LoRAs', menu: 'Group actions', empty: 'Add LoRAs or drag them here',
  target: 'New LoRAs will be added to this group', disableAll: 'Disable all', enableAll: 'Enable all',
  strength: 'Model strength', clip: 'CLIP strength', cancel: 'Cancel', confirm: 'Confirm',
  search: 'Search filename or model name', loading: 'Loading LoRAs...', loadFailed: 'Could not load LoRAs. Try again.',
  selectResults: 'Select matching results', clearSelection: 'Clear selection', more: 'Showing {shown} of {total} matches. Refine your search.',
  selected: '{count} selected', existing: 'Already in {group}', moveTo: 'Move to group',
  resize: 'Merge groups before resizing', destination: 'Merge {group} into', choose: 'Choose...',
  keepActive: 'Keep enabled in {group}', none: 'Disable all', enabled: 'Enabled', disabled: 'Disabled',
  noChanges: 'No LoRAs to merge.', tooSmall: 'Enlarge this node first. Each group needs at least 200 × 120 px.',
  invalidSize: 'Enter positive whole numbers for rows and columns.',
  modeChanged: 'Single selection: kept {name}. Other LoRAs in this group were disabled.',
  movedInactive: 'The destination already has an enabled LoRA. The moved LoRA was disabled.',
};

const localeRequests = new Map();
export async function loadGroupMessages() {
  let locale = app.ui?.settings?.getSettingValue?.('Comfy.Locale') || 'en';
  if (locale === 'zh') locale = 'zh-CN';
  if (!['en', 'zh-CN', 'zh-TW', 'ja', 'ru', 'de', 'fr', 'es', 'ko', 'he'].includes(locale)) locale = 'en';
  if (!localeRequests.has(locale)) {
    localeRequests.set(locale, (async () => {
      try {
        const response = await api.fetchApi(`/locales/${locale}.json`);
        if (!response?.ok) return GROUP_MESSAGES;
        const data = await response.json();
        const translations = Object.fromEntries(Object.entries(data?.loraGroups || {})
          .filter(([, value]) => typeof value === 'string' && !value.startsWith('[TODO: Translate]')));
        return { ...GROUP_MESSAGES, ...translations };
      } catch {
        return GROUP_MESSAGES;
      }
    })());
  }
  return localeRequests.get(locale);
}
