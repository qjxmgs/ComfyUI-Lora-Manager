/**
 * Regression tests for load-time widget rewrites in the Lora Cycler widget.
 *
 * The Vue widget mounts while the graph is still being configured, so the
 * connected Lora Pool only becomes resolvable on the first poll tick. That
 * "initial resolution" is still part of loading the workflow: it may refresh
 * the displayed list but must not rewrite the saved widget value, otherwise
 * ComfyUI's ChangeTracker reports the untouched workflow as modified.
 */

import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LoraCyclerWidget from '@/components/LoraCyclerWidget.vue'
import { createMockCyclerConfig } from '../fixtures/mockConfigs'
import { mockFetch, resetFetchMock } from '../setup'

const POOL_FILTERS = {
  baseModels: ['Illustrious'],
  tags: { include: [], exclude: [] },
  folders: { include: [], exclude: [] },
  license: { noCreditRequired: false, allowSelling: false },
  namePatterns: { include: [], exclude: [], useRegex: false }
}

function jsonResponse(payload: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) })
}

function mockCyclerList(count: number) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/loras/cycler-list')) {
      return jsonResponse({
        success: true,
        loras: Array.from({ length: count }, (_, i) => ({
          file_name: i === 0 ? 'lora1.safetensors' : `lora${i + 1}.safetensors`,
          model_name: `LoRA ${i + 1}`,
          file_path: `/models/loras/lora${i + 1}.safetensors`
        }))
      })
    }
    return jsonResponse({})
  })
}

function createApi() {
  return { addEventListener: vi.fn(), removeEventListener: vi.fn() }
}

describe('LoraCyclerWidget load-time writes', () => {
  let wrapper: ReturnType<typeof shallowMount> | undefined
  let widget: any

  beforeEach(() => {
    vi.useFakeTimers()
    resetFetchMock()
  })

  afterEach(() => {
    // The widget clears its polling interval through onRemoveCleanup.
    widget?.onRemoveCleanup?.()
    wrapper?.unmount()
    wrapper = undefined
    widget = undefined
    vi.useRealTimers()
  })

  it('does not rewrite the saved value when the pool connection resolves after mount', async () => {
    const saved = createMockCyclerConfig({
      total_count: 2,
      pool_config_hash: '',
      current_lora_name: 'lora1.safetensors',
      current_lora_filename: 'lora1.safetensors'
    })
    widget = { value: saved }
    const node: any = {
      id: 1,
      widgets: [],
      // The pool link is not configured yet while the widget mounts.
      getPoolConfig: () => null
    }

    mockCyclerList(5)
    wrapper = shallowMount(LoraCyclerWidget, {
      props: { widget, node, api: createApi() }
    })
    await flushPromises()
    expect(widget.value).toBe(saved)

    // First poll tick: the pool becomes resolvable (load-time resolution).
    mockCyclerList(3)
    node.getPoolConfig = () => ({ filters: POOL_FILTERS })
    await vi.advanceTimersByTimeAsync(1100)
    await flushPromises()

    expect(widget.value).toBe(saved)
  })

  it('still writes the saved value when the pool configuration changes later', async () => {
    const saved = createMockCyclerConfig({
      total_count: 2,
      pool_config_hash: '',
      current_lora_name: 'lora1.safetensors',
      current_lora_filename: 'lora1.safetensors'
    })
    widget = { value: saved }
    let poolConfig: any = { filters: POOL_FILTERS }
    const node: any = {
      id: 1,
      widgets: [],
      getPoolConfig: () => poolConfig
    }

    mockCyclerList(3)
    wrapper = shallowMount(LoraCyclerWidget, {
      props: { widget, node, api: createApi() }
    })
    await flushPromises()
    expect(widget.value).toBe(saved)

    // A user edit of the connected pool filters is a real change.
    mockCyclerList(4)
    poolConfig = { filters: { ...POOL_FILTERS, baseModels: ['SDXL'] } }
    await vi.advanceTimersByTimeAsync(1100)
    await flushPromises()

    expect(widget.value).not.toBe(saved)
    expect(widget.value.total_count).toBe(4)
  })
})
