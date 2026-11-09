export function el(tag, className = '', text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function action(text, callback, title = text) {
  const button = el('button', 'lm-archive-button', text);
  button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
  button.addEventListener('click', event => { event.stopPropagation(); callback(event); });
  return button;
}

export function errorText(t, error) {
  const key = error?.code || error?.message;
  return t(`archive${({ conflict: 'Conflict', duplicate: 'Duplicate', invalid: 'Invalid', imageInvalid: 'ImageInvalid',
    notFound: 'NotFound', corrupt: 'Corrupt', capacity: 'Capacity', protected: 'Protected' })[key] || 'Storage'}`);
}

export function field(label, control) {
  const wrapper = el('label', 'lm-archive-field');
  wrapper.append(el('span', '', label), control);
  return wrapper;
}

export function selectOptions(items, selected, label = item => item.name) {
  const select = el('select');
  for (const item of items) select.append(new Option(label(item), item.id));
  if (selected != null) select.value = selected;
  return select;
}

export function trapKeys(event, root, close) {
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  if (event.key !== 'Tab') return;
  const controls = [...root.querySelectorAll('button,input,select,[tabindex="0"]')]
    .filter(control => !control.disabled && !control.closest('[hidden]'));
  const index = controls.indexOf(document.activeElement);
  if (controls.length && (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1))) {
    event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
  }
}

export function archiveDialog({ title, t, build, actions, signal, onMessage }) {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const previous = document.activeElement;
    const overlay = el('div', 'lm-popover lm-archive-overlay');
    const dialog = el('section', 'lm-archive-dialog');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', title);
    const body = el('div', 'lm-archive-dialog-body');
    const message = el('div', 'lm-archive-error'); message.setAttribute('role', 'alert');
    const footer = el('div', 'lm-archive-dialog-actions');
    let busy = false, closed = false;
    const close = value => {
      if (closed) return;
      closed = true; overlay.remove(); signal?.removeEventListener('abort', abort);
      if (previous?.isConnected) previous.focus({ preventScroll: true }); resolve(value);
    };
    const abort = () => close(null);
    signal?.addEventListener('abort', abort, { once: true });
    const context = build?.(body) || {};
    for (const option of actions) {
      const button = action(option.label, async () => {
        if (busy) return;
        busy = true; message.textContent = ''; onMessage?.('');
        footer.querySelectorAll('button').forEach(item => { item.disabled = true; });
        try { const result = await option.run(context); close(result); }
        catch (error) {
          const detail = errorText(t, error);
          if (onMessage) onMessage(detail); else message.textContent = detail;
        }
        finally { busy = false; footer.querySelectorAll('button').forEach(item => { item.disabled = false; }); }
      });
      if (option.primary) button.classList.add('lm-archive-primary');
      footer.append(button);
    }
    footer.append(action(t('archiveCancel'), () => { if (!busy) close(null); }));
    dialog.append(el('h3', '', title), body);
    if (!onMessage) dialog.append(message);
    dialog.append(footer); overlay.append(dialog); document.body.append(overlay);
    overlay.addEventListener('pointerdown', event => { event.stopPropagation(); });
    overlay.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
    overlay.addEventListener('keydown', event => trapKeys(event, dialog, () => { if (!busy) close(null); }));
    queueMicrotask(() => { if (!closed) dialog.querySelector('input,select,button')?.focus(); });
  });
}
