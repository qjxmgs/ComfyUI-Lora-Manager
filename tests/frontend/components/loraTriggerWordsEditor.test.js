import { afterEach, describe, expect, it, vi } from 'vitest';
const { API, fetchApi } = vi.hoisted(() => ({ API: new URL('../../../scripts/api.js', import.meta.url).pathname, fetchApi: vi.fn() }));
vi.mock(API, () => ({ api: { fetchApi } }));
import { editLoraTriggerWords, resolveTriggerWordPaths } from '../../../web/comfyui/lora_trigger_words_editor.js';

const library = [
  { file_name: 'folder/A', file_path: 'E:/models/folder/A.safetensors' },
  { file_name: 'folder/B', file_path: 'E:/models/folder/B.safetensors' },
];
const response = data => ({ ok: true, json: async () => data });
const t = (key, params = {}) => `${key}${params.count === undefined ? '' : ` ${params.count}`}`;
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const lifetimes = [];
function open(names = ['folder/A', 'folder/B']) {
  const lifetime = new AbortController(); lifetimes.push(lifetime);
  const onSaved = vi.fn();
  const result = editLoraTriggerWords({ names, t, onSaved, signal: lifetime.signal });
  const input = document.querySelector('textarea');
  const save = document.querySelector('.lm-archive-primary');
  return { result, input, save, onSaved, lifetime };
}
afterEach(() => { lifetimes.splice(0).forEach(controller => controller.abort()); document.body.replaceChildren(); vi.resetAllMocks(); });

describe('workflow trigger word editor', () => {
  it('resolves full names without confusing same basenames or multiple roots', () => {
    const models = [...library, { file_name: 'other/A', file_path: 'F:/other/A.safetensors' }];
    const paths = resolveTriggerWordPaths(['folder\\A.safetensors', 'other/A', 'A', 'missing/A', 'B'], models);
    expect(paths.get('folder\\A.safetensors')).toBe(library[0].file_path);
    expect(paths.get('other/A')).toBe('F:/other/A.safetensors');
    expect(paths.get('A')).toBeNull(); expect(paths.get('missing/A')).toBeNull();
    expect(paths.get('B')).toBe(library[1].file_path);
    expect(resolveTriggerWordPaths(['folder/A'], [...models, { file_name: 'folder/A', file_path: 'G:/folder/A.safetensors' }]).get('folder/A')).toBeNull();
  });
  it('replaces metadata for captured selection, deduplicating lines and keeping commas inside phrases', async () => {
    fetchApi.mockImplementation(async path => response(path.endsWith('cycler-list') ? { loras: library } : { success: true }));
    const names = ['folder/A', 'folder/B']; const view = open(names); names.push('unselected');
    view.input.value = ' alpha\r\n\nalpha\nbeta, gamma ';
    view.save.click(); view.save.click(); await flush();
    const saves = fetchApi.mock.calls.filter(([path]) => path.endsWith('save-metadata'));
    expect(saves.map(([, options]) => JSON.parse(options.body))).toEqual(library.map(item => ({ file_path: item.file_path, civitai: { trainedWords: ['alpha', 'beta, gamma'] } })));
    expect(view.onSaved).toHaveBeenCalledWith(['folder/A', 'folder/B']);
    expect(await view.result).toBe(true);
  });
  it.each([[' ', 'bulkTriggerWordsEmpty'], [Array.from({ length: 101 }, (_, i) => `word${i}`).join('\n'), 'triggerWordsTooMany'], [Array(501).fill('word').join(' '), 'triggerWordsTooLong']])('validates entries before sending requests: %s', async (value, message) => {
    const view = open(); view.input.value = value; view.save.click(); await flush();
    expect(fetchApi).not.toHaveBeenCalled();
    expect(document.querySelector('.lm-archive-error').textContent).toBe(message);
  });
  it('retains failures for retry without writing successful models twice', async () => {
    let failB = true;
    fetchApi.mockImplementation(async (path, options) => {
      if (path.endsWith('cycler-list')) return response({ loras: library });
      if (JSON.parse(options.body).file_path === library[1].file_path && failB) return { ok: false };
      return response({ success: true });
    });
    const view = open(); view.input.value = 'word'; view.save.click(); await flush();
    expect(document.querySelector('.lm-archive-error').textContent).toContain('bulkTriggerWordsFailed 1');
    expect(view.onSaved).toHaveBeenCalledWith(['folder/A']);
    failB = false; view.save.click(); await flush();
    expect(fetchApi.mock.calls.filter(([path, options]) => path.endsWith('save-metadata') && JSON.parse(options.body).file_path === library[0].file_path)).toHaveLength(1);
    expect(await view.result).toBe(true);
  });
  it('reports missing models and library failures without writing metadata', async () => {
    fetchApi.mockResolvedValueOnce({ ok: false }).mockResolvedValue(response({ loras: [] }));
    const view = open(['missing']); view.input.value = 'word'; view.save.click(); await flush();
    expect(document.querySelector('.lm-archive-error').textContent).toContain('bulkTriggerWordsFailed 1');
    view.save.click(); await flush();
    expect(fetchApi.mock.calls.every(([path]) => path.endsWith('cycler-list'))).toBe(true);
  });
  it('closes on node removal and stops unsent writes', async () => {
    let finish;
    fetchApi.mockResolvedValueOnce(response({ loras: library })).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = open(); view.input.value = 'word'; view.save.click(); await flush();
    view.lifetime.abort(); finish(response({ success: true })); await flush();
    expect(document.querySelector('.lm-archive-dialog')).toBeNull();
    expect(fetchApi).toHaveBeenCalledTimes(2);
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(await view.result).toBeNull();
  });
});
