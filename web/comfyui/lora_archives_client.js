import { lmUrl } from './base_path.js';

const BASE = '/api/lm/grid-archives';

export class GridArchiveClient {
  constructor() {
    this.data = { revision: 0, categories: [], archives: [] };
    this.ready = false;
    this.error = null;
    this.listeners = new Set();
    this.pending = null;
    this.epoch = 0;
    this.onFocus = () => { this.refresh().catch(() => {}); };
  }

  subscribe(callback) {
    this.listeners.add(callback);
    if (this.listeners.size === 1) window.addEventListener('focus', this.onFocus);
    return () => {
      this.listeners.delete(callback);
      if (!this.listeners.size) window.removeEventListener('focus', this.onFocus);
    };
  }

  emit() { this.listeners.forEach(callback => callback()); }

  async request(path = '', options = {}) {
    const response = await fetch(lmUrl(BASE + path), { ...options, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'storage'), { code: data.error || 'storage', status: response.status });
    if (!Array.isArray(data.archives) || !Array.isArray(data.categories)) throw new Error('invalid');
    return data;
  }

  refresh() {
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    this.pending = this.request().then(data => {
      if (epoch === this.epoch) {
        const changed = !this.ready || this.error || JSON.stringify(data) !== JSON.stringify(this.data);
        this.data = data; this.ready = true; this.error = null;
        if (changed) this.emit();
      }
      return this.data;
    }).catch(error => { this.error = error; this.emit(); throw error; })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  async write(path, method, payload = {}, revision = this.data.revision) {
    const data = await this.request(path, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, revision }),
    });
    this.epoch++;
    this.data = data; this.ready = true; this.error = null; this.emit();
    return data;
  }

  async image(id, file, revision = this.data.revision) {
    const data = await this.request(`/archives/${encodeURIComponent(id)}/image`, {
      method: file ? 'POST' : 'DELETE', headers: { 'If-Match': String(revision) }, ...(file ? { body: file } : {}),
    });
    this.epoch++;
    this.data = data; this.error = null; this.emit();
    return data;
  }

  imageUrl(archive) {
    return lmUrl(`${BASE}/archives/${encodeURIComponent(archive.id)}/image?v=${encodeURIComponent(archive.image || '')}`);
  }
}

export const gridArchiveClient = new GridArchiveClient();
