import { describe, it, expect } from 'vitest';
import { assignAddedOrders, sortGroupEntries, normalizeSortRules, normalizeGroupConfig, moveGroupedEntry, previewGroupResize, resolveGroupResize } from '../../../web/comfyui/lora_groups_state.js';
import { mergeLoras } from '../../../web/comfyui/utils.js';

const entries = [
  { name: 'step10', groupId: 'group-1', strength: -1, active: true, addedOrder: 2 },
  { name: 'step2', groupId: 'group-1', strength: 0, active: false, addedOrder: 0 },
  { name: 'step3', groupId: 'group-1', strength: .8, active: true, addedOrder: 1 },
  { name: 'untouched', groupId: 'group-2', strength: 10, active: true, addedOrder: 3 },
];
describe('group sorting', () => {
  it.each([
    ['addedOrder', 'asc', ['step2', 'step3', 'step10']], ['addedOrder', 'desc', ['step10', 'step3', 'step2']],
    ['strength', 'asc', ['step10', 'step2', 'step3']], ['strength', 'desc', ['step3', 'step2', 'step10']],
    ['active', 'asc', ['step2', 'step10', 'step3']], ['active', 'desc', ['step10', 'step3', 'step2']],
    ['name', 'asc', ['step2', 'step3', 'step10']], ['name', 'desc', ['step10', 'step3', 'step2']],
  ])('sorts %s %s without changing entry data or other groups', (field, direction, names) => {
    const result = sortGroupEntries(entries, 'group-1', [{ field, direction }]);
    expect(result.map(item => item.name)).toEqual([...names, 'untouched']);
    result.forEach(item => expect(item).toBe(entries.find(old => old.name === item.name)));
  });
  it('compares priority rules and preserves ties including case-insensitive names', () => {
    const rules = [{ field: 'active', direction: 'desc' }, { field: 'strength', direction: 'desc' }];
    expect(sortGroupEntries(entries, 'group-1', rules).map(item => item.name)).toEqual(['step3', 'step10', 'step2', 'untouched']);
    const tied = ['dir/STEP2', 'other/step2', 'step10'].map(name => ({ name, groupId: 'g' }));
    expect(sortGroupEntries(tied, 'g', [{ field: 'name', direction: 'asc' }])).toEqual(tied);
  });
  it('repairs invalid or repeated rules and retains target rules during a merge', () => {
    expect(normalizeSortRules([{ field: 'oops' }])).toEqual([{ field: 'addedOrder', direction: 'asc' }]);
    const rules = [{ field: 'strength', direction: 'desc' }];
    expect(normalizeSortRules([...rules, ...rules])).toEqual(rules);
    const config = normalizeGroupConfig({ rows: 1, columns: 2, groups: [{ sortRules: rules }] });
    const result = resolveGroupResize(previewGroupResize(config, entries, 1, 1, { 'group-2': 'group-1' }));
    expect(result.config.groups[0].sortRules).toEqual(rules);
    expect(result.entries.map(item => item.name)).toEqual(entries.map(item => item.name));
  });
});
describe('persistent addition order', () => {
  it('migrates in input order, retains metadata through text merge, movement and JSON reload', () => {
    const legacy = entries.map(({ addedOrder, ...item }) => item);
    const assigned = assignAddedOrders(legacy);
    expect(assigned.entries.map(item => item.addedOrder)).toEqual([0, 1, 2, 3]);
    expect(assigned.nextAddedOrder).toBe(4);
    const merged = mergeLoras('<lora:step10:1><lora:step2:1><lora:step3:1><lora:untouched:1>', assigned.entries);
    expect(merged.map(item => item.addedOrder)).toEqual([0, 1, 2, 3]);
    const moved = moveGroupedEntry(merged, normalizeGroupConfig({ rows: 1, columns: 2 }), 'step10', 'group-2');
    expect(moved.find(item => item.name === 'step10').addedOrder).toBe(0);
    expect(assignAddedOrders(JSON.parse(JSON.stringify(moved)), 4).entries).toEqual(moved);
  });
  it('preserves original order on duplicates and allocates new orders for re-added or batched entries', () => {
    const old = assignAddedOrders([{ name: 'A' }, { name: 'B' }]);
    const duplicate = assignAddedOrders([{ name: 'A' }, { name: 'A', addedOrder: 99 }], old.nextAddedOrder, old.entries);
    expect(duplicate.entries.map(item => item.addedOrder)).toEqual([0, 0]);
    const remaining = assignAddedOrders([old.entries[1]], old.nextAddedOrder, old.entries);
    const added = assignAddedOrders([...remaining.entries, { name: 'A' }, { name: 'C' }], remaining.nextAddedOrder, remaining.entries);
    expect(added.entries.map(item => item.addedOrder)).toEqual([1, 2, 3]);
  });
});
