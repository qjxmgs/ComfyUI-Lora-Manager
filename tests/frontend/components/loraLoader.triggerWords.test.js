import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  APP_MODULE,
  API_MODULE,
  UTILS_MODULE,
  LORA_LOADER_MODULE,
} = vi.hoisted(() => ({
  APP_MODULE: new URL("../../../scripts/app.js", import.meta.url).pathname,
  API_MODULE: new URL("../../../scripts/api.js", import.meta.url).pathname,
  UTILS_MODULE: new URL("../../../web/comfyui/utils.js", import.meta.url).pathname,
  LORA_LOADER_MODULE: new URL("../../../web/comfyui/lora_loader.js", import.meta.url).pathname,
}));

const extensionState = { current: null };
const registerExtensionMock = vi.fn((extension) => {
  extensionState.current = extension;
});

vi.mock(APP_MODULE, () => ({
  app: {
    registerExtension: registerExtensionMock,
    graph: {},
  },
}));

vi.mock(API_MODULE, () => ({
  api: {
    addEventListener: vi.fn(),
  },
}));

const collectActiveLorasFromChain = vi.fn();
const updateConnectedTriggerWords = vi.fn();
const mergeLoras = vi.fn();
const getAllGraphNodes = vi.fn();
const getNodeFromGraph = vi.fn();
const getWidgetByName = vi.fn((node, name) =>
  node?.widgets?.find((widget) => widget?.name === name) ?? null
);
const getWidgetSerializedValue = vi.fn((node, name) => {
  const index = node?.widgets?.findIndex((widget) => widget?.name === name) ?? -1;
  return index >= 0 ? node.widgets_values?.[index] : undefined;
});

vi.mock(UTILS_MODULE, () => ({
  collectActiveLorasFromChain,
  updateConnectedTriggerWords,
  mergeLoras,
  chainCallback: (proto, property, callback) => {
    proto[property] = callback;
  },
  getAllGraphNodes,
  getNodeFromGraph,
  getWidgetByName,
  getWidgetSerializedValue,
  LORA_PATTERN: /<lora:([^:]+):([-\d.]+)(?::([-\d.]+))?>/g,
}));

describe("Lora Loader trigger word updates", () => {
  beforeEach(() => {
    vi.resetModules();

    extensionState.current = null;
    registerExtensionMock.mockClear();

    collectActiveLorasFromChain.mockClear();
    collectActiveLorasFromChain.mockImplementation(() => new Set(["Alpha"]));

    updateConnectedTriggerWords.mockClear();

    mergeLoras.mockClear();
    mergeLoras.mockImplementation(() => [{ name: "Alpha", active: true }]);

    getWidgetByName.mockClear();
    getWidgetSerializedValue.mockClear();
  });

  it("refreshes trigger word toggles after LoRA syntax edits in the input widget", async () => {
    await import(LORA_LOADER_MODULE);

    expect(registerExtensionMock).toHaveBeenCalled();
    const extension = extensionState.current;
    expect(extension).toBeDefined();

    const nodeType = { comfyClass: "Lora Loader (LoraManager)", prototype: {} };
    await extension.beforeRegisterNodeDef(nodeType, {}, {});

    // Create mock widget (AUTOCOMPLETE_TEXT_LORAS type created by Vue widgets)
    const inputWidget = {
      name: "text",
      value: "",
      options: {},
      callback: null, // Will be set by onNodeCreated
    };

    const metadataWidget = {
      name: "__autocomplete_metadata_text",
      value: { version: 1, textWidgetName: "text" },
      options: {},
    };

    // Declared LORAS input widget, created by the LoraManager.LorasWidget
    // extension and taken over by the loader's onNodeCreated.
    const lorasWidget = {
      name: "loras",
      value: [],
      options: {},
      callback: null, // Will be set by onNodeCreated
    };

    const node = {
      comfyClass: "Lora Loader (LoraManager)",
      widgets: [metadataWidget, inputWidget, lorasWidget],
      addInput: vi.fn(),
      graph: {},
    };

    nodeType.prototype.onNodeCreated.call(node);

    // The widget is now the AUTOCOMPLETE_TEXT_LORAS type, created automatically by Vue widgets
    expect(node.inputWidget).toBe(inputWidget);
    expect(node.lorasWidget).toBe(lorasWidget);
    expect(getWidgetByName).toHaveBeenCalledWith(node, "text");
    expect(typeof lorasWidget.callback).toBe("function");

    // The callback should have been set up by onNodeCreated
    const inputCallback = inputWidget.callback;
    expect(typeof inputCallback).toBe("function");

    // Simulate typing in the input widget
    inputCallback("<lora:Alpha:1.0>");

    expect(mergeLoras).toHaveBeenCalledWith("<lora:Alpha:1.0>", []);
    expect(node.lorasWidget.value).toEqual([{ name: "Alpha", active: true }]);
    expect(collectActiveLorasFromChain).toHaveBeenCalledWith(node);

    const activeSet = collectActiveLorasFromChain.mock.results.at(-1)?.value;
    const [[targetNode, triggerWordSet]] = updateConnectedTriggerWords.mock.calls;
    expect(targetNode).toBe(node);
    expect(triggerWordSet).toBe(activeSet);
    expect([...triggerWordSet]).toEqual(["Alpha"]);
  });

  it("creates a hidden, workflow-serialized Anima mode backing widget", async () => {
    await import(LORA_LOADER_MODULE);
    const extension = extensionState.current;
    const nodeType = { comfyClass: "Lora Loader (LoraManager)", prototype: {} };
    await extension.beforeRegisterNodeDef(nodeType, {}, {});

    const node = {
      comfyClass: "Lora Loader (LoraManager)",
      widgets: [
        { name: "text", value: "", options: {}, callback: null },
        { name: "loras", value: [], options: {}, callback: null },
      ],
      addInput: vi.fn(),
      addWidget(type, name, value, callback) {
        const widget = { type, name, value, callback, options: {} };
        this.widgets.push(widget);
        return widget;
      },
      graph: { setDirtyCanvas: vi.fn() },
    };

    nodeType.prototype.onNodeCreated.call(node);

    const animaModeWidget = node.widgets.find((widget) => widget.name === "anima_mode");
    expect(animaModeWidget).toBeDefined();
    expect(animaModeWidget.value).toBe(false);
    expect(animaModeWidget.hidden).toBe(true);
    expect(animaModeWidget.computeSize()).toEqual([0, 0]);

    animaModeWidget.callback(true);
    expect(node.animaMode).toBe(true);
    expect(node.properties.anima_mode).toBe(true);
    expect(node.graph.setDirtyCanvas).toHaveBeenCalledWith(true, true);
  });

  it("restores a saved Anima mode and defaults old workflows to disabled", async () => {
    await import(LORA_LOADER_MODULE);
    const extension = extensionState.current;
    const nodeType = { comfyClass: "Lora Loader (LoraManager)", prototype: {} };
    await extension.beforeRegisterNodeDef(nodeType, {}, {});

    const createNode = (widgetsValues) => {
      const node = {
        comfyClass: "Lora Loader (LoraManager)",
        widgets: [
          { name: "text", value: "", options: {}, callback: null },
          { name: "loras", value: [], options: {}, callback: null },
        ],
        widgets_values: widgetsValues,
        addInput: vi.fn(),
        addWidget(type, name, value, callback) {
          const widget = { type, name, value, callback, options: {} };
          this.widgets.push(widget);
          return widget;
        },
        graph: { setDirtyCanvas: vi.fn() },
      };
      nodeType.prototype.onNodeCreated.call(node);
      return node;
    };

    const restoredNode = createNode(["", [], true]);
    await extension.loadedGraphNode(restoredNode);
    expect(restoredNode.animaMode).toBe(true);

    const legacyNode = createNode(["", []]);
    await extension.loadedGraphNode(legacyNode);
    expect(legacyNode.animaMode).toBe(false);
  });
});
