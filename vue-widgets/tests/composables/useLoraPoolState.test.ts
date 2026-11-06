/**
 * Unit tests for useLoraPoolState.
 *
 * Regression coverage for load-time widget rewrites: refreshing the preview
 * after a workflow loads must not reserialize the widget value. ComfyUI's
 * ChangeTracker diffs the serialized `widget.value`, so writing the derived
 * `preview` (match count + timestamp) back on load marked untouched workflows
 * as modified.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useLoraPoolState } from '@/composables/useLoraPoolState'
import type { LoraPoolConfig } from '@/composables/types'
import { mockFetch, resetFetchMock } from '../setup'

function jsonResponse(payload: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) })
}

/** Answers the pool widget's filter-option and preview requests. */
function mockPreviewApi({ total = 179 } = {}) {
  resetFetchMock()
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/loras/base-models')) {
      return jsonResponse({ base_models: [] })
    }
    if (url.includes('/loras/top-tags')) {
      return jsonResponse({ tags: [] })
    }
    if (url.includes('/loras/unified-folder-tree')) {
      return jsonResponse({ tree: {} })
    }
    if (url.includes('/loras/list')) {
      return jsonResponse({ items: [], total })
    }
    return jsonResponse({})
  })
}

/** Mirrors the pool_config saved by Lora_Randomizer.json / Lora_Cycler.json. */
function createSavedPoolConfig(
  overrides: Partial<LoraPoolConfig> = {}
): LoraPoolConfig {
  return {
    version: 2,
    filters: {
      baseModels: ['Illustrious'],
      tags: { include: [], exclude: [] },
      folders: { include: [], exclude: [] },
      license: { noCreditRequired: true, allowSelling: false },
      namePatterns: { include: [], exclude: [], useRegex: false }
    },
    preview: { matchCount: 179, lastUpdated: 1793451564723 },
    ...overrides
  }
}

describe('useLoraPoolState widget serialization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockPreviewApi()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not rewrite the widget value on the mount-time preview refresh', async () => {
    const saved = createSavedPoolConfig()
    const widget: any = { value: saved }
    const state = useLoraPoolState(widget)

    // LoraPoolWidget.onMounted(): restore → fetch filter options → preview
    state.restoreFromConfig(widget.value)
    await state.fetchFilterOptions()
    await state.refreshPreview()

    // Flush the debounced filter watcher scheduled by the restore as well.
    await vi.advanceTimersByTimeAsync(400)

    expect(widget.value).toBe(saved)
    // The live preview state is still refreshed for the UI.
    expect(state.matchCount.value).toBe(179)
  })

  it('does not rewrite the widget value when only the preview content changes', async () => {
    const saved = createSavedPoolConfig()
    const widget: any = { value: saved }
    const state = useLoraPoolState(widget)

    state.restoreFromConfig(widget.value)
    mockPreviewApi({ total: 245 })
    await state.refreshPreview()

    expect(widget.value).toBe(saved)
    expect(state.matchCount.value).toBe(245)
  })

  it('writes the widget value when the user changes a filter', async () => {
    const saved = createSavedPoolConfig()
    const widget: any = { value: saved }
    const state = useLoraPoolState(widget)

    state.restoreFromConfig(widget.value)
    await vi.advanceTimersByTimeAsync(400)
    expect(widget.value).toBe(saved)

    state.selectedBaseModels.value = ['SDXL']
    await vi.advanceTimersByTimeAsync(400)

    expect(widget.value).not.toBe(saved)
    expect(widget.value.filters.baseModels).toEqual(['SDXL'])
    expect(widget.value.preview.matchCount).toBe(179)
    expect(widget.value.preview.lastUpdated).toBeGreaterThan(
      saved.preview.lastUpdated
    )
  })

  it('keeps the written value stable across later preview refreshes', async () => {
    const saved = createSavedPoolConfig()
    const widget: any = { value: saved }
    const state = useLoraPoolState(widget)

    state.restoreFromConfig(widget.value)
    state.includeTags.value = ['anime']
    await vi.advanceTimersByTimeAsync(400)

    const written = widget.value
    expect(written.filters.tags.include).toEqual(['anime'])

    await state.refreshPreview()
    await state.refreshPreview()

    expect(widget.value).toBe(written)
  })

  it('still writes an initial config for a node without a saved value', async () => {
    const widget: any = {}
    const state = useLoraPoolState(widget)

    await state.refreshPreview()

    expect(widget.value).toMatchObject({
      version: 2,
      filters: { baseModels: [] }
    })
    expect(widget.value.preview.matchCount).toBe(179)
  })
})
