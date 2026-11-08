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
    expect(picker.textContent).toContain('Default');
    [...picker.querySelectorAll('button')].find(button => button.textContent === 'Second').click(); await flush();
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

describe('three-level archive manager', () => {
  it('previews saved weights on hover, keeps preview on leave and marks missing models', async () => {
    const m = mount(); await flush();
    m.change(snapshot => { snapshot.entries[0].strength = 9; }); await flush();
    m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    let preview = document.querySelector('.lm-archive-preview');
    expect(preview.textContent).toContain('Model 1 · CLIP 0.5');
    const second = [...document.querySelectorAll('.lm-archive-panel[data-level="2"] .lm-archive-row')][1];
    second.dispatchEvent(new Event('pointerenter')); second.dispatchEvent(new Event('pointerleave')); await flush();
    expect(preview.textContent).toContain('Second'); expect(preview.textContent).toContain('Missing locally');
    expect(m.node.properties[ARCHIVE_PROPERTY]).toBe('one');
    expect(document.querySelectorAll('.lm-archive-panel')).toHaveLength(3);
  });
  it('edits names without applying a grid and rejects stale form revisions', async () => {
    const m = mount(); await flush(); m.toolbar.querySelector('[data-action="manage"]').click(); await flush();
    await click('Edit'); document.querySelector('.lm-archive-dialog input').value = 'Renamed';
    m.client.data = { ...m.client.data, revision: 2 }; m.client.emit();
    await click('Confirm');
    expect(document.querySelector('.lm-archive-error').textContent || document.querySelector('.lm-archive-dialog .lm-archive-error').textContent).toContain('changed elsewhere');
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
