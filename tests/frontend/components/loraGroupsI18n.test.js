import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import chinese from '../../../locales/zh-CN.json';

const { APP, API, modern, legacy, api, fetchMock } = vi.hoisted(() => ({
  APP: new URL('../../../scripts/app.js', import.meta.url).pathname,
  API: new URL('../../../scripts/api.js', import.meta.url).pathname,
  modern: vi.fn(), legacy: vi.fn(), fetchMock: vi.fn(), api: { fetchApi: vi.fn(), fileURL: vi.fn() },
}));
vi.mock(APP, () => ({ app: { extensionManager: { setting: { get: modern } }, ui: { settings: { getSettingValue: legacy } } } }));
vi.mock(API, () => ({ api }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  modern.mockReturnValue('zh'); legacy.mockReturnValue('en');
  api.fileURL = vi.fn(path => `/comfyui${path}`);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({ ok: true, json: async () => chinese });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('group static locale loading', () => {
  it('loads Chinese via the static file URL without modern ComfyUI API prefixing', async () => {
    const { loadGroupMessages } = await import('../../../web/comfyui/lora_groups_i18n.js');
    const messages = await loadGroupMessages();
    expect(fetchMock).toHaveBeenCalledWith('/comfyui/locales/zh-CN.json', { cache: 'no-cache' });
    expect(api.fetchApi).not.toHaveBeenCalled();
    expect(messages).toMatchObject({ rows: '行数', single: '单选', multi: '多选', sort: '排序' });
    await loadGroupMessages(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('supports legacy settings and the existing base-path helper without fileURL', async () => {
    modern.mockReturnValue(undefined); legacy.mockReturnValue('zh'); api.fileURL = undefined;
    const { loadGroupMessages } = await import('../../../web/comfyui/lora_groups_i18n.js');
    expect((await loadGroupMessages()).sort).toBe('排序');
    expect(fetchMock.mock.calls[0][0]).toBe('/locales/zh-CN.json');
  });
  it('retries failed locale requests instead of permanently caching English fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const { loadGroupMessages } = await import('../../../web/comfyui/lora_groups_i18n.js');
    expect((await loadGroupMessages()).rows).toBe('Rows');
    expect((await loadGroupMessages()).rows).toBe('行数');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
