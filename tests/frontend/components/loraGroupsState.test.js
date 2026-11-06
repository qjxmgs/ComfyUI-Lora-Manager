import { describe, expect, it } from 'vitest';
import {
  normalizeGroupConfig, normalizeGroupedEntries, changeGroupMode, setGroupedActive,
  moveGroupedEntry, previewGroupResize, resolveGroupResize,
} from '../../../web/comfyui/lora_groups_state.js';

const config = () => normalizeGroupConfig({ rows: 2, columns: 2, groups: [
  { id: 'training', title: 'Training', mode: 'single' },
  { id: 'style', title: 'Style', mode: 'multi' },
  { id: 'character', title: 'Character', mode: 'single' },
  { id: 'detail', title: 'Detail', mode: 'multi' },
] });
const entry = (name, groupId, active = true) => ({ name, groupId, active, strength: 0.8, clipStrength: 0, expanded: true });

describe('LoRA group state', () => {
  it('migrates a legacy list without changing order, weights, or active state', () => {
    const groups = normalizeGroupConfig(undefined);
    const old = [entry('B', undefined, false), entry('A', undefined)];
    expect(normalizeGroupedEntries(old, groups)).toEqual(old.map(item => ({ ...item, groupId: groups.groups[0].id })));
    expect(groups).toMatchObject({ version: 2, rows: 1, columns: 1, groups: [{ mode: 'multi' }] });
  });

  it('normalizes damaged dimensions and duplicate IDs without allocating an unbounded grid', () => {
    expect(normalizeGroupConfig({ rows: 1e10, columns: 1e10 }).groups).toHaveLength(1);
    const groups = normalizeGroupConfig({ rows: 1, columns: 2, groups: [{ id: 'same' }, { id: 'same' }] });
    expect(new Set(groups.groups.map(group => group.id)).size).toBe(2);
  });

  it('keeps the destination winner when adding multiple enabled training rounds', () => {
    const old = [entry('epoch10', 'training')];
    const result = normalizeGroupedEntries([...old, entry('epoch20', undefined), entry('epoch30', undefined)], config(), old, 'training');
    expect(result.map(item => item.active)).toEqual([true, false, false]);
    expect(result.every(item => item.groupId === 'training')).toBe(true);
  });

  it('chooses the first enabled new entry in an empty single group', () => {
    const result = normalizeGroupedEntries([entry('A', 'training', false), entry('B', 'training'), entry('C', 'training')], config());
    expect(result.filter(item => item.active).map(item => item.name)).toEqual(['B']);
  });

  it('switches a single group atomically and permits disabling its last item', () => {
    const old = [entry('A', 'training'), entry('B', 'training', false), entry('C', 'style')];
    const switched = setGroupedActive(old, config(), 'B', true);
    expect(switched.map(item => item.active)).toEqual([false, true, true]);
    expect(setGroupedActive(switched, config(), 'B', false).map(item => item.active)).toEqual([false, false, true]);
    expect(old[0].active).toBe(true);
  });

  it('multi to single prefers the focused active item and preserves disabled focus', () => {
    const values = [entry('A', 'style'), entry('B', 'style'), entry('C', 'style', false)];
    expect(changeGroupMode(config(), values, 'style', 'single', 'B').entries.map(item => item.active)).toEqual([false, true, false]);
    const result = changeGroupMode(config(), values, 'style', 'single', 'C');
    expect(result.entries.map(item => item.active)).toEqual([true, false, false]);
    expect(changeGroupMode(result.config, result.entries, 'style', 'multi').entries).toEqual(result.entries);
  });

  it('preserves membership on text merges and sends only new names to the target', () => {
    const old = [entry('A', 'style'), entry('B', 'training')];
    const values = [entry('A', undefined), entry('B', undefined), entry('C', undefined)];
    expect(normalizeGroupedEntries(values, config(), old, 'detail').map(item => [item.name, item.groupId]))
      .toEqual([['B', 'training'], ['A', 'style'], ['C', 'detail']]);
  });

  it('deduplicates by existing name rules and uses the last occurrence', () => {
    const values = [entry('A', 'style'), entry('A', 'detail', false)];
    expect(normalizeGroupedEntries(values, config())).toEqual([values[1]]);
  });

  it('moves an enabled item into a single group without displacing its winner', () => {
    const old = [entry('A', 'training'), entry('B', 'style')];
    const result = moveGroupedEntry(old, config(), 'B', 'training', 'A');
    expect(result.map(item => [item.name, item.active])).toEqual([['B', false], ['A', true]]);
    expect(result[0].clipStrength).toBe(0);
    expect(old[1].groupId).toBe('style');
  });

  it('reshapes the same groups without changing execution order or IDs', () => {
    const old = config();
    const entries = [entry('A', 'training'), entry('B', 'style')];
    const result = resolveGroupResize(previewGroupResize(old, entries, 1, 4));
    expect(result.config.groups).toEqual(old.groups);
    expect(result.entries).toEqual(entries);
  });

  it('adds empty multi groups while retaining all original metadata', () => {
    const old = config();
    const preview = previewGroupResize(old, [], 2, 3);
    expect(preview.config.groups.slice(0, 4)).toEqual(old.groups);
    expect(preview.config.groups.slice(4).every(group => group.mode === 'multi')).toBe(true);
  });

  it('requires an explicit destination and winner before a shrinking merge', () => {
    const old = config();
    const entries = [entry('A', 'training'), entry('B', 'character'), entry('C', 'detail')];
    const snapshot = JSON.stringify({ old, entries });
    expect(() => resolveGroupResize(previewGroupResize(old, entries, 1, 2))).toThrow('destination');
    const preview = previewGroupResize(old, entries, 1, 2, { character: 'training', detail: 'style' });
    expect(preview.conflicts).toHaveLength(1);
    expect(() => resolveGroupResize(preview)).toThrow('remains enabled');
    expect(resolveGroupResize(preview, { training: 'B' }).entries.map(item => [item.name, item.active]))
      .toEqual([['A', false], ['B', true], ['C', true]]);
    expect(resolveGroupResize(preview, { training: null }).entries.filter(item => item.groupId === 'training').every(item => !item.active)).toBe(true);
    expect(JSON.stringify({ old, entries })).toBe(snapshot);
  });
});
