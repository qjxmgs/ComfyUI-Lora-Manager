import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { APP, API, fetchApi, toast, callbacks, getSettingValue } = vi.hoisted(() => ({
  APP: new URL('../../../scripts/app.js', import.meta.url).pathname,
  API: new URL('../../../scripts/api.js', import.meta.url).pathname,
  fetchApi: vi.fn(), toast: vi.fn(), callbacks: { selection: vi.fn() }, getSettingValue: vi.fn(),
}));
vi.mock(APP, () => ({ app: {
  registerExtension: vi.fn(), ui: { settings: { getSettingValue } },
  canvas: { emitBeforeChange: vi.fn(), emitAfterChange: vi.fn(), ds: { scale: 1 } },
  extensionManager: { toast: { add: toast } },
} }));
vi.mock(API, () => ({ api: { fetchApi, addEventListener: vi.fn() } }));
vi.mock('../../../web/comfyui/lm_styles_loader.js', () => ({ ensureLmStyles: vi.fn() }));
vi.mock('../../../web/comfyui/preview_tooltip.js', () => ({ PreviewTooltip: class { hide() {} cleanup() {} show() {} } }));
vi.mock('../../../web/comfyui/settings.js', () => ({
  getStrengthStepPreference: () => .05, getNodeLoraNameDisplayPreference: () => 'file_name', onNodeLoraNameDisplayChanged: () => () => {},
}));
vi.mock('../../../web/comfyui/loras_widget_utils.js', async importOriginal => ({
  ...await importOriginal(), getAvailableLoras: async () => new Set(), getAvailableLorasSync: () => new Set(),
  isLoraNameAvailable: () => true, onLibraryChanged: () => () => {},
}));

import { addLorasWidget } from '../../../web/comfyui/loras_widget.js';
import { mergeLoras } from '../../../web/comfyui/utils.js';
import { normalizeGroupConfig } from '../../../web/comfyui/lora_groups_state.js';
import chineseLocale from '../../../locales/zh-CN.json';

const mounted = [];
const value = (name, groupId = 'group-1', active = true) => ({ name, groupId, active, strength: .8, clipStrength: 0, expanded: false });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const click = (root, text) => {
  const target = [...root.querySelectorAll('button')].find(el => el.textContent === text);
  expect(target, `button ${text}`).toBeTruthy(); target.click();
};
const panels = node => [...node.container.querySelectorAll('.lm-lora-group')];
const row = (node, name) => [...node.container.querySelectorAll('.lm-lora-entry')].find(el => el.dataset.loraName === name);
const snapshot = node => JSON.parse(JSON.stringify({ properties: node.properties, widgets_values: node.widgets.map(widget => widget.value) }));

async function mount(entries = [], state, comfyClass = 'Lora Loader (LoraManager)') {
  const history = [];
  const node = {
    comfyClass, properties: state ? { lmLoraGroups: state } : {}, widgets: [],
    graph: { beforeChange: vi.fn(() => history.push(snapshot(node))), afterChange: vi.fn(), change: vi.fn(), setDirtyCanvas: vi.fn(), trigger: vi.fn(), _version: 0 },
    addDOMWidget(name, type, container, options) {
      const widget = { name };
      Object.defineProperty(widget, 'value', { get: options.getValue, set: options.setValue });
      this.widgets.push(widget); this.container = container; this.widget = widget; return widget;
    },
  };
  addLorasWidget(node, 'loras', { defaultVal: entries, onSelectionChange: callbacks.selection, isAnimaModeNode: comfyClass === 'Lora Loader (LoraManager)' });
  node.widget.callback = vi.fn(); node.history = history;
  document.body.append(node.container); mounted.push(node);
  await flush();
  return node;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.elementFromPoint = vi.fn();
  getSettingValue.mockReturnValue('en');
  vi.stubGlobal('fetch', fetchApi);
  fetchApi.mockResolvedValue({ ok: true, json: async () => ({ loras: [] }) });
});
afterEach(() => {
  mounted.splice(0).forEach(node => node.widget.onRemove());
  document.body.replaceChildren(); vi.unstubAllGlobals();
});

describe('grouped LoRA Loader interactions', () => {
  it('targets the first group by default and routes appended LoRAs to a group selected through empty space', async () => {
    const node = await mount([value('A'), value('B', 'group-2')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    node.widget.value = mergeLoras('<lora:A:0.8> <lora:B:0.8> <lora:C:0.5>', node.widget.value);
    expect(node.widget.value.find(item => item.name === 'C').groupId).toBe('group-1');
    panels(node)[1].querySelector('.lm-group-body').click();
    expect(panels(node).map(panel => panel.dataset.target)).toEqual(['false', 'true']);
    node.widget.value = mergeLoras('<lora:A:0.8> <lora:B:0.8> <lora:C:0.5> <lora:D:0.3>', node.widget.value);
    expect(node.widget.value.find(item => item.name === 'D')).toMatchObject({ groupId: 'group-2', strength: .3 });
    expect(node.widget.value.find(item => item.name === 'A').groupId).toBe('group-1');
    expect(panels(node)[1].dataset.target).toBe('true');
    panels(node)[0].click();
    expect(panels(node).map(panel => panel.dataset.target)).toEqual(['true', 'false']);
  });

  it('deletes the selected batch across groups through the context menu in one undoable operation', async () => {
    const node = await mount([value('A'), value('B'), value('C', 'group-2')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    row(node, 'A').querySelector('.lm-lora-name').click();
    row(node, 'C').querySelector('.lm-lora-name').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
    const saved = snapshot(node);
    row(node, 'A').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    [...document.querySelectorAll('.lm-lora-menu-item')].find(item => item.textContent === 'Delete (2)').click();
    expect(node.widget.value.map(item => item.name)).toEqual(['B']);
    expect(node.history).toHaveLength(1);
    node.properties = structuredClone(saved.properties); node.onConfigure(saved);
    expect(snapshot(node)).toEqual(saved);
    row(node, 'B').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    [...document.querySelectorAll('.lm-lora-menu-item')].find(item => item.textContent === 'Delete').click();
    expect(node.widget.value.map(item => item.name)).toEqual(['A', 'C']);
    expect(node.widget.value.every(item => item.selected)).toBe(true);
  });

  it('adjusts only the hovered focused weight by the configured step and keeps focus and scroll position', async () => {
    const node = await mount([value('A'), { ...value('B'), expanded: true }]);
    const body = panels(node)[0].querySelector('.lm-group-body'); body.scrollTop = 25;
    const input = row(node, 'A').querySelector('.lm-lora-strength-input'); input.focus();
    const wheel = (target, deltaY, ctrlKey = false) => target.dispatchEvent(new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true }));
    wheel(input, -100); wheel(input, -100);
    expect(Number(node.widget.value[0].strength)).toBe(.9);
    expect(Number(node.widget.value[0].clipStrength)).toBe(.9);
    expect(document.activeElement).toBe(input); expect(input.isConnected).toBe(true);
    expect(body.scrollTop).toBe(25);
    wheel(input, 100); expect(Number(node.widget.value[0].strength)).toBe(.85);
    wheel(input, -100, true); expect(Number(node.widget.value[0].strength)).toBe(.85);
    const clip = node.container.querySelector('.lm-lora-clip-strength-input'); clip.focus();
    wheel(clip, 100); expect(Number(node.widget.value[1].clipStrength)).toBe(-.05);
    expect(Number(node.widget.value[1].strength)).toBe(.8);
    wheel(input, 100); expect(Number(node.widget.value[0].strength)).toBe(.85);
    expect(body.scrollTop).toBe(125);
  });

  it.each([0.5, 1, 2])('centers the item marker between rows including expanded CLIP at scale %s', async scale => {
    const node = await mount([{ ...value('A'), expanded: true }, value('B'), value('C')]);
    const body = panels(node)[0].querySelector('.lm-group-body');
    Object.defineProperty(body, 'clientHeight', { value: 200 });
    body.getBoundingClientRect = () => ({ left: 0, width: 200 * scale, top: 0, height: 200 * scale, bottom: 200 * scale });
    row(node, 'A').getBoundingClientRect = () => ({ top: 0, bottom: 20 * scale, height: 20 * scale });
    row(node, 'A').nextElementSibling.getBoundingClientRect = () => ({ top: 23 * scale, bottom: 40 * scale, height: 17 * scale });
    row(node, 'B').getBoundingClientRect = () => ({ top: 46 * scale, bottom: 66 * scale, height: 20 * scale });
    document.elementFromPoint.mockReturnValue(row(node, 'B'));
    const handle = row(node, 'C').querySelector('.lm-lora-name');
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientY: 48 * scale, pointerId: 1, bubbles: true }));
    const marker = document.querySelector('.lm-group-insertion-line');
    expect(parseFloat(marker.style.top) + parseFloat(marker.style.height) / 2).toBeCloseTo(43 * scale);
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    expect(node.widget.value.map(item => item.name)).toEqual(['A', 'C', 'B']);
  });

  it.each([0.5, 1, 2].flatMap(scale => [
    { scale, columns: 3, from: 2, to: 1, axis: 'x', center: 203 },
    { scale, columns: 3, from: 0, to: 1, axis: 'x', center: 409 },
    { scale, columns: 3, from: 4, to: 3, axis: 'y', center: 123 },
    { scale, columns: 3, from: 0, to: 2, axis: 'y', center: 123 },
    { scale, columns: 1, from: 2, to: 1, axis: 'y', center: 123 },
  ]))('centers a group insertion marker in its gap: %j', async ({ scale, columns, from, to, axis, center }) => {
    const node = await mount([], normalizeGroupConfig({ rows: columns === 1 ? 3 : 2, columns }));
    const list = panels(node);
    list.forEach((panel, index) => {
      const left = (index % columns) * 206 * scale;
      const top = Math.floor(index / columns) * 126 * scale;
      panel.getBoundingClientRect = () => ({ left, top, right: left + 200 * scale, bottom: top + 120 * scale, width: 200 * scale, height: 120 * scale });
    });
    document.elementFromPoint.mockReturnValue(list[to]);
    const handle = list[from].querySelector('.lm-group-header');
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 50, pointerId: 1, bubbles: true }));
    const marker = document.querySelector('.lm-group-insertion-line');
    const position = parseFloat(marker.style[axis === 'x' ? 'left' : 'top']);
    const thickness = parseFloat(marker.style[axis === 'x' ? 'width' : 'height']);
    expect(position + thickness / 2).toBeCloseTo(center * scale);
    expect(thickness).toBeLessThan(6 * scale);
    expect(list[to].classList.contains('lm-group-sort-target')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.lm-group-sort-target')).toBeNull();
  });

  it('keeps the marker visible and accepts a drop directly in the gap', async () => {
    const node = await mount([], normalizeGroupConfig({ rows: 1, columns: 3 }));
    const list = panels(node);
    list.forEach((panel, index) => {
      panel.getBoundingClientRect = () => ({ left: index * 206, right: index * 206 + 200, top: 0, bottom: 120, width: 200, height: 120 });
    });
    document.elementFromPoint.mockReturnValue(node.container.querySelector('.lm-groups-grid'));
    const header = list[2].querySelector('.lm-group-header');
    header.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
    header.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 203, clientY: 60, bubbles: true }));
    expect(document.querySelector('.lm-group-insertion-line').hidden).toBe(false);
    header.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    expect(node.properties.lmLoraGroups.groups.map(group => group.id)).toEqual(['group-1', 'group-3', 'group-2']);
  });

  it('selects ranges and toggles individual items independently from activation across groups', async () => {
    const node = await mount([value('A'), value('B'), value('C'), value('D', 'group-2')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    const choose = (name, modifiers = {}) => row(node, name).querySelector('.lm-lora-name').dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers }));
    const names = () => node.widget.value.filter(item => item.selected).map(item => item.name);
    choose('A'); choose('C', { shiftKey: true }); expect(names()).toEqual(['A', 'B', 'C']);
    choose('B', { ctrlKey: true }); expect(names()).toEqual(['A', 'C']);
    choose('D', { ctrlKey: true }); expect(names()).toEqual(['A', 'C', 'D']);
    expect(node.widget.value.every(item => item.active)).toBe(true);
    node.widget.value = node.widget.value.map(item => ({ ...item, strength: .5 }));
    expect(names()).toEqual(['A', 'C', 'D']);
    const saved = snapshot(node);
    const clone = await mount(); clone.properties = structuredClone(saved.properties); clone.onConfigure(saved);
    expect(clone.widget.value.filter(item => item.selected).map(item => item.name)).toEqual(['A', 'C', 'D']);
    choose('B'); expect(names()).toEqual(['B']);
    choose('A', { shiftKey: true, ctrlKey: true }); expect(names()).toEqual(['A', 'B']);
    choose('D', { shiftKey: true }); expect(names()).toEqual(['D']);
  });

  it('reorders a noncontiguous selection as a block inside its group', async () => {
    const node = await mount(['A', 'B', 'C', 'D'].map(name => value(name)));
    row(node, 'A').querySelector('.lm-lora-name').click();
    row(node, 'C').querySelector('.lm-lora-name').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    const body = panels(node)[0].querySelector('.lm-group-body');
    document.elementFromPoint.mockReturnValue(body);
    row(node, 'B').getBoundingClientRect = () => ({ top: 20, height: 20 });
    row(node, 'D').getBoundingClientRect = () => ({ top: 60, height: 20, bottom: 80 });
    const handle = row(node, 'C').querySelector('.lm-lora-name');
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientY: 100, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    expect(node.widget.value.map(item => item.name)).toEqual(['B', 'D', 'A', 'C']);
    expect(node.widget.value.filter(item => item.selected).map(item => item.name)).toEqual(['A', 'C']);
    expect(node.widget.value.every(item => item.active && item.strength === .8)).toBe(true);
    expect(node.history).toHaveLength(1);
  });

  it.each([0.5, 2])('drags a selected batch at scale %s, cancels with Esc and supports one-step undo', async scale => {
    const state = normalizeGroupConfig({ rows: 1, columns: 2 }); state.groups[1].mode = 'single';
    const node = await mount([value('A'), value('B'), value('C'), value('D', 'group-2')], state);
    row(node, 'A').querySelector('.lm-lora-name').click();
    row(node, 'C').querySelector('.lm-lora-name').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    const saved = snapshot(node);
    const drag = cancel => {
      const body = panels(node)[1].querySelector('.lm-group-body');
      Object.defineProperty(body, 'clientHeight', { value: 200 });
      body.getBoundingClientRect = () => ({ left: 300 * scale, top: 0, width: 200 * scale, height: 200 * scale, bottom: 200 * scale });
      row(node, 'D').getBoundingClientRect = () => ({ top: 50 * scale, height: 24 * scale, bottom: 74 * scale });
      document.elementFromPoint.mockReturnValue(body);
      const handle = row(node, 'A').querySelector('.lm-lora-name'); handle.setPointerCapture = vi.fn();
      handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 310 * scale, clientY: 30 * scale, bubbles: true }));
      expect(document.querySelector('.lm-group-drag-ghost').textContent).toContain('2 selected');
      expect(node.container.querySelectorAll('.lm-lora-entry--dragging')).toHaveLength(2);
      if (cancel) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    };
    drag(true); expect(snapshot(node)).toEqual(saved); expect(node.history).toHaveLength(0);
    await flush();
    drag(false);
    expect(node.widget.value.map(item => [item.name, item.groupId, item.active])).toEqual([
      ['B', 'group-1', true], ['A', 'group-2', false], ['C', 'group-2', false], ['D', 'group-2', true],
    ]);
    expect(node.widget.value.filter(item => item.selected).map(item => item.name)).toEqual(['A', 'C']);
    expect(node.widget.value.find(item => item.name === 'C').addedOrder).toBe(2);
    expect(node.history).toHaveLength(1);
    node.properties = structuredClone(saved.properties); node.onConfigure(saved);
    expect(snapshot(node)).toEqual(saved);
  });

  it('applies compound sorting once, persists rules and addition order, and restores everything with undo', async () => {
    const node = await mount([
      { ...value('A'), strength: .2 }, { ...value('B', 'group-1', false), strength: 2 },
      { ...value('C'), strength: .9 }, value('D', 'group-2'),
    ], normalizeGroupConfig({ rows: 1, columns: 2 }));
    row(node, 'A').querySelector('.lm-lora-name').click();
    const saved = snapshot(node);
    panels(node)[0].querySelector('.lm-group-body').scrollTop = 40;
    panels(node)[0].querySelector('.lm-group-sort-button').click();
    const popup = document.querySelector('.lm-sort-popover');
    const change = (select, value) => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); };
    change(popup.querySelector('select'), 'active');
    click(popup, '＋ Add rule');
    change(popup.querySelectorAll('.lm-sort-rule')[1].querySelector('select'), 'strength');
    expect(node.widget.value.map(item => item.name)).toEqual(['A', 'B', 'C', 'D']);
    click(popup, 'Apply sort');
    expect(node.widget.value.map(item => item.name)).toEqual(['C', 'A', 'B', 'D']);
    expect(node.widget.value.map(item => item.addedOrder)).toEqual([2, 0, 1, 3]);
    expect(node.properties.lmLoraGroups.groups[0].sortRules).toEqual([{ field: 'active', direction: 'desc' }, { field: 'strength', direction: 'desc' }]);
    expect(row(node, 'A').dataset.selected).toBe('true');
    expect(panels(node)[0].querySelector('.lm-group-body').scrollTop).toBe(40);
    expect(node.history).toHaveLength(1);
    const sorted = snapshot(node);
    const clone = await mount(); clone.properties = structuredClone(sorted.properties); clone.onConfigure(sorted);
    expect(snapshot(clone)).toEqual(sorted);
    node.widget.value = node.widget.value.map(item => item.name === 'A' ? { ...item, strength: 9 } : item);
    expect(node.widget.value.map(item => item.name)).toEqual(['C', 'A', 'B', 'D']);
    node.properties = structuredClone(saved.properties); node.onConfigure(saved);
    expect(snapshot(node)).toEqual(saved);
  });

  it('edits rule priority with buttons and dragging, prevents duplicate fields, and discards cancelled drafts', async () => {
    const node = await mount([value('A'), value('B')]);
    const saved = snapshot(node);
    const open = () => { node.container.querySelector('.lm-group-sort-button').click(); return document.querySelector('.lm-sort-popover'); };
    let popup = open();
    expect(popup.querySelector('[aria-label="Remove rule"]').disabled).toBe(true);
    for (let i = 0; i < 3; i++) click(popup, '＋ Add rule');
    expect(popup.querySelector('[aria-label="Add rule"]').disabled).toBe(true);
    expect(popup.querySelectorAll('.lm-sort-rule')).toHaveLength(4);
    expect(popup.querySelector('select option[value="active"]').disabled).toBe(true);
    popup.querySelector('[aria-label="Move rule down"]').click();
    expect(popup.querySelector('select').value).toBe('active');
    let rows = [...popup.querySelectorAll('.lm-sort-rule')];
    document.elementFromPoint.mockReturnValue(rows[2]);
    const grip = rows[0].querySelector('.lm-sort-grip');
    grip.setPointerCapture = vi.fn();
    grip.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
    grip.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientY: 100, bubbles: true }));
    grip.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    expect([...popup.querySelectorAll('.lm-sort-rule')].map(row => row.querySelector('select').value)).toEqual(['addedOrder', 'strength', 'active', 'name']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(snapshot(node)).toEqual(saved);
    popup = open(); expect(popup.querySelectorAll('.lm-sort-rule')).toHaveLength(1);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    expect(document.querySelector('.lm-sort-popover')).toBeNull();
    expect(snapshot(node)).toEqual(saved);
    popup = open(); click(popup, '＋ Add rule'); popup.querySelector('[aria-label="Remove rule"]').click();
    expect(popup.querySelectorAll('.lm-sort-rule')).toHaveLength(1);
    click(popup, 'Cancel'); expect(node.history).toHaveLength(0);
  });

  it.each([0.5, 2])('reorders whole groups from header whitespace at canvas scale %s and supports undo', async scale => {
    const state = normalizeGroupConfig({ rows: 2, columns: 2 });
    state.groups[0].title = 'Epoch trials'; state.groups[0].mode = 'single';
    const node = await mount([value('A'), value('B', 'group-2')], state);
    const saved = snapshot(node);
    const sourceBody = panels(node)[0].querySelector('.lm-group-body');
    sourceBody.scrollTop = 75;
    const header = panels(node)[0].querySelector('.lm-group-header');
    header.setPointerCapture = vi.fn();
    const target = panels(node)[2];
    target.getBoundingClientRect = () => ({ left: 0, right: 200 * scale, top: 200 * scale, height: 150 * scale });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target.querySelector('.lm-group-header'));
    header.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 3, clientX: 20, clientY: 20, bubbles: true }));
    header.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 30, clientY: 220 * scale, bubbles: true }));
    expect(header.isConnected).toBe(true);
    expect(target.classList.contains('lm-group-drop-target')).toBe(true);
    expect(document.querySelector('.lm-group-drag-ghost').textContent).toBe('Epoch trials');
    header.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, bubbles: true }));
    expect(node.properties.lmLoraGroups.groups.map(group => group.id)).toEqual(['group-2', 'group-3', 'group-1', 'group-4']);
    expect(node.properties.lmLoraGroups.groups[2]).toEqual(state.groups[0]);
    expect(node.widget.value).toEqual([saved.widgets_values[0][1], saved.widgets_values[0][0]]);
    expect(panels(node)[2].querySelector('.lm-group-body').scrollTop).toBe(75);
    expect(node.history).toHaveLength(1);
    node.properties = structuredClone(saved.properties); node.onConfigure(saved);
    expect(snapshot(node)).toEqual(saved);
    vi.restoreAllMocks();
  });

  it('cancels group sorting with Esc and excludes header buttons from drag initiation', async () => {
    const node = await mount([value('A')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    const saved = snapshot(node);
    const header = panels(node)[0].querySelector('.lm-group-header');
    header.setPointerCapture = vi.fn();
    for (const button of header.querySelectorAll('button')) {
      button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
    }
    expect(header.setPointerCapture).not.toHaveBeenCalled();
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(panels(node)[1]);
    header.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2, bubbles: true }));
    header.dispatchEvent(new PointerEvent('pointermove', { clientX: 220, clientY: 20, pointerId: 2, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    header.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true }));
    expect(snapshot(node)).toEqual(saved);
    expect(node.history).toHaveLength(0);
    expect(node.widget.__dragActive).toBe(false);
    expect(document.querySelector('.lm-group-drop-target')).toBeNull();
    expect(document.querySelector('.lm-group-drag-ghost')).toBeNull();
    vi.restoreAllMocks();
  });

  it('loads ComfyUI Chinese labels and default titles without replacing saved or edited names', async () => {
    getSettingValue.mockReturnValue('zh');
    let resolveLocale;
    fetchApi.mockImplementation(path => path === '/locales/zh-CN.json'
      ? new Promise(resolve => { resolveLocale = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ loras: [] }) }));
    const node = await mount();
    const edited = await mount();
    edited.container.querySelector('.lm-group-title').click();
    const titleInput = edited.container.querySelector('.lm-group-title-input');
    titleInput.value = 'My training epochs';
    titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const saved = await mount([], normalizeGroupConfig());
    resolveLocale({ ok: true, json: async () => chineseLocale });
    await flush();

    expect(node.container.querySelector('[aria-label="行数"]')).toBeTruthy();
    expect(node.container.querySelector('[aria-label="列数"]')).toBeTruthy();
    expect(node.container.textContent).toContain('单选');
    expect(node.container.textContent).toContain('多选');
    expect(node.properties.lmLoraGroups.groups[0].title).toBe('默认分组');
    expect(edited.properties.lmLoraGroups.groups[0].title).toBe('My training epochs');
    expect(saved.properties.lmLoraGroups.groups[0].title).toBe('Default group');
    click(node.container, '⋯');
    expect(document.querySelector('[role="dialog"]').textContent).toContain('全部停用');
  });

  it('renders an empty legacy Loader with settings and an addable default group', async () => {
    const node = await mount();
    expect(panels(node)).toHaveLength(1);
    expect(node.container.textContent).toContain('Default group');
    expect(node.container.textContent).toContain('Add LoRAs or drag them here');
    expect(node.container.textContent).not.toContain('Toggle All');
    expect(node.properties.lmLoraGroups).toMatchObject({ rows: 1, columns: 1, version: 2 });
  });

  it('leaves other node classes on the existing ungrouped list', async () => {
    const node = await mount([value('A')], undefined, 'Lora Stacker (LoraManager)');
    expect(panels(node)).toHaveLength(0);
    expect(node.container.textContent).toContain('Toggle All');
    expect(node.properties.lmLoraGroups).toBeUndefined();
  });

  it('changes modes in one history transaction and keeps focused active LoRA', async () => {
    const node = await mount([value('A'), value('B')]);
    row(node, 'B').querySelector('.lm-lora-name').click();
    expect(node.widget.value.map(item => item.active)).toEqual([true, true]);
    click(panels(node)[0], 'Single');
    expect(node.widget.value.map(item => item.active)).toEqual([false, true]);
    expect(node.history).toHaveLength(1);
    expect(node.graph.afterChange).toHaveBeenCalledTimes(1);
    row(node, 'A').querySelector('.lm-lora-toggle').click();
    expect(node.widget.value.map(item => item.active)).toEqual([true, false]);
    row(node, 'A').querySelector('.lm-lora-toggle').click();
    expect(node.widget.value.every(item => !item.active)).toBe(true);
    expect(node.widget.value[0].clipStrength).toBe(0);
  });

  it('restores layout, titles, modes, selected row and zero CLIP through saved workflows and undo', async () => {
    const state = normalizeGroupConfig({ rows: 2, columns: 2 });
    state.groups[2] = { ...state.groups[2], title: 'Training', mode: 'single' };
    const node = await mount([value('A', 'group-3'), { ...value('B', 'group-1'), selected: true }], state);
    const saved = snapshot(node);
    click(panels(node)[2], 'Multi');
    node.widget.callback.mockClear();
    node.properties = structuredClone(saved.properties); node.onConfigure(saved);
    expect(snapshot(node)).toEqual(saved);
    expect(node.widget.callback).toHaveBeenCalledTimes(1);
    expect(node.widget.callback).toHaveBeenCalledWith(node.widget.value);
    const clone = await mount([], undefined);
    clone.properties = structuredClone(saved.properties); clone.onConfigure(saved);
    expect(snapshot(clone)).toEqual(saved);
    expect(panels(clone)[2].textContent).toContain('Training');
  });

  it('preserves group membership through real text merges and targets only new LoRAs', async () => {
    const node = await mount([value('A')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    panels(node)[1].querySelector('header').click();
    node.widget.value = mergeLoras('<lora:A:0.8> <lora:B:0.6> <lora:C:0.4>', node.widget.value);
    expect(node.widget.value.map(item => [item.name, item.groupId])).toEqual([['A', 'group-1'], ['B', 'group-2'], ['C', 'group-2']]);
    node.widget.value = mergeLoras('<lora:A:0.8> <lora:C:0.4>', node.widget.value);
    expect(node.widget.value.map(item => [item.name, item.groupId])).toEqual([['A', 'group-1'], ['C', 'group-2']]);
  });

  it('keeps each scroll offset during editing and ordinary refreshes', async () => {
    const node = await mount([value('A'), value('B', 'group-2')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    const bodies = node.container.querySelectorAll('.lm-group-body');
    bodies[0].scrollTop = 75; bodies[1].scrollTop = 145;
    row(node, 'A').querySelector('.lm-lora-arrow-right').click();
    expect([...node.container.querySelectorAll('.lm-group-body')].map(el => el.scrollTop)).toEqual([75, 145]);
    node.widget.value = node.widget.value;
    expect([...node.container.querySelectorAll('.lm-group-body')].map(el => el.scrollTop)).toEqual([75, 145]);
  });

  it.each([false, true])('isolates vertical wheel at both boundaries, Vue mode=%s', async vueNodesMode => {
    vi.stubGlobal('LiteGraph', { vueNodesMode });
    const node = await mount();
    const body = node.container.querySelector('.lm-group-body');
    const canvasWheel = vi.fn(); document.addEventListener('wheel', canvasWheel);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 });
    body.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true); expect(canvasWheel).not.toHaveBeenCalled();
    const pinch = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40, ctrlKey: true });
    body.dispatchEvent(pinch);
    expect(canvasWheel).toHaveBeenCalledTimes(1);
    document.removeEventListener('wheel', canvasWheel);
  });

  it('restricts keyboard ordering to the focused group and leaves inputs editable', async () => {
    const node = await mount([value('A'), value('B'), value('C', 'group-2')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    row(node, 'A').querySelector('.lm-lora-name').click();
    node.container.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true }));
    expect(node.widget.value.map(item => item.name)).toEqual(['B', 'A', 'C']);
    node.container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(row(node, 'A').dataset.selected).toBe('true');
    row(node, 'A').querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(node.widget.value).toHaveLength(3);
  });

  it('opens a group picker, searches and batch-adds without duplicating existing entries', async () => {
    fetchApi.mockImplementation(async url => ({ ok: true, json: async () => url.startsWith('/locales') ? {} : {
      loras: ['epoch1', 'epoch2', 'epoch3', 'unrelated'].map(file_name => ({ file_name })),
    } }));
    const node = await mount([value('epoch1')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    click(panels(node)[1], 'Single');
    click(panels(node)[1], '+'); await flush();
    const dialog = document.querySelector('[role="dialog"]');
    const search = dialog.querySelector('input[type="search"]');
    search.value = 'epoch'; search.dispatchEvent(new Event('input'));
    expect(dialog.textContent).toContain('Already in Default group');
    click(dialog, 'Select matching results'); click(dialog, 'Add LoRAs (2)');
    expect(node.widget.value.map(item => [item.name, item.groupId, item.active])).toEqual([
      ['epoch1', 'group-1', true], ['epoch2', 'group-2', true], ['epoch3', 'group-2', false],
    ]);
  });

  it('does not mutate on canceled shrink and requires explicit merge conflict resolution', async () => {
    const state = normalizeGroupConfig({ rows: 1, columns: 2 }); state.groups[0].mode = 'single';
    const node = await mount([value('A'), value('B', 'group-2')], state);
    const original = snapshot(node);
    const request = () => { node.container.querySelector('input[aria-label="Columns"]').value = 1; click(node.container, 'Apply'); };
    request(); click(document.querySelector('[role="dialog"]'), 'Cancel');
    expect(snapshot(node)).toEqual(original); expect(node.history).toHaveLength(0);
    request();
    const dialog = document.querySelector('[role="dialog"]');
    const target = dialog.querySelector('select'); target.value = 'group-1'; target.dispatchEvent(new Event('change'));
    const confirm = [...dialog.querySelectorAll('button')].find(el => el.textContent === 'Confirm');
    expect(confirm.disabled).toBe(true);
    const winner = dialog.querySelectorAll('select')[1]; winner.value = '1'; winner.dispatchEvent(new Event('change'));
    expect(confirm.disabled).toBe(false); confirm.click();
    expect(node.history).toHaveLength(1);
    expect(node.widget.value.map(item => [item.name, item.active, item.groupId])).toEqual([['A', false, 'group-1'], ['B', true, 'group-1']]);
    node.properties = original.properties; node.onConfigure(original);
    expect(snapshot(node)).toEqual(original);
  });

  it('checks logical cell dimensions before increasing the grid', async () => {
    const node = await mount([value('A')]);
    let grid = node.container.querySelector('.lm-groups-grid');
    Object.defineProperties(grid, { clientWidth: { value: 405, configurable: true }, clientHeight: { value: 300 } });
    node.container.querySelector('input[aria-label="Columns"]').value = 2; click(node.container, 'Apply');
    expect(panels(node)).toHaveLength(1); expect(toast).toHaveBeenCalled();
    Object.defineProperty(grid, 'clientWidth', { value: 500 });
    node.container.querySelector('input[aria-label="Columns"]').value = 2; click(node.container, 'Apply');
    expect(panels(node)).toHaveLength(2);
    expect(node.widget.value[0].name).toBe('A');
  });

  it.each([[0.5, '.lm-lora-name'], [2, '.lm-lora-name']])('moves across columns at canvas scale %s from %s and preserves updates during drag', async (scale, selector) => {
    const state = normalizeGroupConfig({ rows: 1, columns: 2 });
    state.groups[1].mode = 'single';
    const node = await mount([value('A'), value('B', 'group-2')], state);
    const body = panels(node)[1].querySelector('.lm-group-body');
    Object.defineProperty(body, 'clientHeight', { value: 200 });
    body.getBoundingClientRect = () => ({ top: 100 * scale, height: 200 * scale, bottom: 300 * scale });
    const target = row(node, 'B');
    target.getBoundingClientRect = () => ({ top: 100 * scale, height: 24 * scale });
    const originalHitTest = document.elementFromPoint;
    document.elementFromPoint = () => target;
    const handle = row(node, 'A').querySelector(selector);
    handle.setPointerCapture = vi.fn();
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 100 * scale, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 300 * scale, clientY: 105 * scale, pointerId: 1, bubbles: true }));
    expect(node.widget.__dragActive).toBe(true);
    node.widget.value = [...node.widget.value, value('C')];
    expect(handle.isConnected).toBe(true);
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    document.elementFromPoint = originalHitTest;
    expect(node.widget.__dragActive).toBe(false);
    expect(node.widget.value.map(item => [item.name, item.groupId, item.active])).toEqual([
      ['C', 'group-1', true], ['A', 'group-2', false], ['B', 'group-2', true],
    ]);
    expect(node.history).toHaveLength(1);
    expect(document.body.classList.contains('lm-lora-reordering')).toBe(false);
  });

  it('drops into an empty group and cancels a second drag without modifying entries', async () => {
    const node = await mount([value('A')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    const oldHitTest = document.elementFromPoint;
    const drag = (targetIndex, cancel) => {
      const body = panels(node)[targetIndex].querySelector('.lm-group-body');
      document.elementFromPoint = () => body;
      const handle = row(node, 'A').querySelector('.lm-lora-name'); handle.setPointerCapture = vi.fn();
      handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1, bubbles: true }));
      handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 80, pointerId: 1, bubbles: true }));
      handle.dispatchEvent(new PointerEvent(cancel ? 'pointercancel' : 'pointerup', { pointerId: 1, bubbles: true }));
    };
    drag(1, false);
    expect(node.widget.value[0].groupId).toBe('group-2');
    const saved = snapshot(node);
    drag(0, true);
    document.elementFromPoint = oldHitTest;
    expect(snapshot(node)).toEqual(saved);
    expect(node.widget.__dragActive).toBe(false);
  });

  it('supports right-click moves and keeps the existing move-to-top action group-local', async () => {
    const node = await mount([value('A'), value('B', 'group-2'), value('C', 'group-2')], normalizeGroupConfig({ rows: 1, columns: 2 }));
    row(node, 'C').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    [...document.querySelectorAll('.lm-lora-menu-item')].find(el => el.textContent === 'Move to Top').click();
    expect(node.widget.value.map(item => item.name)).toEqual(['A', 'C', 'B']);
    row(node, 'C').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    [...document.querySelectorAll('.lm-lora-menu-item')].find(el => el.textContent.includes('Move to group')).click();
    click(document.querySelector('[role="dialog"]'), 'Default group');
    expect(node.widget.value.map(item => [item.name, item.groupId])).toEqual([['A', 'group-1'], ['C', 'group-1'], ['B', 'group-2']]);
  });

  it('renames a group and applies weights only to that group with CLIP linking preserved', async () => {
    const node = await mount([value('A'), { ...value('B', 'group-2'), expanded: true }], normalizeGroupConfig({ rows: 1, columns: 2 }));
    panels(node)[0].querySelector('.lm-group-title').click();
    const input = node.container.querySelector('.lm-group-title-input');
    input.value = 'Epoch trials'; input.blur();
    expect(node.properties.lmLoraGroups.groups[0].title).toBe('Epoch trials');
    click(panels(node)[0], '⋯'); let dialog = document.querySelector('[role="dialog"]');
    dialog.querySelector('input').value = '0.6'; click(dialog, 'Apply');
    expect(node.widget.value.map(item => [item.strength, item.clipStrength])).toEqual([[.6, .6], [.8, 0]]);
    click(panels(node)[0], '⋯'); click(document.querySelector('[role="dialog"]'), 'Disable all');
    expect(node.widget.value.map(item => item.active)).toEqual([false, true]);
  });

  it('edits only clicked title text inline and handles Escape, empty names and IME confirmation', async () => {
    const node = await mount();
    const saved = snapshot(node);
    panels(node)[0].querySelector('.lm-group-header').click();
    panels(node)[0].querySelector('.lm-group-title-slot').click();
    expect(node.container.querySelector('.lm-group-title-input')).toBeNull();
    const title = node.container.querySelector('.lm-group-title');
    title.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    expect(node.widget.__dragActive).not.toBe(true);
    title.click();
    let input = node.container.querySelector('.lm-group-title-input');
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    input.value = 'Cancelled';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(snapshot(node)).toEqual(saved);
    expect(node.history).toHaveLength(0);
    node.container.querySelector('.lm-group-title').click();
    input = node.container.querySelector('.lm-group-title-input');
    input.value = '   '; input.blur();
    expect(snapshot(node)).toEqual(saved);
    node.container.querySelector('.lm-group-title').click();
    input = node.container.querySelector('.lm-group-title-input');
    input.value = '训练轮次';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(node.properties.lmLoraGroups.groups[0].title).toBe('Default group');
    expect(input.isConnected).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(node.properties.lmLoraGroups.groups[0].title).toBe('训练轮次');
    expect(node.history).toHaveLength(1);
  });

  it('does not adjust weights by dragging the grouped row background', async () => {
    const node = await mount([value('A')]);
    const el = row(node, 'A');
    el.setPointerCapture = vi.fn(); el.releasePointerCapture = vi.fn();
    node._lmFlushLoraText = vi.fn();
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 50, pointerId: 2, bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, pointerId: 2, bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 150, pointerId: 2, bubbles: true }));
    expect(el.isConnected).toBe(true);
    el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true }));
    expect(node.history).toHaveLength(0);
    expect(node.widget.value[0].strength).toBe(.8);
    expect(node.widget.value[0].clipStrength).toBe(0);
  });

  it.each(['.lm-lora-name'])('reorders from %s with a precise end marker and Esc cancellation', async selector => {
    const node = await mount([value('A'), value('B')]);
    const body = panels(node)[0].querySelector('.lm-group-body');
    body.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, bottom: 200, height: 200 });
    Object.defineProperty(body, 'clientHeight', { value: 200 });
    row(node, 'B').getBoundingClientRect = () => ({ top: 30, bottom: 54, height: 24 });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(body);
    const handle = row(node, 'A').querySelector(selector);
    handle.setPointerCapture = vi.fn();
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 60, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 23, clientY: 60, pointerId: 1, bubbles: true }));
    expect(node.widget.__dragActive).toBe(true);
    expect(document.querySelector('.lm-group-insertion-line').style.top).toBe('54.75px');
    expect(panels(node)[0].classList.contains('lm-group-drop-target')).toBe(true);
    expect(document.querySelector('.lm-group-drag-ghost').textContent).toBe('A');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    expect(node.widget.value.map(item => item.name)).toEqual(['A', 'B']);
    expect(node.history).toHaveLength(0);
    expect(node.widget.__dragActive).toBe(false);
    expect(document.querySelector('.lm-group-insertion-line')).toBeNull();
    expect(document.querySelector('.lm-group-drag-ghost')).toBeNull();

    row(node, 'B').getBoundingClientRect = () => ({ top: 30, bottom: 54, height: 24 });
    document.elementFromPoint.mockReturnValue(panels(node)[0].querySelector('.lm-group-body'));
    const nextHandle = row(node, 'A').querySelector(selector);
    nextHandle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 40, pointerId: 2, bubbles: true }));
    nextHandle.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 60, pointerId: 2, bubbles: true }));
    nextHandle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true }));
    expect(node.widget.value.map(item => item.name)).toEqual(['B', 'A']);
    expect(node.widget.value.map(item => item.strength)).toEqual([.8, .8]);
    expect(node.history).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('keeps the epoch suffix and full filename available in narrow rows', async () => {
    const name = 'long-training-project/stocking_v1.2_step1800.safetensors';
    const node = await mount([value(name)]);
    expect(row(node, name).querySelector('.lm-lora-name-suffix').textContent).toBe('_step1800');
    expect(row(node, name).querySelector('.lm-lora-name').hasAttribute('title')).toBe(false);
    expect(row(node, name).querySelector('.lm-lora-name').getAttribute('aria-label')).toBe(name);
  });
});
