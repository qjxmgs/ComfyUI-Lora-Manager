import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../web/comfyui/loras_widget_utils.js', () => ({
  getAvailableLoras: async () => new Set(['A']), isLoraNameAvailable: (name, available) => available.has(name),
}));

import { createArchiveController } from '../../../web/comfyui/lora_archives.js';
import { GridArchiveClient } from '../../../web/comfyui/lora_archives_client.js';
import { ARCHIVE_MESSAGES } from '../../../web/comfyui/lora_archives_i18n.js';
import { ARCHIVE_PROPERTY, activeArchiveEntries, gridSnapshot, snapshotFingerprint } from '../../../web/comfyui/lora_archives_state.js';
import { normalizeGroupConfig } from '../../../web/comfyui/lora_groups_state.js';

const clone = value => JSON.parse(JSON.stringify(value));
const t = key => ARCHIVE_MESSAGES[key] || key;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const click = async text => {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === text);
  expect(button, text).toBeTruthy(); button.click(); await flush();
};
function example(name = 'A') {
  return gridSnapshot(normalizeGroupConfig({ rows: 1, columns: 1, nextAddedOrder: 1 }), [
    { name, groupId: 'group-1', strength: 1, clipStrength: .5, active: true, expanded: true, locked: false, addedOrder: 0 },
  ], [1000, 600]);
}
function library() {
  return { revision: 1, categories: [
    { id: 'uncategorized', parentId: null, name: 'Uncategorized', order: 0 },
    { id: 'default', parentId: 'uncategorized', name: 'Default', order: 0 },
  ], archives: [
    { id: 'one', categoryId: 'default', name: 'First', snapshot: example(), revision: 1, order: 0 },
    { id: 'two', categoryId: 'default', name: 'Second', snapshot: example('B'), revision: 1, order: 1 },
  ] };
}
function fakeClient() {
  const listeners = new Set();
  const client = { data: library(), ready: true, error: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit() { listeners.forEach(fn => fn()); },
    refresh: vi.fn(async () => client.data),
    imageUrl: archive => `/images/${archive.id}.webp`,
    image: vi.fn(async () => client.data),
    write: vi.fn(async (path, method, payload, revision = client.data.revision) => {
      if (revision !== client.data.revision) throw Object.assign(new Error('conflict'), { code: 'conflict' });
      const parts = path.split('/').filter(Boolean), collection = parts[0], id = parts[1];
      const next = clone(client.data);
      if (method === 'POST') {
        next[collection].push({ ...clone(payload), id: 'new', revision: 1, order: next[collection].length }); next.resultId = 'new';
      } else if (id === 'reorder') {
        payload.ids.forEach((value, index) => { next[collection].find(item => item.id === value).order = index; });
      } else if (method === 'DELETE') next[collection] = next[collection].filter(item => item.id !== id);
      else Object.assign(next[collection].find(item => item.id === id), clone(payload));
      next.revision++; client.data = next; client.emit(); return next;
    }),
  };
  return client;
}
const controllers = [];
function mount({ associated = true, client = fakeClient() } = {}) {
  let live = example();
  const node = { properties: associated ? { [ARCHIVE_PROPERTY]: 'one' } : {}, size: [1000, 600] };
  const history = [];
  const controller = createArchiveController({ node, client, t, snapshot: () => ({ ...clone(live), nodeSize: node.size }),
    apply: (snapshot, id) => { history.push({ live: clone(live), id: node.properties[ARCHIVE_PROPERTY], size: [...node.size] }); live = clone(snapshot); node.size = [...snapshot.nodeSize]; node.properties[ARCHIVE_PROPERTY] = id; },
    associate: id => { node.properties[ARCHIVE_PROPERTY] = id; },
  });
  controllers.push(controller);
  const toolbar = controller.render(); document.body.append(toolbar);
  return { node, client, controller, toolbar, history, live: () => live, change: fn => { fn(live); controller.schedule(); } };
}
async function choose(mounted, id) {
  const select = mounted.toolbar.querySelector('select'); select.value = id; select.dispatchEvent(new Event('change')); await flush();
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('archive snapshot semantics', () => {
  it('ignores the next allocation counter after reload but preserves actual ordering changes', () => {
    const saved = example(), restored = clone(saved);
    saved.groupConfig.nextAddedOrder = 2104;
    restored.groupConfig.nextAddedOrder = 2047;
    expect(snapshotFingerprint(restored)).toBe(snapshotFingerprint(saved));
    expect(saved.groupConfig.nextAddedOrder).toBe(2104);
    expect(gridSnapshot(saved.groupConfig, saved.entries, saved.nodeSize).groupConfig.nextAddedOrder).toBe(2104);
    restored.entries[0].addedOrder = 10;
    expect(snapshotFingerprint(restored)).not.toBe(snapshotFingerprint(saved));
  });
  it('ignores selection and numeric formatting, preserves complete meaningful state', () => {
    const original = example(), next = clone(original);
    next.entries[0].selected = true; next.entries[0].strength = '1.00';
    expect(snapshotFingerprint(next)).toBe(snapshotFingerprint(original));
    next.entries[0].locked = true;
    expect(snapshotFingerprint(next)).not.toBe(snapshotFingerprint(original));
    expect(gridSnapshot(original.groupConfig, original.entries, original.nodeSize)).toEqual(original);
  });
  it('excludes paused groups from previews but preserves their remembered selection', () => {
    const snapshot = example();
    snapshot.groupConfig.groups[0].enabled = false;
    snapshot.groupConfig.groups[0].pausedActive = ['A'];
    expect(activeArchiveEntries(snapshot)).toEqual([]);
    expect(gridSnapshot(snapshot.groupConfig, snapshot.entries, snapshot.nodeSize).groupConfig.groups[0].pausedActive).toEqual(['A']);
  });
});

describe('archive toolbar and persistence', () => {
  it('keeps the saved name clean when workflow restoration changes only the allocation counter', async () => {
    const m = mount(); await flush();
    m.change(snapshot => { snapshot.groupConfig.nextAddedOrder += 57; }); await flush();
    expect(m.toolbar.querySelector('.lm-archive-dirty').textContent).toBe('');
    expect(m.toolbar.querySelector('[data-action="save"]').disabled).toBe(true);
    m.change(snapshot => { snapshot.entries[0].strength = 2; }); await flush();
    expect(m.toolbar.querySelector('.lm-archive-dirty').textContent).toBe('*');
  });
  it('saves an edited name as a new archive without overwriting the original', async () => {
    const m = mount(); await flush();
    const input = m.toolbar.querySelector('.lm-archive-name');
    input.value = 'New combination'; input.dispatchEvent(new Event('input')); await flush();
    m.toolbar.querySelector('[data-action="save"]').click(); await flush();
    expect(m.client.write).toHaveBeenCalledWith('/archives', 'POST', expect.objectContaining({ name: 'New combination', categoryId: 'default' }));
    expect(m.client.data.archives.find(item => item.id === 'one').name).toBe('First');
    expect(m.node.properties[ARCHIVE_PROPERTY]).toBe('new');
    expect(m.controller.dirty()).toBe(false);
  });
  it('opens classified choices below the editable field and directly switches', async () => {
    const m = mount(); await flush();
    m.toolbar.querySelector('.lm-archive-expand').click(); await flush();
    const picker = document.querySelector('.lm-archive-picker');
    expect(picker.textContent).toContain('Uncategorized');
    picker.querySelector('[data-choice]').click(); await flush();
    const secondary = document.querySelector('.lm-archive-picker[data-level="1"]');
    expect(secondary.textContent).toContain('Default');
    secondary.querySelector('[data-choice]').click(); await flush();
    document.querySelector('.lm-archive-picker[data-level="2"] [data-choice="two"]').click(); await flush();
    expect(m.node.properties[ARCHIVE_PROPERTY]).toBe('two');
    expect(m.toolbar.querySelector('.lm-archive-name').value).toBe('Second');
    expect(document.querySelector('.lm-archive-picker')).toBeNull();
  });

  it('preserves an existing unassociated grid and asks for name on first save', async () => {
    const m = mount({ associated: false }); await flush();
    expect(m.toolbar.querySelector('select').selectedOptions[0].textContent).toBe('* Untitled');
    expect(m.toolbar.querySelector('[data-action="reset"]').disabled).toBe(true);
    m.toolbar.querySelector('[data-action="save"]').click(); await flush();
    document.querySelector('.lm-archive-dialog input').value = 'My grid';
    await click('Confirm');
    expect(m.client.write).toHaveBeenCalledWith('/archives', 'POST', expect.objectContaining({ name: 'My grid', snapshot: example() }), 1);
    expect(m.node.properties[ARCHIVE_PROPERTY]).toBe('new');
    expect(m.controller.dirty()).toBe(false);
  });
  it('updates dirty state without replacing toolbar and detects size changes', async () => {
    const m = mount(); await flush();
    expect(m.toolbar.querySelector('[data-action="save"]').disabled).toBe(true);
    m.change(snapshot => { snapshot.entries[0].active = false; }); await flush();
    expect(m.toolbar.querySelector('select').selectedOptions[0].textContent).toBe('* First');
    m.change(snapshot => { snapshot.entries[0].active = true; }); await flush();
    expect(m.controller.dirty()).toBe(false);
    m.node.size = [1200, 800]; m.node.onResize(); await flush();
    expect(m.controller.dirty()).toBe(true);
    m.toolbar.querySelector('[data-action="save"]').click(); await flush();
    expect(m.client.data.archives[0].snapshot.nodeSize).toEqual([1200, 800]);
    expect(m.controller.dirty()).toBe(false);
  });
  it('clean switch and reset each capture one complete undo state', async () => {
    const m = mount(); await flush(); await choose(m, 'two');
    expect(m.live().entries[0].name).toBe('B'); expect(m.history).toHaveLength(1);
    m.change(snapshot => { snapshot.entries[0].strength = 3; }); await flush();
    m.toolbar.querySelector('[data-action="reset"]').click(); await flush();
    expect(m.live().entries[0].strength).toBe(1); expect(m.history).toHaveLength(2);
    const undo = m.history.pop(); m.change(snapshot => Object.assign(snapshot, undo.live));
    m.node.size = undo.size; m.node.properties[ARCHIVE_PROPERTY] = undo.id; await flush();
    expect(m.controller.dirty()).toBe(true);
  });
  it.each(['Cancel', 'Discard and switch', 'Save and switch'])('handles dirty switch: %s', async choice => {
    const m = mount(); await flush();
    m.change(snapshot => { snapshot.entries[0].strength = 2; }); await flush();
    await choose(m, 'two'); await click(choice);
    if (choice === 'Cancel') {
      expect(m.live().entries[0].strength).toBe(2); expect(m.node.properties[ARCHIVE_PROPERTY]).toBe('one');
      expect(m.toolbar.querySelector('select').value).toBe('one');
    } else {
      expect(m.node.properties[ARCHIVE_PROPERTY]).toBe('two');
      expect(m.client.data.archives[0].snapshot.entries[0].strength).toBe(choice === 'Save and switch' ? 2 : 1);
    }
  });
  it('failed save keeps changes and aborts switching', async () => {
    const m = mount(); await flush();
    m.client.write.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'conflict' }));
    m.change(snapshot => { snapshot.entries[0].strength = 2; }); await flush();
    await choose(m, 'two'); await click('Save and switch');
    expect(m.node.properties[ARCHIVE_PROPERTY]).toBe('one'); expect(m.live().entries[0].strength).toBe(2);
    expect(document.querySelector('.lm-archive-dialog').textContent).toContain('changed elsewhere');
    await click('Cancel'); expect(m.controller.dirty()).toBe(true);
  });
  it('external archive changes refresh baseline but never load into nodes', async () => {
    const client = fakeClient(), first = mount({ client }), second = mount({ client }); await flush();
    first.change(snapshot => { snapshot.entries[0].strength = 4; }); await flush();
    first.toolbar.querySelector('[data-action="save"]').click(); await flush();
    expect(second.live().entries[0].strength).toBe(1); expect(second.controller.dirty()).toBe(true);
    client.data.archives = client.data.archives.filter(item => item.id !== 'one'); client.emit(); await flush();
    expect(first.node.properties[ARCHIVE_PROPERTY]).toBeUndefined();
    expect(first.live().entries[0].strength).toBe(4);
  });
});

describe('archive category context menus', () => {
  async function setup() {
    const client = fakeClient();
    client.data.categories.push(
      { id: 'p1', parentId: null, name: 'Styles', order: 1 },
      { id: 'p2', parentId: null, name: 'Trials', order: 2 },
      { id: 's1', parentId: 'uncategorized', name: 'Portraits', order: 1 },
      { id: 's2', parentId: 'uncategorized', name: 'Landscape', order: 2 });
    const m = mount({ client }); await flush();
    m.toolbar.querySelector('[data-action="manage"]').click(); await flush(); return m;
  }
  function open(id, keyboard = false) {
    const row = document.querySelector(`[data-category-id="${id}"]`);
    row.querySelector('button').focus();
    row.dispatchEvent(keyboard ? new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })
      : new MouseEvent('contextmenu', { clientX: 100, clientY: 120, bubbles: true, cancelable: true }));
    return document.querySelector('.lm-archive-category-menu');
  }
  const menuButton = name => [...document.querySelectorAll('.lm-archive-category-menu button')].find(button => button.textContent.replace('›', '') === name);
  async function chooseMenu(name) { menuButton(name).click(); await flush(); }

  it.each(['p1', 's1', 'uncategorized', 'default'])('renames category %s without modifying its parent or workflow', async id => {
    const m = await setup(); const saved = m.live(); open(id);
    await chooseMenu('Rename');
    document.querySelector('.lm-archive-dialog input').value = 'Renamed'; await click('Confirm');
    expect(m.client.write).toHaveBeenCalledWith(`/categories/${id}`, 'PATCH', { name: 'Renamed' }, 1);
    expect(m.client.data.categories.find(item => item.id === id).name).toBe('Renamed');
    expect(document.querySelector(`[data-category-id="${id}"] button`).textContent).toBe('Renamed');
    expect(m.live()).toEqual(saved); expect(m.history).toHaveLength(0);
  });
  it.each(['p', 's'].flatMap(prefix => ['Move to top', 'Move up', 'Move down', 'Move to bottom'].map(command => [prefix, command])))('reorders %s siblings using %s', async (prefix, command) => {
    const m = await setup(); open(`${prefix}1`);
    const first = prefix === 'p' ? 'uncategorized' : 'default';
    const ids = command === 'Move to top' || command === 'Move up' ? [`${prefix}1`, first, `${prefix}2`] : [first, `${prefix}2`, `${prefix}1`];
    await chooseMenu(command);
    expect(m.client.write).toHaveBeenCalledWith('/categories/reorder', 'PATCH', { ids, parentId: prefix === 'p' ? null : 'uncategorized' }, 1);
    expect(ids.map(id => m.client.data.categories.find(item => item.id === id).order)).toEqual([0, 1, 2]);
  });
  it('disables boundary actions and protects built-in categories', async () => {
    await setup(); open('uncategorized');
    for (const label of ['Move to top', 'Move up', 'Delete']) expect(menuButton(label).disabled).toBe(true);
    expect(menuButton('Move to category')).toBeUndefined();
    open('default'); expect(menuButton('Move to category').disabled).toBe(true);
    open('p2'); expect(menuButton('Move down').disabled).toBe(true); expect(menuButton('Move to bottom').disabled).toBe(true);
  });
  it('moves a secondary category through its destination submenu and follows it', async () => {
    const m = await setup(); open('s1', true);
    const move = menuButton('Move to category'); move.focus();
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.querySelectorAll('.lm-archive-category-menu')).toHaveLength(2);
    expect(menuButton('Uncategorized').disabled).toBe(true);
    expect(document.activeElement.textContent).toBe('Styles');
    await chooseMenu('Styles');
    expect(m.client.write).toHaveBeenCalledWith('/categories/s1', 'PATCH', { parentId: 'p1' }, 1);
    expect(document.querySelector('[data-category-id="p1"]').classList.contains('lm-archive-selected')).toBe(true);
    expect(document.querySelector('[data-category-id="s1"]')).not.toBeNull();
    expect(m.history).toHaveLength(0);
  });
  it('keeps the original category when a destination rejects the move', async () => {
    const m = await setup(); m.client.write.mockRejectedValueOnce(new Error('duplicate'));
    open('s1'); await chooseMenu('Move to category'); await chooseMenu('Styles');
    expect(m.client.data.categories.find(item => item.id === 's1').parentId).toBe('uncategorized');
    expect(document.querySelector('.lm-archive-header-status').textContent).toBe(t('archiveDuplicate'));
  });
  it('deletes only after confirmation and requests migration for nonempty categories', async () => {
    const m = await setup(); open('s1'); await chooseMenu('Delete'); await click('Cancel');
    expect(m.client.write).not.toHaveBeenCalled();
    open('s1'); await chooseMenu('Delete'); await click('Delete');
    expect(m.client.write).toHaveBeenCalledWith('/categories/s1', 'DELETE', { destinationId: null }, 1);
    m.client.data.categories.push({ id: 'child', parentId: 'p1', name: 'Child', order: 0 }); m.client.emit();
    open('p1'); await chooseMenu('Delete'); await click('Delete');
    expect(document.querySelector('.lm-archive-header-status').textContent).toBe(t('archiveInvalid'));
    document.querySelector('.lm-archive-dialog select').value = 'p2'; await click('Delete');
    expect(m.client.write).toHaveBeenLastCalledWith('/categories/p1', 'DELETE', { destinationId: 'p2' }, 2);
  });
  it('dismisses on Escape, outside click, refresh and manager close', async () => {
    const m = await setup(); let menu = open('p1', true);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.lm-archive-category-menu')).toBeNull();
    expect(document.activeElement.closest('[data-category-id]').dataset.categoryId).toBe('p1');
    open('s1'); document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('.lm-archive-category-menu')).toBeNull();
    open('p1'); m.client.emit(); expect(document.querySelector('.lm-archive-category-menu')).toBeNull();
    open('p1'); m.controller.dispose(); expect(document.querySelector('.lm-archive-category-menu')).toBeNull();
  });
});

describe('three-level archive manager', () => {
  it('keeps loading and error messages in a persistent header slot', async () => {
    const m = mount(); await flush();
    let fail;
    m.client.refresh.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject; }));
    m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    const manager = document.querySelector('.lm-archive-manager');
    const header = manager.querySelector('.lm-archive-manager-header');
    const status = header.querySelector('.lm-archive-header-status');
    expect(header.firstElementChild.textContent).toBe('LoRA grid archive manager');
    expect(header.firstElementChild.nextElementSibling).toBe(status);
    const actions = header.querySelector('.lm-archive-header-actions');
    expect(status.nextElementSibling).toBe(actions);
    expect(header.lastElementChild).toBe(actions);
    expect([...actions.querySelectorAll('button')].map(button => button.textContent)).toEqual([t('archiveSaveAs'), t('archiveRetry'), '×']);
    expect(status.textContent).toBe(t('archiveLoading'));
    expect(status.getAttribute('role')).toBe('status');
    expect(manager.querySelector(':scope > .lm-archive-error')).toBeNull();
    fail(new Error('storage')); await flush();
    expect(status.textContent).toBe(t('archiveStorage'));
    expect(status.title).toBe(status.textContent);
    expect(status.dataset.tone).toBe('error');
    await click('Reload library');
    expect(header.querySelector('.lm-archive-header-status')).toBe(status);
    expect(status.textContent).toBe('');
    m.client.error = new Error('corrupt'); m.client.emit(); await flush();
    expect(status.textContent).toBe(t('archiveCorrupt'));
  });
  it('previews saved weights on hover, keeps preview on leave and marks missing models', async () => {
    const m = mount(); await flush();
    m.change(snapshot => { snapshot.entries[0].strength = 9; }); await flush();
    m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    let preview = document.querySelector('.lm-archive-preview');
    expect(preview.querySelector('.lm-archive-weight-name').textContent).toBe('A');
    expect(preview.querySelector('.lm-archive-weight-strength').textContent).toBe('1');
    expect(preview.textContent).not.toContain('CLIP');
    const second = [...document.querySelectorAll('.lm-archive-panel[data-level="2"] .lm-archive-row')][1];
    second.dispatchEvent(new Event('pointerenter')); second.dispatchEvent(new Event('pointerleave')); await flush();
    expect(preview.textContent).toContain('Second'); expect(preview.textContent).toContain('Missing locally');
    expect(m.node.properties[ARCHIVE_PROPERTY]).toBe('one');
    expect(document.querySelectorAll('.lm-archive-panel')).toHaveLength(3);
  });
  it('animates only overflowing preview names and updates after resizing', async () => {
    const observers = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { this.callback = callback; this.observe = vi.fn(); this.disconnect = vi.fn(); observers.push(this); }
    });
    const m = mount(); await flush();
    m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    const name = document.querySelector('.lm-archive-weight-name');
    const observer = observers.find(item => item.observe.mock.calls.some(([target]) => target === name));
    Object.defineProperty(name, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(name.firstElementChild, 'scrollWidth', { value: 250 });
    observer.callback();
    expect(name.classList.contains('lm-archive-name-overflow')).toBe(true);
    expect(name.style.getPropertyValue('--lm-name-travel')).toBe('-150px');
    Object.defineProperty(name, 'clientWidth', { value: 300 }); observer.callback();
    expect(name.classList.contains('lm-archive-name-overflow')).toBe(false);
    const calls = observer.disconnect.mock.calls.length;
    m.controller.dispose();
    expect(observer.disconnect.mock.calls.length).toBeGreaterThan(calls);
  });
  it('edits names without applying a grid and rejects stale form revisions', async () => {
    const m = mount(); await flush(); m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    await click('Edit'); document.querySelector('.lm-archive-dialog input').value = 'Renamed';
    m.client.data = { ...m.client.data, revision: 2 }; m.client.emit();
    await click('Confirm');
    expect(document.querySelector('.lm-archive-header-status').textContent).toContain('changed elsewhere');
    expect(document.querySelector('.lm-archive-dialog .lm-archive-error')).toBeNull();
    expect(m.history).toHaveLength(0); await click('Cancel');
    await click('Edit'); document.querySelector('.lm-archive-dialog input').value = 'Renamed'; await click('Confirm');
    expect(m.client.data.archives[0].name).toBe('Renamed'); expect(m.history).toHaveLength(0);
  });
  it('deletes the associated archive without changing node contents', async () => {
    const m = mount(); await flush(); m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    document.querySelector('.lm-archive-panel[data-level="2"] .lm-archive-row button:last-child').click(); await flush();
    await click('Delete');
    expect(m.node.properties[ARCHIVE_PROPERTY]).toBeUndefined(); expect(m.live()).toEqual(example());
    expect(m.toolbar.querySelector('select').selectedOptions[0].textContent).toBe('* Untitled');
  });
  it('uploads pasted images and removes images without changing grid dirty state', async () => {
    const m = mount(); await flush(); m.client.data.archives[0].image = 'one.webp';
    m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    const file = new File(['image'], 'preview.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { items: [{ type: 'image/png', getAsFile: () => file }] } });
    document.querySelector('.lm-archive-manager').dispatchEvent(paste); await flush();
    expect(m.client.image).toHaveBeenCalledWith('one', file);
    await click('Remove image'); expect(m.client.image).toHaveBeenCalledWith('one', null);
    expect(m.controller.dirty()).toBe(false);
  });
  it('disposes open managers and dialogs with the node', async () => {
    const m = mount(); await flush(); m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    await click('Edit'); m.controller.dispose(); await flush();
    expect(document.querySelector('.lm-archive-manager')).toBeNull();
    expect(document.querySelector('.lm-archive-overlay')).toBeNull();
  });
  it('creates a category and moves a secondary category through its edit form', async () => {
    const m = mount(); await flush(); m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    document.querySelector('.lm-archive-panel[data-level="0"] .lm-archive-panel-heading button').click(); await flush();
    document.querySelector('.lm-archive-dialog input').value = 'Styles'; await click('Confirm');
    expect(m.client.data.categories.find(item => item.id === 'new')).toMatchObject({ name: 'Styles', parentId: null });
    m.client.data.categories.push({ id: 'faces', name: 'Faces', parentId: 'uncategorized', order: 1 }); m.client.emit(); await flush();
    const rows = document.querySelectorAll('.lm-archive-panel[data-level="1"] .lm-archive-row');
    rows[1].querySelector('button:nth-child(2)').click(); await flush();
    document.querySelector('.lm-archive-dialog select').value = 'new'; await click('Confirm');
    expect(m.client.data.categories.find(item => item.id === 'faces').parentId).toBe('new');
  });
  it('reorders archives by dragging within the same category', async () => {
    const m = mount(); await flush(); m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    const rows = document.querySelectorAll('.lm-archive-panel[data-level="2"] .lm-archive-row');
    const start = new Event('dragstart', { bubbles: true });
    Object.defineProperty(start, 'dataTransfer', { value: { setData: vi.fn() } }); rows[1].dispatchEvent(start);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'clientY', { value: -1 }); rows[0].dispatchEvent(drop); await flush();
    expect(m.client.write).toHaveBeenCalledWith('/archives/reorder', 'PATCH', { ids: ['two', 'one'], categoryId: 'default' }, 1);
    expect(document.querySelector('.lm-archive-panel[data-level="2"] .lm-archive-row button').textContent).toBe('Second');
  });
});

describe('archive HTTP client', () => {
  it('keeps previous data on failure and sends captured revisions', async () => {
    const response = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => library() })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'conflict' }) });
    vi.stubGlobal('fetch', response);
    const client = new GridArchiveClient(); await client.refresh();
    await expect(client.write('/archives/one', 'PATCH', { name: 'new' }, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect(JSON.parse(response.mock.calls[1][1].body).revision).toBe(0);
    expect(client.data.archives[0].name).toBe('First');
  });
  it('does not overwrite a successful mutation with an older in-flight read', async () => {
    let finish;
    const response = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...library(), revision: 2 }) });
    vi.stubGlobal('fetch', response);
    const client = new GridArchiveClient(); const reading = client.refresh();
    await client.write('/archives/one', 'PATCH', { name: 'new' });
    finish({ ok: true, json: async () => library() }); await reading;
    expect(client.data.revision).toBe(2);
  });
});


describe('cascade archive rows and deletion', () => {
  async function expand(m) {
    m.toolbar.querySelector('.lm-archive-expand').click(); await flush();
    document.querySelector('.lm-archive-picker[data-level="0"] [data-choice]').click(); await flush();
    document.querySelector('.lm-archive-picker[data-level="1"] [data-choice]').click(); await flush();
  }
  it('shows saved active summaries without back buttons and preserves branches on refresh', async () => {
    const m = mount(); await flush();
    m.client.data.archives[1].snapshot.groupConfig.groups[0].enabled = false;
    await expand(m);
    expect(document.querySelectorAll('.lm-archive-picker')).toHaveLength(3);
    expect(document.querySelector('.lm-archive-cascade-back')).toBeNull();
    expect(document.querySelector('[data-choice="one"]').textContent).toContain('(1)');
    expect(document.querySelector('[data-choice="one"]').textContent).toContain('Model 1 / CLIP 0.5');
    expect(document.querySelector('[data-choice="two"]').textContent).toContain('(0)');
    expect(document.querySelector('[data-choice="two"]').textContent).toContain('No active LoRAs');
    m.client.emit(); await flush();
    expect(document.querySelectorAll('.lm-archive-picker')).toHaveLength(3);
    expect(document.querySelector('[data-choice="default"]').getAttribute('aria-expanded')).toBe('true');
  });
  it('cancels deletion without closing the cascade and restores focus', async () => {
    const m = mount(); await flush(); await expand(m);
    const button = document.querySelector('[data-delete-id="one"]'); button.focus(); button.click(); await flush();
    document.querySelector('.lm-archive-dialog').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelectorAll('.lm-archive-picker')).toHaveLength(3);
    await click('Cancel');
    expect(document.activeElement).toBe(button);
    expect(m.client.write).not.toHaveBeenCalled(); expect(m.history).toHaveLength(0);
  });
  it('deletes the current archive without loading another and keeps its category open', async () => {
    const m = mount(); await flush(); await expand(m);
    document.querySelector('[data-delete-id="one"]').click(); await flush(); await click('Delete');
    expect(document.querySelectorAll('.lm-archive-picker')).toHaveLength(3);
    expect(document.querySelector('[data-choice="one"]')).toBeNull();
    expect(document.querySelector('[data-choice="two"]')).not.toBeNull();
    expect(m.node.properties[ARCHIVE_PROPERTY]).toBeUndefined();
    expect(m.live()).toEqual(example()); expect(m.history).toHaveLength(0);
  });
  it('keeps the menu and archive when deletion has a revision conflict', async () => {
    const m = mount(); await flush(); await expand(m);
    m.client.write.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'conflict' }));
    document.querySelector('[data-delete-id="one"]').click(); await flush(); await click('Delete');
    expect(document.querySelector('.lm-archive-dialog .lm-archive-error').textContent).toContain('changed elsewhere');
    expect(m.client.data.archives).toHaveLength(2); expect(m.history).toHaveLength(0);
    await click('Cancel'); expect(document.querySelectorAll('.lm-archive-picker')).toHaveLength(3);
  });
  it('toggles expanded categories and navigates back with the keyboard without a back row', async () => {
    vi.stubGlobal('innerWidth', 280);
    const m = mount(); await flush(); await expand(m);
    const secondary = document.querySelector('[data-choice="default"]'); secondary.click(); await flush();
    expect(document.querySelectorAll('.lm-archive-picker')).toHaveLength(2);
    secondary.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await flush();
    expect(document.querySelectorAll('.lm-archive-picker')).toHaveLength(3);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.querySelectorAll('.lm-archive-picker')).toHaveLength(2);
    expect(document.activeElement).toBe(secondary);
  });
});


describe('cascade positioning', () => {
  it.each([20, 800])('keeps panels in the viewport near anchor x=%s', async x => {
    vi.stubGlobal('innerWidth', 1024); vi.stubGlobal('innerHeight', 600);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      let left = x, top = 550, width = 180, height = 28;
      if (this.classList.contains('lm-archive-picker')) {
        left = parseFloat(this.style.left) || 0; top = parseFloat(this.style.top) || 0; width = 196; height = 160;
      } else if (this.closest('.lm-archive-picker')) {
        const parent = this.closest('.lm-archive-picker'); left = parseFloat(parent.style.left); top = parseFloat(parent.style.top); width = 188; height = 31;
      }
      return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
    });
    const m = mount(); await flush(); m.toolbar.querySelector('.lm-archive-expand').click(); await flush();
    const first = document.querySelector('.lm-archive-picker');
    first.querySelector('[data-choice]').dispatchEvent(new Event('pointerenter')); await flush();
    const second = document.querySelector('.lm-archive-picker[data-level="1"]');
    expect(second).toBeTruthy();
    second.querySelector('[data-choice]').dispatchEvent(new Event('pointerenter')); await flush();
    for (const panel of document.querySelectorAll('.lm-archive-picker')) {
      const rect = panel.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(8); expect(rect.right).toBeLessThanOrEqual(1016);
      expect(rect.top).toBeGreaterThanOrEqual(8); expect(rect.bottom).toBeLessThanOrEqual(592);
      expect(panel.style.maxHeight).toBe('360px');
    }
  });
});
