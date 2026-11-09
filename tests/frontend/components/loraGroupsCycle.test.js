import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoraCycleCoordinator } from '../../../web/comfyui/lora_groups_cycle.js';
import { normalizeGroupConfig, planGroupCycle } from '../../../web/comfyui/lora_groups_state.js';
import { gridSnapshot } from '../../../web/comfyui/lora_archives_state.js';

const clone = value => JSON.parse(JSON.stringify(value));
const makeEntries = (names = ['A', 'B', 'C'], groupId = 'group-1') => names.map((name, i) => ({
  name, groupId, active: i === 0, strength: .8, clipStrength: .3, expanded: true, locked: i === 0,
}));
const makeConfig = () => normalizeGroupConfig({ groups: [{ mode: 'single', autoCycle: true }] });
const active = entries => entries.filter(entry => entry.active).map(entry => entry.name);

function harness({ nested = false, definitions = true, serializer } = {}) {
  const listeners = new Map();
  const queued = new Map();
  const history = new Map();
  let nextId = 0;
  const send = vi.fn(async (number, prompt) => {
    const prompt_id = `p${++nextId}`;
    queued.set(prompt_id, clone(prompt));
    return { prompt_id };
  });
  const api = {
    queuePrompt: send,
    addEventListener(type, fn) { listeners.set(type, fn); },
    fetchApi: vi.fn(async path => ({ ok: true, json: async () => path === '/queue'
      ? { queue_running: [], queue_pending: [...queued.keys()].map(id => [0, id]) }
      : Object.fromEntries(history) })),
    getNodeDefs: vi.fn(async () => ({ Save: { name: 'Save', output_node: true } })),
  };
  const coordinator = new LoraCycleCoordinator(api);
  if (definitions) coordinator.defineNode({ name: 'Save', output_node: true });
  let root = { id: 'root' };
  const graph = nested ? { id: 'subgraph' } : root;
  const node = { id: 7, graph, widgets: [] };
  const widget = { name: 'loras', value: makeEntries() };
  if (serializer) widget.serializeValue = serializer;
  node.widgets.push(widget, { name: 'text', value: '' });
  let config = makeConfig();
  const advance = vi.fn(steps => {
    const choices = new Map(steps.map(step => [step.groupId, step.next]));
    widget.value = widget.value.map(entry => choices.has(entry.groupId)
      ? { ...entry, active: entry.name === choices.get(entry.groupId) } : entry);
    registration.observe(config, widget.value, true);
  });
  const registration = coordinator.register({ node, widget, getRoot: () => root,
    getState: () => ({ config, entries: widget.value }), advance });
  const id = nested ? '3:7' : '7';
  const prompt = async (wrapped = true) => {
    const values = await widget.serializeValue({ id }, 0);
    const saved = { id: 7, widgets_values: [clone(widget.value), ''], properties: { lmLoraGroups: clone(config) } };
    return {
      workflow: nested ? { nodes: [{ id: 3 }], definitions: { subgraphs: [{ id: 'subgraph', nodes: [saved] }] } } : { nodes: [saved] },
      output: { [id]: { class_type: 'Lora Loader (LoraManager)', inputs: { loras: wrapped ? { __value__: values } : values, text: '' } },
        '99': { class_type: 'Save', inputs: { model: [id, 0] } } },
    };
  };
  const emit = (type, detail) => listeners.get(type)?.({ detail });
  const complete = (prompt_id, { success = true, cached = false } = {}) => {
    emit('execution_start', { prompt_id });
    if (cached) emit('execution_cached', { prompt_id, nodes: [id] });
    else emit('executing', id);
    emit(success ? 'execution_success' : 'execution_error', { prompt_id });
    queued.delete(prompt_id);
  };
  const change = (entries = widget.value, nextConfig = config) => {
    widget.value = entries; config = nextConfig; registration.observe(config, entries);
  };
  return { api, coordinator, registration, node, widget, prompt, emit, complete, advance, send, queued, history, id, change,
    get config() { return config; }, setRoot(value) { root = value; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('cycle state', () => {
  it('defaults off and preserves the flag through grid snapshots and mode changes', () => {
    expect(normalizeGroupConfig().groups[0].autoCycle).toBe(false);
    const config = makeConfig();
    expect(gridSnapshot(config, makeEntries()).groupConfig.groups[0].autoCycle).toBe(true);
    config.groups[0].mode = 'multi';
    expect(planGroupCycle(makeEntries(), config).steps).toEqual([]);
    config.groups[0].mode = 'single'; config.groups[0].enabled = false;
    expect(planGroupCycle(makeEntries(), config).steps).toEqual([]);
  });

  it('handles empty groups, no active item, one item, wraparound and simultaneous groups', () => {
    const config = makeConfig();
    expect(planGroupCycle([], config).steps).toEqual([]);
    expect(planGroupCycle(makeEntries(['A']), config).steps[0]).toMatchObject({ used: 'A', next: 'A' });
    expect(planGroupCycle(makeEntries().map(entry => ({ ...entry, active: false })), config).steps[0].used).toBe('A');
    config.groups.push({ ...config.groups[0], id: 'second' });
    const entries = [...makeEntries(), ...makeEntries(['X', 'Y'], 'second')];
    const plan = planGroupCycle(entries, config, { 'group-1': 'C', second: 'Y' });
    expect(plan.steps.map(({ used, next }) => [used, next])).toEqual([['C', 'A'], ['Y', 'X']]);
    expect(active(plan.entries)).toEqual(['C', 'Y']);
    expect(plan.entries[0]).toMatchObject({ strength: .8, clipStrength: .3, locked: true });
    expect(active(entries)).toEqual(['A', 'X']);
  });
});

describe('prompt-bound group cycling', () => {
  it('leaves ordinary queue calls untouched while cycling is disabled', async () => {
    const h = harness({ definitions: false });
    const config = clone(h.config); config.groups[0].autoCycle = false; h.change(h.widget.value, config);
    const p = await h.prompt();
    await h.api.queuePrompt(0, p);
    expect(h.send.mock.calls[0][1]).toBe(p);
    expect(h.api.getNodeDefs).not.toHaveBeenCalled();
    expect(h.api.fetchApi).not.toHaveBeenCalled();
    expect(h.coordinator.pending.size).toBe(0);
  });

  it('advances multiple enabled groups together and leaves multi/paused groups alone', async () => {
    const h = harness();
    const config = normalizeGroupConfig({ columns: 4, groups: [
      { id: 'group-1', mode: 'single', autoCycle: true }, { id: 'second', mode: 'single', autoCycle: true },
      { id: 'multi', mode: 'multi', autoCycle: true }, { id: 'paused', mode: 'single', autoCycle: true, enabled: false },
    ] });
    h.change([...makeEntries(), ...makeEntries(['X', 'Y'], 'second'), ...makeEntries(['M'], 'multi'),
      ...makeEntries(['P'], 'paused').map(entry => ({ ...entry, active: false }))], config);
    await h.api.queuePrompt(0, await h.prompt());
    const result = await h.api.queuePrompt(0, await h.prompt());
    expect(active(h.queued.get(result.prompt_id).output['7'].inputs.loras.__value__)).toEqual(['B', 'Y', 'M']);
    h.complete(result.prompt_id);
    expect(active(h.widget.value)).toEqual(['C', 'X', 'M']);
  });

  it.each([true, false])('reserves A/B/C for batches without changing the visible selection (wrapped: %s)', async wrapped => {
    const h = harness();
    const original = await h.prompt(wrapped);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await h.api.queuePrompt(0, await h.prompt(wrapped))).prompt_id);
    const assigned = [...h.queued.values()].map(p => active(p.output['7'].inputs.loras.__value__ || p.output['7'].inputs.loras)[0]);
    expect(assigned).toEqual(['A', 'B', 'C', 'A']);
    expect(active(h.widget.value)).toEqual(['A']);
    expect(active(original.output['7'].inputs.loras.__value__ || original.output['7'].inputs.loras)).toEqual(['A']);
    expect([...h.queued.values()].map(p => active(p.workflow.nodes[0].widgets_values[0])[0])).toEqual(assigned);
    h.complete(ids[0]); expect(active(h.widget.value)).toEqual(['B']);
    h.complete(ids[1]); expect(active(h.widget.value)).toEqual(['C']);
    h.complete(ids[2]); expect(active(h.widget.value)).toEqual(['A']);
    h.complete(ids[3]); expect(active(h.widget.value)).toEqual(['B']);
    expect(h.advance).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(original)).not.toContain('registration');
  });

  it('uses the visible next selection for a newly submitted task after completion', async () => {
    const h = harness();
    const first = await h.api.queuePrompt(0, await h.prompt()); h.complete(first.prompt_id);
    const next = await h.api.queuePrompt(0, await h.prompt());
    expect(active(h.queued.get(next.prompt_id).output['7'].inputs.loras.__value__)).toEqual(['B']);
  });

  it('serializes concurrent submissions and rolls back a rejected submission', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new Error('validation failed'));
    const first = h.api.queuePrompt(0, await h.prompt());
    const rejected = expect(first).rejects.toThrow('validation failed');
    const second = h.api.queuePrompt(0, await h.prompt());
    await rejected;
    const result = await second;
    expect(active(h.queued.get(result.prompt_id).output['7'].inputs.loras.__value__)).toEqual(['A']);
  });

  it.each(['execution_error', 'execution_interrupted'])('does not advance on %s or rewrite the remaining batch', async type => {
    const h = harness();
    const a = await h.api.queuePrompt(0, await h.prompt());
    const b = await h.api.queuePrompt(0, await h.prompt());
    h.emit(type, { prompt_id: a.prompt_id });
    expect(active(h.widget.value)).toEqual(['A']);
    expect(active(h.queued.get(b.prompt_id).output['7'].inputs.loras.__value__)).toEqual(['B']);
    h.complete(b.prompt_id); expect(active(h.widget.value)).toEqual(['C']);
  });

  it('does not consume a slot when a response has no prompt id', async () => {
    const h = harness(); h.send.mockResolvedValueOnce({ node_errors: { 7: {} } });
    await h.api.queuePrompt(0, await h.prompt());
    const result = await h.api.queuePrompt(0, await h.prompt());
    expect(active(h.queued.get(result.prompt_id).output['7'].inputs.loras.__value__)).toEqual(['A']);
  });

  it('handles successful cached execution, duplicate notifications and foreign prompts', async () => {
    const h = harness(); const { prompt_id } = await h.api.queuePrompt(0, await h.prompt());
    h.complete('foreign', { cached: true }); expect(h.advance).not.toHaveBeenCalled();
    h.complete(prompt_id, { cached: true }); h.complete(prompt_id, { cached: true });
    expect(h.advance).toHaveBeenCalledOnce();
  });

  it('buffers execution events that arrive before the submit response', async () => {
    const h = harness();
    h.send.mockImplementationOnce(async () => {
      h.complete('early', { cached: true });
      return { prompt_id: 'early' };
    });
    await h.api.queuePrompt(0, await h.prompt());
    expect(active(h.widget.value)).toEqual(['B']);
    expect(h.coordinator.observed.size).toBe(0);
  });

  it('does not register a stale reservation if the user changes selection during submission', async () => {
    const h = harness();
    let finish;
    h.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const submitting = h.api.queuePrompt(0, await h.prompt());
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(finish).toBeTypeOf('function');
    h.change(h.widget.value.map(entry => ({ ...entry, active: entry.name === 'C' })));
    finish({ prompt_id: 'late' }); await submitting;
    h.complete('late');
    expect(h.coordinator.pending.size).toBe(0);
    expect(active(h.widget.value)).toEqual(['C']);
  });

  it('keeps reserved positions when titles and colors change', async () => {
    const h = harness();
    const first = await h.api.queuePrompt(0, await h.prompt());
    const config = clone(h.config); config.groups[0].title = 'Renamed'; config.groups[0].titleColor = 'red';
    h.change(h.widget.value, config);
    const second = await h.api.queuePrompt(0, await h.prompt());
    expect(active(h.queued.get(second.prompt_id).output['7'].inputs.loras.__value__)).toEqual(['B']);
    h.complete(first.prompt_id); expect(active(h.widget.value)).toEqual(['B']);
  });

  it('ignores completion after the node is bypassed', async () => {
    const h = harness(); const { prompt_id } = await h.api.queuePrompt(0, await h.prompt());
    h.node.mode = 4; h.complete(prompt_id); expect(h.advance).not.toHaveBeenCalled();
  });

  it('ignores a disconnected cached node and partial execution of another output', async () => {
    const h = harness(); const p = await h.prompt();
    p.output['99'].inputs = {};
    const one = await h.api.queuePrompt(0, p);
    h.complete(one.prompt_id, { cached: true }); expect(h.advance).not.toHaveBeenCalled();
    const two = await h.prompt(); two.output['100'] = { class_type: 'Save', inputs: {} };
    const result = await h.api.queuePrompt(0, two, { partialExecutionTargets: ['100'] });
    h.complete(result.prompt_id, { cached: true }); expect(h.advance).not.toHaveBeenCalled();
    const included = await h.api.queuePrompt(0, await h.prompt(), { partialExecutionTargets: ['99'] });
    h.complete(included.prompt_id); expect(h.advance).toHaveBeenCalledOnce();
  });

  it('does not advance an eligible but lazily unexecuted node', async () => {
    const h = harness(); const { prompt_id } = await h.api.queuePrompt(0, await h.prompt());
    h.emit('execution_success', { prompt_id });
    expect(h.advance).not.toHaveBeenCalled();
  });

  it.each(['manual', 'order', 'mode', 'archive', 'removed', 'workflow'])('invalidates old completion on %s changes', async action => {
    const h = harness(); const { prompt_id } = await h.api.queuePrompt(0, await h.prompt());
    if (action === 'manual') h.change(h.widget.value.map(entry => ({ ...entry, active: entry.name === 'C' })));
    if (action === 'order') h.change([...h.widget.value].reverse());
    if (action === 'mode') { const config = clone(h.config); config.groups[0].mode = 'multi'; h.change(h.widget.value, config); }
    if (action === 'archive') h.registration.invalidate();
    if (action === 'removed') h.registration.dispose();
    if (action === 'workflow') h.setRoot({});
    const before = clone(h.widget.value);
    h.complete(prompt_id);
    expect(h.advance).not.toHaveBeenCalled(); expect(h.widget.value).toEqual(before);
    if (action === 'manual') {
      const next = await h.api.queuePrompt(0, await h.prompt());
      expect(active(h.queued.get(next.prompt_id).output['7'].inputs.loras.__value__)).toEqual(['C']);
    }
  });

  it('discards queued reservations after cancellation and preserves current selection', async () => {
    const h = harness(); await h.api.queuePrompt(0, await h.prompt());
    await h.api.queuePrompt(0, await h.prompt());
    h.queued.clear(); h.emit('status', {}); await vi.advanceTimersByTimeAsync(151);
    expect(h.coordinator.pending.size).toBe(0); expect(h.advance).not.toHaveBeenCalled();
    const next = await h.api.queuePrompt(0, await h.prompt());
    expect(active(h.queued.get(next.prompt_id).output['7'].inputs.loras.__value__)).toEqual(['A']);
  });

  it('uses history when queue status races with a completion event', async () => {
    const h = harness(); const { prompt_id } = await h.api.queuePrompt(0, await h.prompt());
    h.queued.clear();
    h.history.set(prompt_id, { status: { messages: [
      ['execution_cached', { prompt_id, nodes: ['7'] }], ['execution_success', { prompt_id }],
    ] } });
    await h.coordinator.reconcile(); h.complete(prompt_id);
    expect(h.advance).toHaveBeenCalledOnce();
  });

  it('preserves reservations if queue inspection fails', async () => {
    const h = harness(); await h.api.queuePrompt(0, await h.prompt());
    h.api.fetchApi.mockResolvedValueOnce({ ok: false });
    await h.coordinator.reconcile(); expect(h.coordinator.pending.size).toBe(1);
  });

  it('matches subgraph execution ids and patches nested workflow metadata', async () => {
    const h = harness({ nested: true });
    await h.api.queuePrompt(0, await h.prompt());
    const { prompt_id } = await h.api.queuePrompt(0, await h.prompt());
    const p = h.queued.get(prompt_id);
    expect(active(p.output['3:7'].inputs.loras.__value__)).toEqual(['B']);
    expect(active(p.workflow.definitions.subgraphs[0].nodes[0].widgets_values[0])).toEqual(['B']);
    h.complete(prompt_id, { cached: true }); expect(active(h.widget.value)).toEqual(['C']);
  });

  it('coordinates two loader nodes in one task without sharing their cursors', async () => {
    const h = harness();
    const secondWidget = { name: 'loras', value: makeEntries(['X', 'Y']) };
    const secondNode = { id: 8, graph: h.node.graph, widgets: [secondWidget] };
    const config = makeConfig();
    const advance = vi.fn(steps => {
      secondWidget.value = secondWidget.value.map(entry => ({ ...entry, active: entry.name === steps[0].next }));
      registration.observe(config, secondWidget.value, true);
    });
    const registration = h.coordinator.register({ node: secondNode, widget: secondWidget,
      getRoot: () => h.node.graph, getState: () => ({ config, entries: secondWidget.value }), advance });
    const submit = async () => {
      const p = await h.prompt();
      p.output['8'] = { class_type: 'Lora Loader (LoraManager)', inputs: { loras: secondWidget.serializeValue() } };
      p.output['99'].inputs.other = ['8', 0];
      p.workflow.nodes.push({ id: 8, widgets_values: [clone(secondWidget.value)] });
      return h.api.queuePrompt(0, p);
    };
    const a = await submit(); const b = await submit();
    const payload = h.queued.get(b.prompt_id);
    expect(active(payload.output['7'].inputs.loras.__value__)).toEqual(['B']);
    expect(active(payload.output['8'].inputs.loras)).toEqual(['Y']);
    h.emit('execution_cached', { prompt_id: a.prompt_id, nodes: ['7', '8'] });
    h.emit('execution_success', { prompt_id: a.prompt_id });
    expect(active(h.widget.value)).toEqual(['B']); expect(active(secondWidget.value)).toEqual(['Y']);
    registration.dispose();
    h.emit('execution_cached', { prompt_id: b.prompt_id, nodes: ['7', '8'] });
    h.emit('execution_success', { prompt_id: b.prompt_id });
    expect(active(h.widget.value)).toEqual(['C']); expect(advance).toHaveBeenCalledOnce();
  });

  it('does not double-advance a shared subgraph definition used by two instances', async () => {
    const h = harness({ nested: true });
    const p = await h.prompt();
    p.output['4:7'] = { class_type: 'Lora Loader (LoraManager)', inputs: { loras: h.widget.serializeValue({ id: '4:7' }) } };
    p.output['99'].inputs.second = ['4:7', 0];
    const { prompt_id } = await h.api.queuePrompt(0, p);
    h.emit('execution_cached', { prompt_id, nodes: ['3:7', '4:7'] });
    h.emit('execution_success', { prompt_id });
    expect(h.advance).toHaveBeenCalledOnce(); expect(active(h.widget.value)).toEqual(['B']);
  });

  it('chains existing serialization and submission hooks and keeps ordinary saves inert', async () => {
    const serializer = vi.fn(function () { return this.value.map(entry => ({ ...entry, custom: true })); });
    const h = harness({ definitions: false, serializer });
    const send = h.send.getMockImplementation();
    h.send.mockImplementation(function (...args) {
      expect(this).toBe(h.api);
      return send(...args);
    });
    await h.prompt(); await h.prompt();
    expect(h.coordinator.pending.size).toBe(0); expect(h.send).not.toHaveBeenCalled();
    const { prompt_id } = await h.api.queuePrompt(-1, await h.prompt(), { previewMethod: 'none' });
    expect(h.api.getNodeDefs).toHaveBeenCalledOnce();
    expect(h.send.mock.calls[0][0]).toBe(-1); expect(h.send.mock.calls[0][2]).toEqual({ previewMethod: 'none' });
    expect(h.send.mock.calls[0][1].output['7'].inputs.loras.__value__[0].custom).toBe(true);
    expect(serializer).toHaveBeenCalledTimes(3);
    expect(prompt_id).toBe('p1');
    h.registration.dispose(); expect(h.widget.serializeValue).toBe(serializer);
  });
});
