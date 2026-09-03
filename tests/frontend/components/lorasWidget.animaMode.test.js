import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  APP_MODULE,
  UTILS_MODULE,
  WIDGET_UTILS_MODULE,
  EVENTS_MODULE,
  HIGHLIGHT_MODULE,
  LORA_INFO_MODULE,
  PREVIEW_MODULE,
  STYLES_MODULE,
  SETTINGS_MODULE,
  LORAS_WIDGET_MODULE,
} = vi.hoisted(() => ({
  APP_MODULE: new URL("../../../scripts/app.js", import.meta.url).pathname,
  UTILS_MODULE: new URL("../../../web/comfyui/utils.js", import.meta.url).pathname,
  WIDGET_UTILS_MODULE: new URL("../../../web/comfyui/loras_widget_utils.js", import.meta.url).pathname,
  EVENTS_MODULE: new URL("../../../web/comfyui/loras_widget_events.js", import.meta.url).pathname,
  HIGHLIGHT_MODULE: new URL("../../../web/comfyui/trigger_word_highlight.js", import.meta.url).pathname,
  LORA_INFO_MODULE: new URL("../../../web/comfyui/lora_info.js", import.meta.url).pathname,
  PREVIEW_MODULE: new URL("../../../web/comfyui/preview_tooltip.js", import.meta.url).pathname,
  STYLES_MODULE: new URL("../../../web/comfyui/lm_styles_loader.js", import.meta.url).pathname,
  SETTINGS_MODULE: new URL("../../../web/comfyui/settings.js", import.meta.url).pathname,
  LORAS_WIDGET_MODULE: new URL("../../../web/comfyui/loras_widget.js", import.meta.url).pathname,
}));

const extensionState = { current: null };
vi.mock(APP_MODULE, () => ({
  app: {
    registerExtension(extension) {
      extensionState.current = extension;
    },
  },
}));
vi.mock(UTILS_MODULE, () => ({
  forwardMiddleMouseToCanvas: vi.fn(),
  forwardWheelToCanvas: vi.fn(),
  enableListWheelScroll: vi.fn(),
  updateDownstreamLoaders: vi.fn(),
}));
vi.mock(WIDGET_UTILS_MODULE, () => ({
  parseLoraValue: (value) => Array.isArray(value) ? value : [],
  formatLoraValue: (value) => value,
  shouldShowClipEntry: () => false,
  syncClipStrengthIfCollapsed: vi.fn(),
  getAvailableLoras: () => Promise.resolve(new Set()),
  getAvailableLorasSync: () => new Set(),
  isLoraNameAvailable: () => true,
  onLibraryChanged: () => () => {},
}));
vi.mock(EVENTS_MODULE, () => ({
  initDrag: vi.fn(),
  createContextMenu: vi.fn(),
  initHeaderDrag: vi.fn(),
  initReorderDrag: vi.fn(),
  handleKeyboardNavigation: () => false,
}));
vi.mock(HIGHLIGHT_MODULE, () => ({ applySelectionHighlight: vi.fn() }));
vi.mock(LORA_INFO_MODULE, () => ({ updateConnectedLoraInfoNodes: vi.fn() }));
vi.mock(PREVIEW_MODULE, () => ({
  PreviewTooltip: class {
    hide() {}
    async show() {}
  },
}));
vi.mock(STYLES_MODULE, () => ({ ensureLmStyles: vi.fn() }));
vi.mock(SETTINGS_MODULE, () => ({ getStrengthStepPreference: () => 0.05 }));

function createNode(comfyClass) {
  const node = {
    comfyClass,
    widgets: [{ name: "anima_mode", value: false, callback: null }],
    properties: {},
    graph: { trigger: vi.fn(), setDirtyCanvas: vi.fn() },
    addDOMWidget(name, type, element, config) {
      const widget = { name, type, element, __dragActive: false };
      Object.defineProperty(widget, "value", {
        get: config.getValue,
        set: config.setValue,
      });
      this.widgets.push(widget);
      return widget;
    },
  };
  return node;
}

describe("Lora widget Anima mode control", () => {
  beforeEach(() => {
    vi.resetModules();
    extensionState.current = null;
    document.body.replaceChildren();
  });

  it("renders only on Lora Loader, syncs the backing value, and keeps other nodes unchanged", async () => {
    await import(LORAS_WIDGET_MODULE);
    const customWidgets = extensionState.current.getCustomWidgets();

    const loaderNode = createNode("Lora Loader (LoraManager)");
    const loaderResult = customWidgets.LORAS(loaderNode);
    loaderResult.widget.value = [{ name: "demo", strength: 1, active: true }];

    const animaContainer = loaderResult.widget.element.querySelector(".lm-anima-mode-container");
    expect(animaContainer).not.toBeNull();
    expect(animaContainer.textContent).toContain("Anima 2.9B 模式");

    animaContainer.querySelector(".lm-lora-toggle").click();
    expect(loaderNode.widgets[0].value).toBe(true);
    expect(loaderNode.properties.anima_mode).toBe(true);
    expect(loaderNode.graph.setDirtyCanvas).toHaveBeenCalledWith(true, true);

    const stackerNode = createNode("Lora Stacker (LoraManager)");
    const stackerResult = customWidgets.LORAS(stackerNode);
    stackerResult.widget.value = [{ name: "demo", strength: 1, active: true }];
    expect(stackerResult.widget.element.querySelector(".lm-anima-mode-container")).toBeNull();
  });
});
