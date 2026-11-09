import { openArchiveCascade } from './lora_archives_picker.js';
import { gridArchiveClient } from './lora_archives_client.js';
import { ARCHIVE_PROPERTY, archivePath, ordered, snapshotFingerprint } from './lora_archives_state.js';
import { archiveDetails, categoryLabel, openArchiveManager } from './lora_archives_manager.js';
import { action, archiveDialog, el, errorText } from './lora_archives_ui.js';

const ICONS = {
  save: '<path d="M4 3h13l4 4v14H3V3h1Zm3 0v7h10V3M7 21v-8h10v8M14 4v4"/>',
  reset: '<path d="M4 9a8 8 0 1 1 0 7M4 3v6h6"/>',
  manage: '<rect x="3" y="3" width="18" height="5" rx="1"/><rect x="3" y="10" width="18" height="5" rx="1"/><rect x="3" y="17" width="18" height="4" rx="1"/><path d="M7 3v5m0 2v5m0 2v4"/>',
};

export function createArchiveController({ node, t, snapshot, apply, associate, client = gridArchiveClient }) {
  const lifetime = new AbortController();
  let disposed = false, busy = false, queued = false, toolbar = null, closeManager = null;
  let draftName = null, draftId = null, closePicker = null;
  const currentId = () => node.properties?.[ARCHIVE_PROPERTY] || null;
  const current = () => client.data.archives.find(item => item.id === currentId());
  const dirty = () => (draftName !== null && draftName.trim() !== (current()?.name || '')) || !current() || snapshotFingerprint(snapshot()) !== snapshotFingerprint(current().snapshot);
  const report = error => {
    const detail = errorText(t, error);
    toolbar?.setAttribute('title', detail);
    return archiveDialog({ title: t('archiveManage'), t, signal: lifetime.signal,
      build: body => { body.append(el('p', '', detail)); },
      actions: [{ label: t('archiveRetry'), run: () => client.refresh() }],
    });
  };
  async function run(task, onMessage) {
    if (busy || disposed) return false;
    busy = true; update();
    try { return await task(); }
    catch (error) { if (onMessage) onMessage(errorText(t, error)); else await report(error); return false; }
    finally { busy = false; update(); }
  }
  async function saveAs(categoryId, onMessage) {
    const result = await archiveDetails({ client, t, snapshot: snapshot(), categoryId, signal: lifetime.signal, onMessage });
    if (!result || disposed) return false;
    draftName = null; associate(result.resultId); update(); return true;
  }
  async function save(onMessage) {
    const archive = current();
    if (draftName !== null && draftName.trim() !== (archive?.name || '')) {
      const name = draftName.trim();
      if (!name) throw new Error('invalid');
      const result = await client.write('/archives', 'POST', { name, categoryId: archive?.categoryId || 'default', snapshot: snapshot() });
      draftName = null; associate(result.resultId); update(); return true;
    }
    if (!archive) return saveAs(undefined, onMessage);
    await client.write(`/archives/${archive.id}`, 'PATCH', { snapshot: snapshot() });
    update(); return true;
  }
  async function load(archive, onMessage) {
    if (disposed) return false;
    if (archive.id === currentId() && !dirty()) return true;
    if (dirty()) {
      const choice = await archiveDialog({ title: t('archiveManage'), t, signal: lifetime.signal, onMessage,
        build: body => { body.append(el('p', '', t('archiveUnsaved'))); },
        actions: [
          { label: t('archiveSaveSwitch'), primary: true, run: () => 'save' },
          { label: t('archiveDiscardSwitch'), run: () => 'discard' },
        ],
      });
      if (!choice || (choice === 'save' && !await save(onMessage))) return false;
    }
    const latest = client.data.archives.find(item => item.id === archive.id);
    if (!latest) throw new Error('notFound');
    if (disposed) return false;
    draftName = null; apply(latest.snapshot, latest.id); update(); return true;
  }
  function update() {
    if (disposed || !toolbar) return;
    if (draftId !== currentId()) { draftId = currentId(); draftName = null; }
    const archive = current();
    const select = toolbar.querySelector('select');
    const value = archive?.id || '';
    const options = [];
    const marked = dirty();
    if (!archive) options.push(new Option(`* ${t('archiveUntitled')}`, ''));
    for (const primary of ordered(client.data.categories.filter(item => item.parentId === null))) {
      for (const secondary of ordered(client.data.categories.filter(item => item.parentId === primary.id))) {
        const items = ordered(client.data.archives.filter(item => item.categoryId === secondary.id));
        if (!items.length) continue;
        const group = el('optgroup'); group.label = `${categoryLabel(primary, t)} / ${categoryLabel(secondary, t)}`;
        for (const item of items) group.append(new Option(`${item.id === value && marked ? '* ' : ''}${item.name}`, item.id));
        options.push(group);
      }
    }
    select.replaceChildren(...options); select.value = value;
    select.title = archive ? `${archivePath(client.data, archive, item => categoryLabel(item, t))} / ${archive.name}` : t('archiveUntitled');
    select.setAttribute('aria-label', t('archiveList'));
    select.disabled = busy || !client.ready;
    const input = toolbar.querySelector('.lm-archive-name');
    input.value = draftName ?? archive?.name ?? '';
    input.placeholder = t('archiveUntitled');
    input.disabled = busy;
    toolbar.querySelector('.lm-archive-dirty').textContent = marked ? '*' : '';
    toolbar.querySelector('.lm-archive-expand').disabled = busy || !client.ready;
    const saveButton = toolbar.querySelector('[data-action="save"]');
    saveButton.disabled = busy || !client.ready || !marked;
    saveButton.classList.toggle('lm-archive-save-ready', marked && client.ready);
    toolbar.querySelector('[data-action="reset"]').disabled = busy || !client.ready || !archive || !marked;
    toolbar.querySelector('[data-action="manage"]').disabled = busy;
    toolbar.setAttribute('aria-busy', String(busy || !client.ready));
    toolbar.title = client.error ? errorText(t, client.error) : '';
  }
  function openPicker(anchor) {
    if (closePicker) { closePicker(); return; }
    closePicker = openArchiveCascade({ anchor, client, t, currentId, onChoose: item => run(() => load(item)),
      onClose: () => { closePicker = null; } });
  }

  function schedule() {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => { queued = false; update(); });
  }
  const unsubscribe = client.subscribe(() => {
    // Only detach a vanished association after a successful library read.
    if (client.ready && !client.error && currentId() && !current()) {
      delete node.properties[ARCHIVE_PROPERTY];
    }
    schedule();
  });
  const previousResize = node.onResize;
  const resize = function (...args) { const result = previousResize?.apply(this, args); schedule(); return result; };
  node.onResize = resize;
  client.refresh().catch(() => {});
  return {
    schedule, dirty,
    render() {
      closePicker?.();
      toolbar = el('div', 'lm-grid-archives');
      const select = el('select', 'lm-archive-select');
      select.addEventListener('change', () => {
        const target = client.data.archives.find(item => item.id === select.value);
        update(); if (target) run(() => load(target));
      });
      select.addEventListener('pointerdown', () => { client.refresh().catch(() => {}); });
      // Keep the option model separate from the editable display name.
      select.hidden = true;
      const combo = el('div', 'lm-archive-combo');
      const marker = el('span', 'lm-archive-dirty'); marker.setAttribute('aria-hidden', 'true');
      const input = el('input', 'lm-archive-name'); input.maxLength = 100; input.setAttribute('aria-label', t('archiveName'));
      input.addEventListener('input', () => { draftId = currentId(); draftName = input.value; update(); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); run(save); } });
      const expand = action('▾', () => openPicker(expand), t('archiveList'));
      expand.classList.add('lm-archive-expand'); expand.setAttribute('aria-haspopup', 'dialog'); expand.setAttribute('aria-expanded', 'false');
      combo.append(marker, input, expand); toolbar.append(combo, select);
      const actions = {
        save: () => run(save),
        reset: () => run(async () => {
          await client.refresh();
          const archive = current(); if (!archive) throw new Error('notFound');
          draftName = null; apply(archive.snapshot, archive.id); return true;
        }),
        manage: () => {
          if (closeManager) return;
          closeManager = openArchiveManager({ client, t, currentId, load: (target, onMessage) => run(() => load(target, onMessage), onMessage),
            saveAs: (categoryId, onMessage) => run(() => saveAs(categoryId, onMessage), onMessage), signal: lifetime.signal,
            onClose: () => { closeManager = null; } });
        },
      };
      for (const [name, callback] of Object.entries(actions)) {
        const label = t(({ save: 'archiveSave', reset: 'archiveReset', manage: 'archiveManage' })[name]);
        const button = action('', callback, label); button.dataset.action = name;
        // The SVG paths are static application constants, never archive content.
        button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${ICONS[name]}</svg>`;
        toolbar.append(button);
      }
      toolbar.addEventListener('keydown', event => event.stopPropagation());
      toolbar.addEventListener('pointerdown', event => event.stopPropagation());
      update(); return toolbar;
    },
    dispose() {
      disposed = true; closePicker?.(); lifetime.abort(); closeManager?.(); unsubscribe();
      if (node.onResize === resize) node.onResize = previousResize;
    },
  };
}
