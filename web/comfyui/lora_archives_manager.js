import { DEFAULT_PRIMARY, DEFAULT_SECONDARY, activeArchiveEntries, archivePath, ordered } from './lora_archives_state.js';
import { action, archiveDialog, el, errorText, field, selectOptions, trapKeys } from './lora_archives_ui.js';
import { getAvailableLoras, isLoraNameAvailable } from './loras_widget_utils.js';
import { openArchiveCategoryMenu } from './lora_archive_category_menu.js';

export function categoryLabel(category, t) {
  return category.id === DEFAULT_PRIMARY && category.name === 'Uncategorized' ? t('archiveUncategorized')
    : category.id === DEFAULT_SECONDARY && category.name === 'Default' ? t('archiveDefault') : category.name;
}

export function categoryOptions(client, t) {
  return ordered(client.data.categories.filter(item => item.parentId !== null)).map(item => ({
    ...item, name: archivePath(client.data, { categoryId: item.id }, value => categoryLabel(value, t)),
  }));
}

export async function editCategory(client, t, category, parentId, signal, onMessage) {
  const revision = client.data.revision;
  return archiveDialog({ title: t(category ? 'archiveEdit' : 'archiveAdd'), t, signal, onMessage,
    build(body) {
      const name = el('input'); name.maxLength = 100; name.value = category?.name || '';
      body.append(field(t('archiveName'), name));
      let parent;
      if ((category ? category.parentId : parentId) !== null) {
        parent = selectOptions(ordered(client.data.categories.filter(item => item.parentId === null)), category?.parentId || parentId,
          item => categoryLabel(item, t));
        body.append(field(t('archivePrimary'), parent));
      }
      return { name, parent };
    },
    actions: [{ label: t('archiveConfirm'), primary: true, async run({ name, parent }) {
      if (!name.value.trim()) throw new Error('invalid');
      return client.write(`/categories${category ? `/${category.id}` : ''}`, category ? 'PATCH' : 'POST',
        { name: name.value.trim(), parentId: parent?.value || null }, revision);
    } }],
  });
}

export async function archiveDetails({ client, t, archive, snapshot, categoryId = DEFAULT_SECONDARY, signal, onMessage }) {
  // Keep the revision captured when opening the form, including across background refreshes.
  let revision = client.data.revision;
  return archiveDialog({ title: t(archive ? 'archiveEdit' : 'archiveSaveAs'), t, signal, onMessage,
    build(body) {
      const name = el('input'); name.maxLength = 100; name.value = archive?.name || '';
      let category = selectOptions(categoryOptions(client, t), archive?.categoryId || categoryId);
      const categoryField = field(t('archiveCategory'), category);
      const addPrimary = action(`+ ${t('archivePrimary')}`, async () => {
        const result = await editCategory(client, t, null, null, signal, onMessage);
        if (result) { revision = result.revision; refresh(category.value); }
      });
      const addSecondary = action(`+ ${t('archiveSecondary')}`, async () => {
        const current = client.data.categories.find(item => item.id === category.value);
        const result = await editCategory(client, t, null, current?.parentId || DEFAULT_PRIMARY, signal, onMessage);
        if (result) { revision = result.revision; refresh(result.resultId); }
      });
      function refresh(id) {
        const next = selectOptions(categoryOptions(client, t), id);
        category.replaceWith(next); category = next;
      }
      body.append(field(t('archiveName'), name), categoryField, addPrimary, addSecondary);
      return { name, category: () => category.value };
    },
    actions: [{ label: t('archiveConfirm'), primary: true, async run({ name, category }) {
      if (!name.value.trim() || !category()) throw new Error('invalid');
      return client.write(`/archives${archive ? `/${archive.id}` : ''}`, archive ? 'PATCH' : 'POST', {
        name: name.value.trim(), categoryId: category(), ...(!archive ? { snapshot } : { archiveRevision: archive.revision }),
      }, revision);
    } }],
  });
}

export function openArchiveManager({ client, t, currentId, load, saveAs, signal, onClose }) {
  const previous = document.activeElement;
  const root = el('section', 'lm-popover lm-archive-manager');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', t('archiveManage')); root.tabIndex = -1;
  const header = el('header', 'lm-archive-manager-header');
  const status = el('div', 'lm-archive-header-status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  const panels = el('div', 'lm-archive-panels');
  const preview = el('aside', 'lm-archive-preview');
  const resize = el('div', 'lm-archive-resize'); resize.tabIndex = 0;
  resize.setAttribute('role', 'separator'); resize.setAttribute('aria-label', t('archiveResize'));
  let primaryId = DEFAULT_PRIMARY, secondaryId = DEFAULT_SECONDARY, previewId = null, level = 0;
  let closed = false, busy = false, dragging = null, pointerCleanup = null, available = null;
  let closeCategoryMenu = null;
  const nameObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateNameMarquees) : null;
  const selected = client.data.archives.find(item => item.id === currentId());
  if (selected) {
    secondaryId = selected.categoryId;
    primaryId = client.data.categories.find(item => item.id === secondaryId)?.parentId || DEFAULT_PRIMARY;
    previewId = selected.id;
  }
  const localAbort = new AbortController();
  const close = () => {
    if (closed) return;
    closed = true; closeCategoryMenu?.(); pointerCleanup?.(); observer?.disconnect(); nameObserver?.disconnect(); unsubscribe(); localAbort.abort();
    signal?.removeEventListener('abort', close); window.removeEventListener('resize', constrain);
    root.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); onClose?.();
  };
  const setMessage = (message = '', tone = 'error') => {
    if (closed) return;
    status.textContent = message; status.title = message; status.dataset.tone = tone;
  };
  const run = async (task, message = '') => {
    if (busy || closed) return;
    busy = true; root.setAttribute('aria-busy', 'true'); setMessage(message, 'info');
    try { await task(); }
    catch (error) { setMessage(errorText(t, error)); }
    finally {
      busy = false; root.removeAttribute('aria-busy');
      if (message && status.textContent === message && status.dataset.tone === 'info') setMessage('');
    }
  };
  const headerActions = el('div', 'lm-archive-header-actions');
  headerActions.append(
    action(t('archiveSaveAs'), () => run(() => saveAs(secondaryId, setMessage))),
    action(t('archiveRetry'), () => run(() => client.refresh(), t('archiveLoading'))),
    action('×', close, t('archiveClose')));
  header.append(el('strong', '', t('archiveManage')), status, headerActions);
  root.append(header, panels, resize); document.body.append(root);

  function remember() {
    const rect = root.getBoundingClientRect();
    try { localStorage.setItem('lm-grid-archive-manager-geometry', JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })); } catch { /* Storage may be disabled. */ }
  }
  function constrain() {
    const rect = root.getBoundingClientRect();
    const width = Math.max(1, Math.min(parseFloat(root.style.width) || rect.width || 1000, window.innerWidth - 16));
    const height = Math.max(1, Math.min(parseFloat(root.style.height) || rect.height || 500, window.innerHeight - 16));
    root.style.width = `${width}px`; root.style.height = `${height}px`;
    root.style.left = `${Math.max(8, Math.min(parseFloat(root.style.left) || 8, window.innerWidth - width - 8))}px`;
    root.style.top = `${Math.max(8, Math.min(parseFloat(root.style.top) || 8, window.innerHeight - height - 8))}px`;
    root.classList.toggle('lm-archive-compact', width < 936);
  }
  let geometry;
  try { geometry = JSON.parse(localStorage.getItem('lm-grid-archive-manager-geometry')); } catch { /* Use defaults. */ }
  root.style.width = `${Number.isFinite(geometry?.width) ? Math.max(340, geometry.width) : 1000}px`;
  root.style.height = `${Number.isFinite(geometry?.height) ? Math.max(300, geometry.height) : 500}px`;
  root.style.left = `${Number.isFinite(geometry?.x) ? geometry.x : Math.max(8, (window.innerWidth - 1000) / 2)}px`;
  root.style.top = `${Number.isFinite(geometry?.y) ? geometry.y : Math.max(8, (window.innerHeight - 500) / 2)}px`;
  constrain();
  function startPointer(event, sizing) {
    if (event.button !== 0 || event.target.closest('button,input,select')) return;
    event.preventDefault(); event.stopPropagation();
    pointerCleanup?.();
    const rect = root.getBoundingClientRect(), x = event.clientX, y = event.clientY;
    const move = e => {
      if (sizing) {
        root.style.width = `${Math.max(340, rect.width + e.clientX - x)}px`;
        root.style.height = `${Math.max(300, rect.height + e.clientY - y)}px`;
      } else {
        root.style.left = `${rect.x + e.clientX - x}px`; root.style.top = `${rect.y + e.clientY - y}px`;
      }
      constrain();
    };
    const end = () => { pointerCleanup?.(); remember(); };
    pointerCleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); pointerCleanup = null; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  header.addEventListener('pointerdown', event => startPointer(event, false));
  resize.addEventListener('pointerdown', event => startPointer(event, true));
  resize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    root.style.width = `${Math.max(340, parseFloat(root.style.width) + (event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0))}px`;
    root.style.height = `${Math.max(300, parseFloat(root.style.height) + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0))}px`;
    constrain(); remember();
  });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    root.classList.toggle('lm-archive-compact', root.getBoundingClientRect().width < 936);
  }) : null;
  observer?.observe(root);
  window.addEventListener('resize', constrain);

  async function remove(collection, item) {
    const revision = client.data.revision;
    const category = collection === 'categories';
    const hasChildren = category && (item.parentId === null
      ? client.data.categories.some(value => value.parentId === item.id)
      : client.data.archives.some(value => value.categoryId === item.id));
    const candidates = category ? client.data.categories.filter(value => value.id !== item.id && (value.parentId === null) === (item.parentId === null)) : [];
    await archiveDialog({ title: t('archiveDelete'), t, signal: localAbort.signal, onMessage: setMessage,
      build(body) {
        body.append(el('p', '', t(category ? 'archiveDeleteCategory' : 'archiveDeleteConfirm')));
        let destination;
        if (hasChildren) {
          destination = selectOptions([{ id: '', name: t('archiveChoose') }, ...candidates], '', value => categoryLabel(value, t));
          body.append(field(t('archiveDestination'), destination));
        }
        return { destination };
      }, actions: [{ label: t('archiveDelete'), async run({ destination }) {
        if (hasChildren && !destination?.value) throw new Error('invalid');
        return client.write(`/${collection}/${item.id}`, 'DELETE', { destinationId: destination?.value || null }, revision);
      } }],
    });
  }

  function bindReorder(row, collection, item, siblings, parentKey) {
    row.draggable = true; row.title = t('archiveReorder');
    row.addEventListener('dragstart', event => {
      if (busy) { event.preventDefault(); return; }
      dragging = { collection, id: item.id, parent: item[parentKey], revision: client.data.revision };
      event.dataTransfer?.setData('text/plain', item.id);
      row.classList.add('lm-archive-dragging');
    });
    row.addEventListener('dragend', () => { dragging = null; row.classList.remove('lm-archive-dragging'); });
    row.addEventListener('dragover', event => {
      if (dragging?.collection === collection && dragging.parent === item[parentKey]) event.preventDefault();
    });
    row.addEventListener('drop', event => {
      if (dragging?.collection !== collection || dragging.parent !== item[parentKey]) return;
      event.preventDefault(); event.stopPropagation();
      const source = dragging; dragging = null;
      if (source.id === item.id) return;
      const ids = siblings.map(value => value.id).filter(id => id !== source.id);
      const rect = row.getBoundingClientRect();
      const index = ids.indexOf(item.id) + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
      ids.splice(index, 0, source.id);
      run(() => client.write(`/${collection}/reorder`, 'PATCH', { ids, [parentKey]: item[parentKey] }, source.revision));
    });
  }

  function categoryContext(event, row, item, siblings) {
    event.preventDefault(); event.stopPropagation(); closeCategoryMenu?.();
    if (busy) return;
    const revision = client.data.revision;
    const anchor = row.querySelector('button');
    const rect = anchor.getBoundingClientRect();
    const keyboard = event.type === 'keydown' || (!event.clientX && !event.clientY);
    closeCategoryMenu = openArchiveCategoryMenu({
      anchor, x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY,
      item, siblings, primaries: ordered(client.data.categories.filter(value => value.parentId === null)),
      t, label: value => categoryLabel(value, t), onClose: () => { closeCategoryMenu = null; },
      onRename: () => run(() => archiveDialog({ title: t('archiveRename'), t, signal: localAbort.signal, onMessage: setMessage,
        build(body) {
          const name = el('input'); name.value = categoryLabel(item, t); name.maxLength = 100;
          body.append(field(t('archiveName'), name)); return { name };
        }, actions: [{ label: t('archiveConfirm'), primary: true, run: ({ name }) => {
          if (!name.value.trim()) throw new Error('invalid');
          return client.write(`/categories/${item.id}`, 'PATCH', { name: name.value.trim() }, revision);
        } }],
      })),
      onReorder: index => run(() => {
        const ids = siblings.map(value => value.id).filter(id => id !== item.id);
        ids.splice(index, 0, item.id);
        return client.write('/categories/reorder', 'PATCH', { ids, parentId: item.parentId }, revision);
      }),
      onMove: parentId => run(async () => {
        await client.write(`/categories/${item.id}`, 'PATCH', { parentId }, revision);
        primaryId = parentId; secondaryId = item.id; render();
      }),
      onDelete: () => run(() => remove('categories', item)),
    });
  }

  function categoryPanel(title, items, panelLevel, parentId) {
    const panel = el('section', 'lm-archive-panel'); panel.dataset.level = panelLevel;
    const heading = el('div', 'lm-archive-panel-heading');
    if (panelLevel > 0) heading.append(action('‹', () => { level--; render(); }, t('archiveBack')));
    heading.append(el('strong', '', t(title)), action('+', () => run(() => editCategory(client, t, null, parentId, localAbort.signal, setMessage)), t('archiveAdd')));
    const list = el('div', 'lm-archive-list');
    for (const item of items) {
      const row = el('div', 'lm-archive-row');
      row.dataset.categoryId = item.id;
      row.addEventListener('contextmenu', event => categoryContext(event, row, item, items));
      row.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) categoryContext(event, row, item, items);
      });
      row.classList.toggle('lm-archive-selected', item.id === (panelLevel === 0 ? primaryId : secondaryId));
      row.append(action(categoryLabel(item, t), () => {
        if (panelLevel === 0) { primaryId = item.id; secondaryId = null; }
        else secondaryId = item.id;
        level = panelLevel + 1; previewId = null; render();
      }));
      if (![DEFAULT_PRIMARY, DEFAULT_SECONDARY].includes(item.id)) {
        row.append(action('✎', () => run(() => editCategory(client, t, item, item.parentId, localAbort.signal, setMessage)), t('archiveEdit')),
          action('×', () => run(() => remove('categories', item)), t('archiveDelete')));
      }
      bindReorder(row, 'categories', item, items, 'parentId'); list.append(row);
    }
    if (!items.length) list.append(el('p', '', t('archiveEmpty')));
    panel.append(heading, list); return panel;
  }

  function updateNameMarquees() {
    for (const name of preview.querySelectorAll('.lm-archive-weight-name')) {
      const distance = Math.max(0, name.firstElementChild.scrollWidth - name.clientWidth);
      name.style.setProperty('--lm-name-travel', `${-distance}px`);
      name.style.setProperty('--lm-name-duration', `${Math.max(6, distance / 28 + 2)}s`);
      name.classList.toggle('lm-archive-name-overflow', distance > 1);
    }
  }

  function renderPreview() {
    nameObserver?.disconnect();
    const archive = client.data.archives.find(item => item.id === previewId);
    preview.ondrop = preview.ondragover = preview.onpaste = null;
    preview.replaceChildren(el('strong', 'lm-archive-preview-title', archive?.name || t('archivePreview')));
    if (!archive) return;
    const frame = el('div', 'lm-archive-image-frame');
    if (archive.image) {
      const image = el('img'); image.src = client.imageUrl(archive); image.alt = archive.name;
      image.addEventListener('error', () => { image.replaceWith(el('span', 'lm-archive-image-placeholder', t('archiveNoImage'))); });
      frame.append(image);
    } else frame.append(el('span', 'lm-archive-image-placeholder', t('archiveNoImage')));
    const weights = el('div', 'lm-archive-weights'); weights.tabIndex = 0;
    const entries = activeArchiveEntries(archive.snapshot);
    if (!entries.length) weights.append(el('div', '', t('archiveNoActive')));
    for (const entry of entries) {
      const row = el('div', 'lm-archive-weight-row');
      const missing = available && !isLoraNameAvailable(entry.name, available);
      const name = el('span', 'lm-archive-weight-name');
      name.append(el('span', 'lm-archive-weight-name-text', `${entry.name.split(/[\\/]/).pop()}${missing ? ` · ${t('archiveMissing')}` : ''}`));
      name.title = entry.name; row.classList.toggle('lm-archive-missing', !!missing);
      row.append(name, el('span', 'lm-archive-weight-strength', String(Number(entry.strength)))); weights.append(row);
    }
    const input = el('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
    const upload = file => run(async () => {
      if (!file || file.size > 20 * 1024 * 1024 || !file.size) throw new Error('imageInvalid');
      await client.image(archive.id, file);
    });
    input.addEventListener('change', () => { if (input.files[0]) upload(input.files[0]); });
    const controls = el('div', 'lm-archive-preview-actions');
    const removeButton = action(t('archiveRemoveImage'), () => run(() => client.image(archive.id, null)));
    removeButton.disabled = !archive.image;
    controls.append(action(t('archiveImage'), () => input.click()), removeButton);
    const footer = el('div', 'lm-archive-preview-footer');
    footer.append(weights, controls);
    preview.append(frame, footer, input);
    for (const name of preview.querySelectorAll('.lm-archive-weight-name')) {
      nameObserver?.observe(name);
      nameObserver?.observe(name.firstElementChild);
    }
    updateNameMarquees();
    preview.tabIndex = 0;
    preview.ondragover = event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    preview.ondrop = event => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault(); event.stopPropagation(); upload(event.dataTransfer.files[0]);
    };
    preview.onpaste = event => {
      const file = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith('image/'))?.getAsFile();
      if (file) { event.preventDefault(); event.stopPropagation(); upload(file); }
    };
  }

  function render() {
    if (closed) return;
    closeCategoryMenu?.();
    const categories = client.data.categories;
    const primaries = ordered(categories.filter(item => item.parentId === null));
    if (!primaries.some(item => item.id === primaryId)) primaryId = primaries[0]?.id;
    const secondaries = ordered(categories.filter(item => item.parentId === primaryId));
    if (!secondaries.some(item => item.id === secondaryId)) secondaryId = secondaries[0]?.id;
    const archives = ordered(client.data.archives.filter(item => item.categoryId === secondaryId));
    if (!archives.some(item => item.id === previewId)) previewId = archives[0]?.id;
    const archivePanel = el('section', 'lm-archive-panel'); archivePanel.dataset.level = 2;
    const heading = el('div', 'lm-archive-panel-heading');
    const add = action('+', () => run(() => saveAs(secondaryId, setMessage)), t('archiveSaveAs')); add.disabled = !secondaryId;
    heading.append(action('‹', () => { level = 1; render(); }, t('archiveBack')), el('strong', '', t('archiveList')), add);
    const list = el('div', 'lm-archive-list');
    for (const archive of archives) {
      const row = el('div', 'lm-archive-row');
      row.classList.toggle('lm-archive-selected', archive.id === currentId());
      const choose = action(archive.name, () => run(async () => { if (await load(archive, setMessage)) close(); }));
      choose.title = `${archivePath(client.data, archive, item => categoryLabel(item, t))} / ${archive.name}`;
      const show = () => { if (previewId !== archive.id) { previewId = archive.id; renderPreview(); } };
      row.addEventListener('pointerenter', show); row.addEventListener('focusin', show);
      row.append(choose, action(t('archiveEdit'), () => run(() => archiveDetails({ client, t, archive, signal: localAbort.signal, onMessage: setMessage }))),
        action('×', () => run(() => remove('archives', archive)), t('archiveDelete')));
      bindReorder(row, 'archives', archive, archives, 'categoryId'); list.append(row);
    }
    if (!archives.length) list.append(el('p', '', t('archiveEmpty')));
    archivePanel.append(heading, list);
    panels.replaceChildren(categoryPanel('archivePrimary', primaries, 0, null),
      categoryPanel('archiveSecondary', secondaries, 1, primaryId), archivePanel, preview);
    root.dataset.level = level; renderPreview();
  }
  const unsubscribe = client.subscribe(() => {
    render();
    if (client.error) setMessage(errorText(t, client.error));
  });
  signal?.addEventListener('abort', close, { once: true });
  root.addEventListener('keydown', event => trapKeys(event, root, close));
  root.addEventListener('paste', event => {
    if (!event.target.closest?.('input,textarea,select,[contenteditable="true"]')) preview.onpaste?.(event);
  });
  root.addEventListener('pointerdown', event => event.stopPropagation());
  root.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
  getAvailableLoras().then(result => { available = result; if (!closed) renderPreview(); }).catch(() => {});
  render(); root.focus();
  run(() => client.refresh(), t('archiveLoading'));
  return close;
}
