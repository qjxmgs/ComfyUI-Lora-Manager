import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  APP_MODULE,
  API_MODULE,
  UTILS_MODULE,
  TRIGGER_TOGGLE_MODULE,
  TAGS_WIDGET_MODULE,
  STYLES_MODULE,
  appCanvas,
} = vi.hoisted(() => ({
  APP_MODULE: new URL("../../../scripts/app.js", import.meta.url).pathname,
  API_MODULE: new URL("../../../scripts/api.js", import.meta.url).pathname,
  UTILS_MODULE: new URL("../../../web/comfyui/utils.js", import.meta.url).pathname,
  TRIGGER_TOGGLE_MODULE: new URL("../../../web/comfyui/trigger_word_toggle.js", import.meta.url).pathname,
  TAGS_WIDGET_MODULE: new URL("../../../web/comfyui/tags_widget.js", import.meta.url).pathname,
  STYLES_MODULE: new URL("../../../web/comfyui/lm_styles_loader.js", import.meta.url).pathname,
  appCanvas: {
    emitBeforeChange: vi.fn(),
    emitAfterChange: vi.fn(),
  },
}));

const extensionState = { current: null };
const getNodeFromGraph = vi.fn();

vi.mock(APP_MODULE, () => ({
  app: {
    registerExtension: vi.fn((extension) => {
      extensionState.current = extension;
    }),
    canvas: appCanvas,
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
  getWidgetByName: (node, name) => node?.widgets?.find((widget) => widget?.name === name) || null,
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
      { name: "group_mode", value: groupMode },
      { name: "default_active", value: true },
      { name: "allow_strength_adjustment", value: false },
    ],
    originalMessageWidget: { value: "" },
    tagWidget: { value: [], allowStrengthAdjustment: false },
    applyTriggerHighlightState: vi.fn(),
  };
  getNodeFromGraph.mockReturnValue(node);
  return node;
}

function createLifecycleNodeType() {
  return class TriggerWordToggleNode {
    constructor() {
      this.comfyClass = "TriggerWord Toggle (LoraManager)";
      this.widgets = [
        { name: "group_mode", value: true },
        { name: "default_active", value: true },
        { name: "allow_strength_adjustment", value: false },
      ];
      this.widgets_values = [];
      this.properties = {};
      this.inputs = [];
      this.graph = {
        beforeChange: vi.fn(),
        afterChange: vi.fn(),
        incrementVersion: vi.fn(),
        change: vi.fn(),
        setDirtyCanvas: vi.fn(),
      };
      this.onWidgetChanged = vi.fn();
      this.setDirtyCanvas = vi.fn();
    }

    configure(info) {
      this.properties = { ...(info.properties || {}) };
      this.widgets_values = [...(info.widgets_values || [])];
      this.widgets.slice(0, 3).forEach((widget, index) => {
        if (index < this.widgets_values.length) {
          widget.value = this.widgets_values[index];
        }
      });
    }

    onSerialize(serialized) {
      serialized.properties = { ...(this.properties || {}) };
      serialized.widgets_values = [...this.widgets_values];
    }

    addInput(name, type, options) {
      this.inputs.push({ name, type, ...options });
    }

    addDOMWidget(name, type, element, options) {
      const widget = { name, type };
      Object.defineProperty(widget, "value", {
        get: options.getValue,
        set: options.setValue,
      });
      this.widgets.push(widget);
      this.tagContainer = element;
      document.body.appendChild(element);
      return widget;
    }

    addWidget(type, name, value) {
      const widget = { type, name, value };
      this.widgets.push(widget);
      return widget;
    }
  };
}

async function createLifecycleNode(extension, workflowInfo = null) {
  const NodeType = createLifecycleNodeType();
  extension.beforeRegisterNodeDef(NodeType, {
    name: "TriggerWord Toggle (LoraManager)",
  });
  const node = new NodeType();
  if (workflowInfo) {
    node.configure(workflowInfo);
  }
  await extension.nodeCreated(node);
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
    document.body.innerHTML = "";
    vi.stubGlobal("requestAnimationFrame", (callback) => {
      if (callback.name !== "tick") {
        callback();
      }
      return 1;
    });
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

  it("wraps every tag interaction in one graph change transaction", async () => {
    const node = await createLifecycleNode(extension);

    node.tagWidget.value = [
      {
        text: "group",
        active: true,
        items: [
          { text: "first", active: true },
          { text: "second", active: true },
        ],
      },
    ];
    node.graph.beforeChange.mockClear();
    node.graph.afterChange.mockClear();
    node.graph.incrementVersion.mockClear();
    node.graph.change.mockClear();
    node.onWidgetChanged.mockClear();
    node.setDirtyCanvas.mockClear();
    appCanvas.emitBeforeChange.mockClear();
    appCanvas.emitAfterChange.mockClear();

    node.tagContainer.querySelector(".comfy-tag").click();
    expect(node.tagWidget.value[0].active).toBe(false);
    const [, changedValue, previousValue] = node.onWidgetChanged.mock.calls[0];
    node.tagWidget.value = previousValue;
    expect(node.tagWidget.value[0].active).toBe(true);
    node.tagWidget.value = changedValue;
    expect(node.tagWidget.value[0].active).toBe(false);

    node.tagContainer.querySelector(".lm-trigger-group-edit-button").click();
    document.body.querySelector(".lm-trigger-group-editor .comfy-tag").click();
    expect(node.tagWidget.value[0].items[0].active).toBe(false);

    node.tagWidget.allowStrengthAdjustment = false;
    node.tagWidget.value = [{ text: "flat", active: true, strength: null }];
    node.tagContainer.querySelector(".comfy-tag").click();
    expect(node.tagWidget.value[0].active).toBe(false);

    node.tagWidget.allowStrengthAdjustment = true;
    node.tagWidget.value = [{ text: "weighted", active: true, strength: 1 }];
    node.tagContainer.querySelector(".comfy-tag").dispatchEvent(
      new WheelEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true })
    );
    expect(node.tagWidget.value[0].strength).toBeCloseTo(0.98);

    expect(node.graph.beforeChange).toHaveBeenCalledTimes(4);
    expect(node.graph.afterChange).toHaveBeenCalledTimes(4);
    expect(node.graph.incrementVersion).toHaveBeenCalledTimes(4);
    expect(node.graph.change).toHaveBeenCalledTimes(4);
    expect(appCanvas.emitBeforeChange).toHaveBeenCalledTimes(4);
    expect(appCanvas.emitAfterChange).toHaveBeenCalledTimes(4);
    expect(node.onWidgetChanged).toHaveBeenCalledTimes(4);
    expect(node.setDirtyCanvas).toHaveBeenCalledTimes(4);
    expect(node.onWidgetChanged).toHaveBeenLastCalledWith(
      "toggle_trigger_words",
      expect.any(Array),
      expect.any(Array),
      node.tagWidget
    );
  });

  it("persists group, item, and strength state through a workflow reload", async () => {
    const groups = [
      {
        source_lora: "Alpha.safetensors",
        text: "alpha, beta",
        occurrence: 0,
        available: true,
      },
    ];
    const node = await createLifecycleNode(extension);
    getNodeFromGraph.mockReturnValue(node);
    extension.handleTriggerWordUpdate(
      1,
      "root",
      "alpha, beta",
      detail(1, groups)
    );
    node.tagContainer.querySelector(".comfy-tag").click();
    node.tagWidget.value[0].items[1].active = false;
    node.tagWidget.value[0].strength = 0.65;

    const serialized = {};
    node.onSerialize(serialized);
    expect(serialized.properties.__lm_trigger_word_widget_ids).toEqual([
      "group_mode",
      "default_active",
      "allow_strength_adjustment",
      "toggle_trigger_words",
      "orinalMessage",
    ]);
    expect(serialized.widgets_values[3][0].active).toBe(false);
    expect(serialized.widgets_values[3][0].items[1].active).toBe(false);

    const restoredNode = await createLifecycleNode(
      extension,
      JSON.parse(JSON.stringify(serialized))
    );
    getNodeFromGraph.mockReturnValue(restoredNode);
    extension.handleTriggerWordUpdate(
      1,
      "root",
      "alpha, beta",
      detail(2, groups)
    );

    expect(restoredNode.tagWidget.value[0].active).toBe(false);
    expect(restoredNode.tagWidget.value[0].items[1].active).toBe(false);
    expect(restoredNode.tagWidget.value[0].strength).toBe(0.65);

    const unrelatedWorkflowNode = await createLifecycleNode(extension);
    getNodeFromGraph.mockReturnValue(unrelatedWorkflowNode);
    extension.handleTriggerWordUpdate(
      2,
      "root",
      "alpha, beta",
      detail(1, groups)
    );
    expect(unrelatedWorkflowNode.tagWidget.value[0].active).toBe(true);
    expect(unrelatedWorkflowNode.tagWidget.value[0].items.every((item) => item.active)).toBe(true);
  });

  it("does not create graph transactions for restore, responses, or highlights", async () => {
    const savedTags = [
      {
        text: "saved",
        active: false,
        items: [{ text: "saved", active: false }],
      },
    ];
    const node = await createLifecycleNode(extension, {
      properties: {
        __lm_trigger_word_widget_ids: [
          "group_mode",
          "default_active",
          "allow_strength_adjustment",
          "toggle_trigger_words",
          "orinalMessage",
        ],
      },
      widgets_values: [true, true, false, savedTags, "saved"],
    });
    getNodeFromGraph.mockReturnValue(node);
    extension.handleTriggerWordUpdate(
      1,
      "root",
      "saved",
      detail(1, [
        {
          source_lora: "Saved.safetensors",
          text: "saved",
          occurrence: 0,
          available: true,
        },
      ])
    );
    node.highlightTriggerWords(["saved"]);

    expect(node.graph.beforeChange).not.toHaveBeenCalled();
    expect(node.graph.afterChange).not.toHaveBeenCalled();
    expect(node.graph.incrementVersion).not.toHaveBeenCalled();
    expect(node.graph.change).not.toHaveBeenCalled();
    expect(appCanvas.emitBeforeChange).not.toHaveBeenCalled();
    expect(appCanvas.emitAfterChange).not.toHaveBeenCalled();
    expect(node.onWidgetChanged).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "legacy three-value",
      values: [false, [{ text: "three", active: false }], "three"],
      expected: [false, true, false, "three"],
    },
    {
      label: "legacy four-value",
      values: [true, false, [{ text: "four", active: false }], "four"],
      expected: [true, false, false, "four"],
    },
    {
      label: "current five-value",
      values: [false, false, true, [{ text: "five", active: false }], "five"],
      expected: [false, false, true, "five"],
    },
    {
      label: "misaligned five-value",
      values: [
        true,
        [{ text: "stale", active: true }],
        true,
        [{ text: "current", active: false }],
        "current",
      ],
      expected: [true, true, true, "current"],
    },
  ])("normalizes $label workflows", async ({ values, expected }) => {
    const NodeType = createLifecycleNodeType();
    extension.beforeRegisterNodeDef(NodeType, {
      name: "TriggerWord Toggle (LoraManager)",
    });
    const node = new NodeType();
    node.configure({ widgets_values: values, properties: {} });

    expect(node.widgets_values[0]).toBe(expected[0]);
    expect(node.widgets_values[1]).toBe(expected[1]);
    expect(node.widgets_values[2]).toBe(expected[2]);
    expect(node.widgets_values[3][0].text).toBe(expected[3]);
    expect(node.widgets_values[4]).toBe(expected[3]);
  });

  it("restores reordered values by their saved widget names", () => {
    const NodeType = createLifecycleNodeType();
    extension.beforeRegisterNodeDef(NodeType, {
      name: "TriggerWord Toggle (LoraManager)",
    });
    const node = new NodeType();
    node.configure({
      properties: {
        __lm_trigger_word_widget_ids: [
          "toggle_trigger_words",
          "orinalMessage",
          "allow_strength_adjustment",
          "default_active",
          "group_mode",
        ],
      },
      widgets_values: [
        [{ text: "named", active: false }],
        "named",
        true,
        false,
        false,
        [{ text: "trailing", active: true }],
        "trailing",
      ],
    });

    expect(node.widgets_values.slice(0, 3)).toEqual([false, false, true]);
    expect(node.widgets_values[3][0].active).toBe(false);
    expect(node.widgets_values[4]).toBe("named");
  });

  it("applies an early trigger response after the DOM widget is created", async () => {
    const animationFrames = [];
    vi.stubGlobal("requestAnimationFrame", (callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const NodeType = createLifecycleNodeType();
    extension.beforeRegisterNodeDef(NodeType, {
      name: "TriggerWord Toggle (LoraManager)",
    });
    const node = new NodeType();
    await extension.nodeCreated(node);
    getNodeFromGraph.mockReturnValue(node);

    extension.handleTriggerWordUpdate(
      1,
      "root",
      "early",
      detail(1, [
        {
          source_lora: "Early.safetensors",
          text: "early",
          occurrence: 0,
          available: true,
        },
      ])
    );
    expect(node.tagWidget).toBeUndefined();

    await animationFrames.shift()();
    expect(node.originalMessageWidget.value).toBe("early");
    expect(node.tagWidget.value.map((tag) => tag.text)).toEqual(["early"]);
    expect(node.graph.beforeChange).not.toHaveBeenCalled();
  });
});
