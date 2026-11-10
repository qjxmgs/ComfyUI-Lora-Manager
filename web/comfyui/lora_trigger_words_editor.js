import { api } from '../../scripts/api.js';
import { archiveDialog, el, field } from './lora_archives_ui.js';

const nameKey = name => String(name || '').replace(/\\/g, '/').replace(/\.(safetensors|ckpt|pt|bin)$/i, '');

export function resolveTriggerWordPaths(names, library) {
  return new Map(names.map(name => {
    const key = nameKey(name);
    let matches = library.filter(item => nameKey(item.file_name) === key || nameKey(item.file_path) === key);
    if (!matches.length && !key.includes('/')) matches = library.filter(item => nameKey(item.file_name).split('/').pop() === key);
    const paths = [...new Set(matches.map(item => item.file_path).filter(Boolean))];
    return [name, paths.length === 1 ? paths[0] : null];
  }));
}

export function editLoraTriggerWords({ names, t, signal, onSaved }) {
  let pending = [...new Set(names)];
  if (!pending.length) return Promise.resolve(null);
  return archiveDialog({ title: t('bulkTriggerWordsTitle'), t, signal,
    formatError: error => error.message,
    build(body) {
      const description = el('p', '', t('bulkTriggerWordsDescription', { count: pending.length }));
      const input = el('textarea', 'lm-bulk-trigger-words-input'); input.rows = 6;
      input.placeholder = t('bulkTriggerWordsPlaceholder');
      const help = el('p', '', t('bulkTriggerWordsHelp'));
      body.append(description, field(t('bulkTriggerWordsTitle'), input), help);
      queueMicrotask(() => { if (input.isConnected) input.focus(); });
      return { input, description };
    },
    actions: [{ label: t('bulkTriggerWordsSave'), primary: true, async run({ input, description }) {
      const words = [...new Set(input.value.split(/\r?\n/).map(word => word.trim()).filter(Boolean))];
      if (!words.length) throw new Error(t('bulkTriggerWordsEmpty'));
      if (words.length > 100) throw new Error(t('triggerWordsTooMany'));
      if (words.some(word => word.split(/\s+/).length > 500)) throw new Error(t('triggerWordsTooLong'));
      const failed = [], saved = [];
      input.disabled = true;
      try {
        const response = await api.fetchApi('/lm/loras/cycler-list', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal,
        });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (data.success === false || !Array.isArray(data.loras)) throw new Error();
        const paths = resolveTriggerWordPaths(pending, data.loras);
        const savedPaths = new Set();
        for (const name of pending) {
          if (signal?.aborted) break;
          const filePath = paths.get(name);
          if (!filePath) { failed.push(name); continue; }
          if (savedPaths.has(filePath)) continue;
          try {
            const result = await api.fetchApi('/lm/loras/save-metadata', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
              body: JSON.stringify({ file_path: filePath, civitai: { trainedWords: words } }),
            });
            if (!result.ok || (await result.json()).success === false) throw new Error();
            savedPaths.add(filePath); saved.push(name);
          } catch { failed.push(name); }
        }
      } catch {
        failed.push(...pending);
      } finally { input.disabled = false; }
      if (signal?.aborted) return null;
      if (saved.length) onSaved?.(saved);
      pending = [...new Set(failed)];
      if (pending.length) {
        description.textContent = t('bulkTriggerWordsDescription', { count: pending.length });
        throw new Error(`${t('bulkTriggerWordsFailed', { count: pending.length })}: ${pending.join(', ')}`);
      }
      return true;
    } }],
  });
}
