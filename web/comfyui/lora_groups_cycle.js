import { planGroupCycle } from './lora_groups_state.js';
import { applyLoraValuesToText } from './lora_syntax_utils.js';

// Non-enumerable provenance survives graphToPrompt's array wrapper, but never
// enters workflow JSON or the backend API. Serialization alone reserves nothing.
const SOURCE = Symbol('lmGroupCycleSource');
const coordinators = new WeakMap();
const copy = value => JSON.parse(JSON.stringify(value));
const unwrap = value => Array.isArray(value) ? value : value?.__value__;

function signature(config, entries) {
  const groups = config.groups.map(({ id, mode, enabled, autoCycle, pausedActive }) => ({ id, mode, enabled, autoCycle, pausedActive }));
  return JSON.stringify([groups, entries.map(({ selected, ...entry }) => entry)]);
}

export function cycleExecutionScope(output, targets, definitions) {
  const roots = targets?.length ? targets.map(String)
    : Object.keys(output).filter(id => definitions.get(output[id].class_type)?.output_node);
  const scope = new Set();
  const visit = id => {
    if (scope.has(id) || !output[id]) return;
    scope.add(id);
    for (const value of Object.values(output[id].inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number'
        && ['string', 'number'].includes(typeof value[0])) visit(String(value[0]));
    }
  };
  roots.forEach(visit);
  return scope;
}

function patchWorkflow(workflow, source, entries) {
  if (!workflow) return;
  const graph = source.node.graph;
  const serializedGraph = graph === source.root ? workflow
    : workflow.definitions?.subgraphs?.find(item => String(item.id) === String(graph?.id));
  const saved = serializedGraph?.nodes?.find(item => String(item.id) === String(source.node.id));
  if (!saved?.widgets_values) return;
  const index = source.node.widgets?.indexOf(source.widget) ?? -1;
  if (index >= 0) saved.widgets_values[index] = copy(entries);
  const textIndex = source.node.widgets?.findIndex(item => item.name === 'text') ?? -1;
  if (textIndex >= 0 && typeof saved.widgets_values[textIndex] === 'string') {
    saved.widgets_values[textIndex] = applyLoraValuesToText(saved.widgets_values[textIndex], entries);
  }
}

export class LoraCycleCoordinator {
  constructor(api) {
    this.api = api;
    this.definitions = new Map();
    this.pending = new Map();
    this.observed = new Map();
    this.finished = new Set();
    this.serial = Promise.resolve();
    this.inFlight = 0;
    this.currentPrompt = null;
    this.reconcileTimer = null;
    this.reconciling = null;
    this.installed = false;
  }

  defineNode(definition) {
    if (definition?.name) this.definitions.set(definition.name, { output_node: definition.output_node === true });
  }

  install() {
    if (this.installed || typeof this.api.queuePrompt !== 'function') return;
    this.installed = true;
    const coordinator = this;
    const original = this.api.queuePrompt;
    this.api.queuePrompt = function (...args) {
      const run = () => coordinator.submit(original, this, args);
      const result = coordinator.serial.then(run, run);
      coordinator.serial = result.catch(() => {});
      return result;
    };
    for (const type of ['execution_start', 'executing', 'executed', 'execution_cached',
      'execution_success', 'execution_error', 'execution_interrupted']) {
      this.api.addEventListener(type, event => this.event(type, event.detail));
    }
    for (const type of ['status', 'reconnected']) {
      this.api.addEventListener(type, () => this.scheduleReconcile());
    }
  }

  register({ node, widget, getRoot, getState, advance }) {
    this.install();
    const coordinator = this;
    const registration = {
      node, widget, getRoot, getState, advance, revision: 0, alive: true, signature: null,
      observe(config, entries, automatic = false) {
        const next = signature(config, entries);
        if (this.signature !== null && this.signature !== next && !automatic) this.invalidate();
        this.signature = next;
      },
      invalidate() {
        this.revision++;
        coordinator.forget(this);
      },
      dispose() {
        this.alive = false;
        this.invalidate();
        if (widget.serializeValue === serialize) {
          if (original) widget.serializeValue = original;
          else delete widget.serializeValue;
        }
      },
    };
    const original = widget.serializeValue;
    function serialize(...args) {
      const mark = values => {
        if (!Array.isArray(values)) return values;
        const state = getState();
        registration.observe(state.config, state.entries);
        if (!state.config.groups.some(group => group.autoCycle && group.mode === 'single' && group.enabled
          && values.some(entry => entry.groupId === group.id))) return values;
        const result = values.map(entry => ({ ...entry }));
        Object.defineProperty(result, SOURCE, { value: {
          registration, node, widget, root: getRoot(), graph: node.graph,
          revision: registration.revision, mode: node.mode, config: copy(state.config),
        } });
        return result;
      };
      const result = original ? original.apply(this, args) : widget.value;
      return result?.then ? result.then(mark) : mark(result);
    }
    widget.serializeValue = serialize;
    return registration;
  }

  valid(source) {
    const reg = source.registration;
    return reg.alive && reg.revision === source.revision && reg.getRoot() === source.root
      && reg.node.graph === source.graph && reg.node.mode === source.mode
      && ![2, 4].includes(reg.node.mode);
  }

  forget(registration) {
    for (const [id, record] of this.pending) {
      record.bindings = record.bindings.filter(binding => binding.source.registration !== registration);
      if (!record.bindings.length) this.finish(id);
    }
  }

  async submit(original, receiver, args) {
    const [number, prompt, options] = args;
    const sources = Object.entries(prompt?.output || {}).flatMap(([id, entry]) => {
      const values = unwrap(entry.inputs?.loras);
      const source = values?.[SOURCE];
      return source && this.valid(source) ? [{ id, source, values }] : [];
    });
    if (!sources.length) return original.apply(receiver, args);
    if (!this.definitions.size && typeof this.api.getNodeDefs === 'function') {
      Object.values(await this.api.getNodeDefs()).forEach(definition => this.defineNode(definition));
    }
    await this.reconcile();
    const scope = cycleExecutionScope(prompt.output, options?.partialExecutionTargets, this.definitions);
    const bindings = [];
    let outgoing;
    for (const { id, source, values } of sources) {
      if (!scope.has(id) || !this.valid(source)) continue;
      const live = source.registration.getState();
      const nextNames = Object.fromEntries(live.entries.filter(item => item.active).map(item => [item.groupId, item.name]));
      for (const record of this.pending.values()) {
        for (const binding of record.bindings) {
          if (binding.source.registration === source.registration && this.valid(binding.source)) {
            binding.steps.forEach(step => { nextNames[step.groupId] = step.next; });
          }
        }
      }
      const plan = planGroupCycle(values, source.config, nextNames);
      if (!plan.steps.length) continue;
      outgoing ||= copy(prompt);
      const inputs = outgoing.output[id].inputs;
      inputs.loras = Array.isArray(inputs.loras) ? plan.entries : { ...inputs.loras, __value__: plan.entries };
      if (typeof inputs.text === 'string') inputs.text = applyLoraValuesToText(inputs.text, plan.entries);
      patchWorkflow(outgoing.workflow, source, plan.entries);
      bindings.push({ id, source, steps: plan.steps });
    }
    if (!bindings.length) return original.apply(receiver, args);
    this.inFlight++;
    try {
      const result = await original.call(receiver, number, outgoing, ...args.slice(2));
      const id = result?.prompt_id;
      if (id && !this.finished.has(id)) {
        const remaining = bindings.filter(binding => this.valid(binding.source));
        if (remaining.length) {
          this.pending.set(id, { bindings: remaining });
          this.complete(id);
        } else this.finish(id);
      }
      return result;
    } finally {
      this.inFlight--;
      if (!this.inFlight) {
        for (const id of this.observed.keys()) if (!this.pending.has(id)) this.observed.delete(id);
        this.scheduleReconcile();
      }
    }
  }

  event(type, detail) {
    if (type === 'execution_start') this.currentPrompt = detail?.prompt_id;
    const id = detail?.prompt_id || (type === 'executing' ? this.currentPrompt : null);
    if (!id || this.finished.has(id) || (!this.pending.has(id) && !this.inFlight)) return;
    let observation = this.observed.get(id);
    if (!observation) {
      observation = { nodes: new Set(), terminal: null };
      this.observed.set(id, observation);
    }
    if (type === 'execution_cached') (detail?.nodes || []).forEach(node => observation.nodes.add(String(node)));
    if (type === 'executed' || type === 'executing') {
      const node = typeof detail === 'object' ? detail?.node : detail;
      if (node != null) observation.nodes.add(String(node));
    }
    if (['execution_success', 'execution_error', 'execution_interrupted'].includes(type)) observation.terminal ||= type;
    this.complete(id);
  }

  complete(id) {
    const record = this.pending.get(id);
    const observation = this.observed.get(id);
    if (!record || !observation?.terminal) return;
    this.finish(id);
    if (observation.terminal !== 'execution_success') return;
    const updates = new Map();
    for (const binding of record.bindings) {
      if (!this.valid(binding.source) || !observation.nodes.has(binding.id)) continue;
      const reg = binding.source.registration;
      const steps = updates.get(reg) || new Map();
      binding.steps.forEach(step => steps.set(step.groupId, step));
      updates.set(reg, steps);
    }
    for (const [registration, steps] of updates) {
      try { registration.advance([...steps.values()]); }
      catch (error) { console.error('LoRA Manager: could not advance group cycle.', error); }
    }
  }

  finish(id) {
    this.pending.delete(id);
    this.observed.delete(id);
    this.finished.add(id);
    if (this.finished.size > 1024) this.finished.delete(this.finished.values().next().value);
  }

  scheduleReconcile() {
    if (!this.pending.size || this.reconcileTimer !== null) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.reconcile();
    }, 150);
  }

  async reconcile() {
    if (this.inFlight || !this.pending.size || typeof this.api.fetchApi !== 'function') return;
    if (this.reconciling) return this.reconciling;
    const records = [...this.pending.entries()];
    this.reconciling = (async () => {
      try {
        const response = await this.api.fetchApi('/queue', { cache: 'no-store' });
        if (!response?.ok) return;
        const queue = await response.json();
        if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) return;
        const present = new Set([...queue.queue_running, ...queue.queue_pending].map(item => item[1]));
        for (const [id, record] of records) {
          if (present.has(id) || this.pending.get(id) !== record) continue;
          // History distinguishes a completed run from a deleted pending item.
          // Queue/status messages can arrive before execution_success is delivered.
          const historyResponse = await this.api.fetchApi(`/history/${encodeURIComponent(id)}`, { cache: 'no-store' });
          if (!historyResponse?.ok || this.pending.get(id) !== record) continue;
          const history = await historyResponse.json();
          const item = history[id];
          if (!item) this.finish(id);
          else for (const [type, detail] of item.status?.messages || []) this.event(type, detail);
        }
      } catch (error) {
        console.warn('LoRA Manager: could not reconcile queued group cycles.', error);
      }
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
}

export function getLoraCycleCoordinator(api) {
  if (!coordinators.has(api)) coordinators.set(api, new LoraCycleCoordinator(api));
  return coordinators.get(api);
}
