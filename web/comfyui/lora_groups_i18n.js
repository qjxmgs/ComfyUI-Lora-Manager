import { api } from '../../scripts/api.js';
import { app } from '../../scripts/app.js';
import { lmUrl } from './base_path.js';
import { ARCHIVE_MESSAGES } from './lora_archives_i18n.js';

// Keep the synchronous widget factory usable before locale requests finish.
export const GROUP_MESSAGES = {
  ...ARCHIVE_MESSAGES,
  menuViewCivitai: "View on Civitai",
  menuOnlySelected: "Only select these",
  menuCopyNotes: "Copy Notes",
  menuCopyTriggerWords: "Copy Trigger Words",
  menuSaveRecipe: "Save Recipe",
  menuSaveWorkflow: "Save Recipe with Workflow",
  markerClear: "Clear marker",
  markerAs: "Mark as",
  markerExclude: "Exclude from Send Targets",
  markerPrompt: "Send Prompt Target",
  markerParams: "Send Gen Params Target",
  markerModel: "Meta hints: Primary Model",
  markerSampler: "Meta hints: Primary Sampler",
  markerPositive: "Meta hints: Positive Prompt",
  markerNegative: "Meta hints: Negative Prompt",
  "deleteGroup": "Delete grid",
  "deleteGroupConfirm": "Delete grid {name} and its {count} LoRA entries? Model files are kept. This can be undone. If it is the last grid, an empty grid will remain.",
  "nodeSettings": "Node settings",
  "activeCount": "Active: {count}",
  "noActive": "No active LoRAs",
  "animaMode": "Anima 2.9B mode",
  "animaHelp": "Load older 28-layer Anima LoRAs into the 40-layer Anima 2.9B model using in-memory remapping.",
  enableGroup: "Enable group",
  disableGroup: "Disable group",
  color_rgb: "RGB gradient",
  color_gbr: "GBR gradient",
  color_brg: "BRG gradient",
  color_coral: "Coral",
  color_peach: "Peach",
  color_amber: "Amber",
  color_olive: "Olive",
  color_mint: "Mint",
  color_teal: "Teal",
  color_sky: "Sky blue",
  color_navy: "Navy blue",
  color_lavender: "Lavender",
  color_indigo: "Indigo",
  color_rose: "Rose",
  color_slate: "Slate",
  titleColor: "Color",
  defaultColor: "Default color",
  color_red: "Red",
  color_orange: "Orange",
  color_yellow: "Yellow",
  color_green: "Green",
  color_cyan: "Cyan",
  color_blue: "Blue",
  color_purple: "Purple",
  color_pink: "Pink",
  color_brown: "Brown",
  color_gray: "Gray",
  color_white: "White",
  color_black: "Black",
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
  strength: 'Model strength', clip: 'CLIP strength', allWeights: 'Set all LoRA weights', mixedWeights: 'Mixed', cancel: 'Cancel', confirm: 'Confirm',
  search: 'Search filename or model name', loading: 'Loading LoRAs...', loadFailed: 'Could not load LoRAs. Try again.',
  refreshList: 'Refresh LoRA files',
  autoCycle: 'Cycle LoRAs after each successful task (including batch queues)',
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
const TRIGGER_WORD_MESSAGES = {
  bulkTriggerWordsMenu: ['loras.bulkOperations.setTriggerWords', 'Set Trigger Words for Selected'],
  bulkTriggerWordsTitle: ['modals.bulkTriggerWords.title', 'Set Trigger Words for Multiple LoRAs'],
  bulkTriggerWordsDescription: ['modals.bulkTriggerWords.description', 'Replace trigger words for {count} selected LoRA(s).'],
  bulkTriggerWordsPlaceholder: ['modals.bulkTriggerWords.placeholder', 'Enter one trigger word or phrase per line...'],
  bulkTriggerWordsHelp: ['modals.bulkTriggerWords.help', 'One entry per line. Commas within a phrase are preserved. These entries replace all existing trigger words on each selected LoRA.'],
  bulkTriggerWordsSave: ['modals.bulkTriggerWords.save', 'Replace Trigger Words'],
  bulkTriggerWordsEmpty: ['toast.models.bulkTriggerWordsEmpty', 'Enter at least one trigger word or phrase'],
  bulkTriggerWordsSuccess: ['toast.models.bulkTriggerWordsSuccess', 'Updated trigger words for {count} LoRA(s)'],
  bulkTriggerWordsFailed: ['toast.models.bulkTriggerWordsFailed', 'Failed to update trigger words for {count} LoRA(s)'],
  triggerWordsTooMany: ['toast.triggerWords.tooMany', 'Maximum 100 trigger words allowed'],
  triggerWordsTooLong: ['toast.triggerWords.tooLong', 'Trigger word or phrase is too long'],
};
Object.assign(GROUP_MESSAGES, Object.fromEntries(Object.entries(TRIGGER_WORD_MESSAGES).map(([key, [, fallback]]) => [key, fallback])));
export async function loadGroupMessages() {
  let locale = app.extensionManager?.setting?.get?.('Comfy.Locale')
    || app.ui?.settings?.getSettingValue?.('Comfy.Locale') || 'en';
  if (locale === 'zh') locale = 'zh-CN';
  if (!['en', 'zh-CN', 'zh-TW', 'ja', 'ru', 'de', 'fr', 'es', 'ko', 'he'].includes(locale)) locale = 'en';
  if (!localeRequests.has(locale)) {
    localeRequests.set(locale, (async () => {
      try {
        // Locale files are static routes, not /api routes. Modern fetchApi adds /api.
        const path = `/locales/${locale}.json`;
        const response = await fetch(api.fileURL?.(path) ?? lmUrl(path), { cache: 'no-cache' });
        if (!response?.ok) throw new Error(`Locale request failed: ${response?.status}`);
        const data = await response.json();
        const translations = Object.fromEntries(Object.entries(data?.loraGroups || {})
          .filter(([, value]) => typeof value === 'string' && !value.startsWith('[TODO: Translate]')));
        for (const [key, [path]] of Object.entries(TRIGGER_WORD_MESSAGES)) {
          const value = path.split('.').reduce((current, part) => current?.[part], data);
          if (typeof value === 'string' && !value.startsWith('[TODO: Translate]')) translations[key] = value;
        }
        return { ...GROUP_MESSAGES, ...translations };
      } catch (error) {
        localeRequests.delete(locale);
        console.warn('LoRA Manager: could not load group translations.', error);
        return GROUP_MESSAGES;
      }
    })());
  }
  return localeRequests.get(locale);
}
