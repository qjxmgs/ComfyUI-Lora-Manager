import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  APP_MODULE,
  API_MODULE,
  UTILS_MODULE,
  TRIGGER_TOGGLE_MODULE,
  TAGS_WIDGET_MODULE,
  STYLES_MODULE,
} = vi.hoisted(() => ({
  APP_MODULE: new URL("../../../scripts/app.js", import.meta.url).pathname,
  API_MODULE: new URL("../../../scripts/api.js", import.meta.url).pathname,
  UTILS_MODULE: new URL("../../../web/comfyui/utils.js", import.meta.url).pathname,
  TRIGGER_TOGGLE_MODULE: new URL("../../../web/comfyui/trigger_word_toggle.js", import.meta.url).pathname,
  TAGS_WIDGET_MODULE: new URL("../../../web/comfyui/tags_widget.js", import.meta.url).pathname,
  STYLES_MODULE: new URL("../../../web/comfyui/lm_styles_loader.js", import.meta.url).pathname,
}));

const extensionState = { current: null };
const getNodeFromGraph = vi.fn();

vi.mock(APP_MODULE, () => ({
  app: {
    registerExtension: vi.fn((extension) => {
      extensionState.current = extension;
    }),
    canvas: {},
  },
}));

vi.mock(API_MODULE, () => ({
  api: {
    addEventListener: vi.fn(),
  },
}));

vi.mock(UTILS_MODULE, () => ({
  CONVERTED_TYPE: "converted-widget",
  getNodeFromGraph,
  forwardMiddleMouseToCanvas: vi.fn(),
  forwardWheelToCanvas: vi.fn(),
}));

vi.mock(STYLES_MODULE, () => ({
  ensureLmStyles: vi.fn(),
}));

function createToggleNode(groupMode = true) {
  const node = {
    comfyClass: "TriggerWord Toggle (LoraManager)",
    widgets: [
      { value: groupMode },
      { value: true },
      { value: false },
    ],
    originalMessageWidget: { value: "" },
    tagWidget: { value: [], allowStrengthAdjustment: false },
    applyTriggerHighlightState: vi.fn(),
  };
  getNodeFromGraph.mockReturnValue(node);
  return node;
}

function detail(revision, triggerGroups, message = "") {
  return {
    source_node: { node_id: 7, graph_id: "root" },
    request_revision: revision,
    trigger_groups: triggerGroups,
    message,
  };
}

describe("TriggerWord Toggle state preservation", () => {
  let extension;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    extensionState.current = null;
    await import(TRIGGER_TOGGLE_MODULE);
    extension = extensionState.current;
  });

  it("hides disabled LoRA groups and restores their exact group and item state", () => {
    const node = createToggleNode(true);
    const initialGroups = [
      {
        source_lora: "Alpha.safetensors",
        text: "alpha, shared",
        occurrence: 0,
        available: true,
      },
      {
        source_lora: "Beta.safetensors",
        text: "beta, shared",
        occurrence: 0,
        available: true,
      },
    ];

    extension.handleTriggerWordUpdate(1, "root", "alpha, shared,, beta, shared", detail(1, initialGroups));
    node.tagWidget.value[0].items[1].active = false;
    node.tagWidget.value[0].strength = 0.65;
    node.tagWidget.value[1].active = false;

    extension.handleTriggerWordUpdate(
      1,
      "root",
      "beta, shared",
      detail(2, [
        { ...initialGroups[1] },
        { ...initialGroups[0], available: false },
      ])
    );

    expect(node.tagWidget.value.map((tag) => tag.text)).toEqual([
      "alpha, shared",
      "beta, shared",
    ]);
    expect(node.tagWidget.value[0].available).toBe(false);
    expect(node.tagWidget.value[0].items[1].active).toBe(false);
    expect(node.tagWidget.value[0].strength).toBe(0.65);
    expect(node.tagWidget.value[1].active).toBe(false);

    const serializedWhileDisabled = JSON.parse(
      JSON.stringify(node.tagWidget.value)
    );
    const restoredNode = createToggleNode(true);
    restoredNode.tagWidget.value = serializedWhileDisabled;
    extension.handleTriggerWordUpdate(
      1,
      "root",
      "alpha, shared,, beta, shared",
      detail(1, initialGroups)
    );

    expect(restoredNode.tagWidget.value[0].available).toBe(true);
    expect(restoredNode.tagWidget.value[0].items[1].active).toBe(false);
    expect(restoredNode.tagWidget.value[0].strength).toBe(0.65);
    expect(restoredNode.tagWidget.value[1].active).toBe(false);
    getNodeFromGraph.mockReturnValue(node);

    extension.handleTriggerWordUpdate(
      1,
      "root",
      "alpha, shared,, beta, shared",
      detail(3, [initialGroups[1], initialGroups[0]])
    );

    expect(node.tagWidget.value[0].available).toBe(true);
    expect(node.tagWidget.value[0].items[1].active).toBe(false);
    expect(node.tagWidget.value[0].strength).toBe(0.65);
    expect(node.tagWidget.value[1].active).toBe(false);
  });

  it("keeps duplicate words from different LoRAs independently in flat mode", () => {
    const node = createToggleNode(false);
    const groups = [
      {
        source_lora: "Alpha.safetensors",
        text: "shared, alpha",
        occurrence: 0,
        available: true,
      },
      {
        source_lora: "Beta.safetensors",
        text: "shared, beta",
        occurrence: 0,
        available: true,
      },
    ];

    extension.handleTriggerWordUpdate(1, "root", "shared, alpha,, shared, beta", detail(1, groups));
    const sharedTags = node.tagWidget.value.filter((tag) => tag.text === "shared");
    expect(sharedTags).toHaveLength(2);
    expect(sharedTags[0].source_key).not.toBe(sharedTags[1].source_key);
    sharedTags[0].active = false;

    extension.handleTriggerWordUpdate(
      1,
      "root",
      "shared, beta",
      detail(2, [{ ...groups[0], available: false }, groups[1]])
    );
    extension.handleTriggerWordUpdate(1, "root", "shared, alpha,, shared, beta", detail(3, groups));

    const restoredSharedTags = node.tagWidget.value.filter((tag) => tag.text === "shared");
    expect(restoredSharedTags.map((tag) => tag.active)).toEqual([false, true]);
  });

  it("ignores a response older than the latest revision from the same source", () => {
    const node = createToggleNode(true);
    const newestGroups = [
      {
        source_lora: "Newest.safetensors",
        text: "newest",
        occurrence: 0,
        available: true,
      },
    ];

    extension.handleTriggerWordUpdate(1, "root", "newest", detail(2, newestGroups));
    extension.handleTriggerWordUpdate(
      1,
      "root",
      "stale",
      detail(1, [
        {
          source_lora: "Stale.safetensors",
          text: "stale",
          occurrence: 0,
          available: true,
        },
      ])
    );

    expect(node.originalMessageWidget.value).toBe("newest");
    expect(node.tagWidget.value.map((tag) => tag.text)).toEqual(["newest"]);
  });

  it("clears preserved entries when the trigger-word connection is removed", () => {
    const node = createToggleNode(true);
    node.__lmTriggerGroups = [{ text: "old" }];
    node.__lmTriggerWordRevisions = new Map([["source", 2]]);
    node.originalMessageWidget.value = "old";
    node.tagWidget.value = [{ text: "old", active: false }];

    extension.clearTriggerWordState(node);

    expect(node.__lmTriggerGroups).toEqual([]);
    expect(node.__lmTriggerWordRevisions.size).toBe(0);
    expect(node.originalMessageWidget.value).toBe("");
    expect(node.tagWidget.value).toEqual([]);
  });

  it("does not render unavailable serialized tags", async () => {
    const { addTagsWidget } = await import(TAGS_WIDGET_MODULE);
    let container;
    const node = {
      addDOMWidget(_name, _type, element, options) {
        container = element;
        const widget = {};
        Object.defineProperty(widget, "value", {
          get: options.getValue,
          set: options.setValue,
        });
        return widget;
      },
    };
    const { widget } = addTagsWidget(node, "toggle_trigger_words", {
      defaultVal: [],
    });

    widget.value = [
      { text: "hidden", active: false, available: false },
      { text: "visible", active: true, available: true },
    ];

    expect(container.querySelectorAll(".comfy-tag")).toHaveLength(1);
    expect(container.textContent).toContain("visible");
    expect(container.textContent).not.toContain("hidden");
  });
});
