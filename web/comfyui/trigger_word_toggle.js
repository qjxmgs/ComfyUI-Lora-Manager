import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { CONVERTED_TYPE, getNodeFromGraph, getWidgetByName } from "./utils.js";
import { addTagsWidget } from "./tags_widget.js";
import { getWheelSensitivity } from "./settings.js";

const TRIGGER_WORD_WIDGET_IDS_PROPERTY = "__lm_trigger_word_widget_ids";
const TRIGGER_WORD_WIDGET_NAMES = [
  "group_mode",
  "default_active",
  "allow_strength_adjustment",
  "toggle_trigger_words",
  "orinalMessage",
];

function normalizeSavedTag(tag, defaultActive) {
  if (typeof tag === "string") {
    return {
      text: tag,
      active: defaultActive,
      highlighted: false,
      strength: null,
    };
  }

  if (!tag || typeof tag !== "object") {
    return null;
  }

  const normalized = {
    ...tag,
    active: typeof tag.active === "boolean" ? tag.active : defaultActive,
  };
  if (Array.isArray(tag.items)) {
    normalized.items = tag.items
      .map((item) => {
        if (typeof item === "string") {
          return {
            text: item,
            active: true,
            highlighted: false,
            strength: null,
          };
        }
        if (!item || typeof item !== "object") {
          return null;
        }
        return {
          ...item,
          active: typeof item.active === "boolean" ? item.active : true,
        };
      })
      .filter(Boolean);
  }
  return normalized;
}

function cloneSavedTags(tags, defaultActive) {
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags
    .map((tag) => normalizeSavedTag(tag, defaultActive))
    .filter(Boolean);
}

function getNamedSavedValue(values, widgetIds, name) {
  if (!Array.isArray(widgetIds)) {
    return undefined;
  }
  const index = widgetIds.lastIndexOf(name);
  return index >= 0 ? values[index] : undefined;
}

function normalizeTriggerWordWidgetValues(values, widgetIds = undefined) {
  const savedValues = Array.isArray(values) ? values : [];
  let tagIndex = -1;
  let messageIndex = -1;
  savedValues.forEach((value, index) => {
    if (Array.isArray(value)) {
      tagIndex = index;
    } else if (typeof value === "string") {
      messageIndex = index;
    }
  });

  const namedGroupMode = getNamedSavedValue(savedValues, widgetIds, "group_mode");
  const namedDefaultActive = getNamedSavedValue(savedValues, widgetIds, "default_active");
  const namedStrengthAdjustment = getNamedSavedValue(
    savedValues,
    widgetIds,
    "allow_strength_adjustment"
  );
  const namedTags = getNamedSavedValue(savedValues, widgetIds, "toggle_trigger_words");
  const namedOriginalMessage = getNamedSavedValue(savedValues, widgetIds, "orinalMessage");
  const hasCompleteNamedMapping = typeof namedGroupMode === "boolean" &&
    typeof namedDefaultActive === "boolean" &&
    typeof namedStrengthAdjustment === "boolean" &&
    Array.isArray(namedTags) &&
    typeof namedOriginalMessage === "string";

  const valuesBeforeTags = tagIndex >= 0 ? savedValues.slice(0, tagIndex) : savedValues;
  const firstBoolean = valuesBeforeTags.find((value) => typeof value === "boolean");
  let inferredDefaultActive = true;
  let inferredStrengthAdjustment = false;

  const hasUnexpectedValueBeforeTags = valuesBeforeTags.some(
    (value, index) => index > 0 && typeof value !== "boolean"
  );
  if (!hasUnexpectedValueBeforeTags) {
    if (typeof valuesBeforeTags[1] === "boolean") {
      inferredDefaultActive = valuesBeforeTags[1];
    }
    if (typeof valuesBeforeTags[2] === "boolean") {
      inferredStrengthAdjustment = valuesBeforeTags[2];
    }
  } else {
    const lastUnexpectedIndex = valuesBeforeTags.reduce(
      (lastIndex, value, index) => (typeof value === "boolean" ? lastIndex : index),
      -1
    );
    let trailingBoolean;
    for (let index = valuesBeforeTags.length - 1; index > lastUnexpectedIndex; index -= 1) {
      if (typeof valuesBeforeTags[index] === "boolean") {
        trailingBoolean = valuesBeforeTags[index];
        break;
      }
    }
    if (typeof trailingBoolean === "boolean") {
      inferredStrengthAdjustment = trailingBoolean;
    }
  }

  const groupMode = typeof namedGroupMode === "boolean"
    ? namedGroupMode
    : (typeof firstBoolean === "boolean" ? firstBoolean : true);
  const defaultActive = typeof namedDefaultActive === "boolean"
    ? namedDefaultActive
    : inferredDefaultActive;
  const allowStrengthAdjustment = typeof namedStrengthAdjustment === "boolean"
    ? namedStrengthAdjustment
    : inferredStrengthAdjustment;
  const savedTags = hasCompleteNamedMapping
    ? namedTags
    : (tagIndex >= 0 ? savedValues[tagIndex] : []);
  const tags = cloneSavedTags(savedTags, defaultActive);
  const originalMessage = hasCompleteNamedMapping
    ? namedOriginalMessage
    : (messageIndex >= 0 ? savedValues[messageIndex] : "");

  return [
    groupMode,
    defaultActive,
    allowStrengthAdjustment,
    tags,
    originalMessage,
  ];
}

function getSerializedTagValue(widget) {
  if (!widget) {
    return [];
  }
  const serialized = widget.serializeValue?.();
  return Array.isArray(serialized) ? serialized : (Array.isArray(widget.value) ? widget.value : []);
}

function buildCanonicalWidgetValues(node, serializedValues = undefined) {
  const fallback = normalizeTriggerWordWidgetValues(
    serializedValues ?? node.widgets_values,
    node.properties?.[TRIGGER_WORD_WIDGET_IDS_PROPERTY]
  );
  const groupModeWidget = getWidgetByName(node, "group_mode");
  const defaultActiveWidget = getWidgetByName(node, "default_active");
  const strengthAdjustmentWidget = getWidgetByName(node, "allow_strength_adjustment");
  const tagWidget = node.tagWidget || getWidgetByName(node, "toggle_trigger_words");
  const originalMessageWidget = node.originalMessageWidget || getWidgetByName(node, "orinalMessage");
  const pendingRestore = node.__lmPendingTriggerWordRestore;

  return [
    typeof groupModeWidget?.value === "boolean" ? groupModeWidget.value : fallback[0],
    typeof defaultActiveWidget?.value === "boolean" ? defaultActiveWidget.value : fallback[1],
    typeof strengthAdjustmentWidget?.value === "boolean"
      ? strengthAdjustmentWidget.value
      : fallback[2],
    cloneSavedTags(
      tagWidget ? getSerializedTagValue(tagWidget) : (pendingRestore?.tags ?? fallback[3]),
      typeof defaultActiveWidget?.value === "boolean" ? defaultActiveWidget.value : fallback[1]
    ),
    typeof originalMessageWidget?.value === "string"
      ? originalMessageWidget.value
      : (pendingRestore?.originalMessage ?? fallback[4]),
  ];
}

function normalizeTagText(text) {
  return typeof text === "string" ? text.trim().toLowerCase() : "";
}

function splitTopLevelCommas(text) {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  const parts = [];
  let current = "";
  let depth = 0;

  for (const char of text) {
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) {
    parts.push(trimmed);
  }

  return parts;
}

function isGroupTag(tag) {
  return Array.isArray(tag?.items);
}

function parseSerializedText(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  const strengthMatch = normalizedText.match(/^\((.+):([\d.]+)\)$/);
  if (!strengthMatch) {
    return {
      text: normalizedText,
      strength: null,
    };
  }

  const parsedStrength = Number(strengthMatch[2]);
  return {
    text: strengthMatch[1].trim(),
    strength: Number.isFinite(parsedStrength) ? parsedStrength : null,
  };
}

function cloneTag(tag) {
  if (!isGroupTag(tag)) {
    return { ...tag };
  }
  return {
    ...tag,
    items: tag.items.map((item) => ({ ...item })),
  };
}

function collectHighlightTokens(wordsArray) {
  const tokens = new Set();

  const addToken = (text) => {
    const normalized = normalizeTagText(text);
    if (normalized) {
      tokens.add(normalized);
    }
  };

  wordsArray.forEach((rawWord) => {
    if (typeof rawWord !== "string") {
      return;
    }

    addToken(rawWord);

    const groupParts = rawWord.split(/,{2,}/);
    groupParts.forEach((groupPart) => {
      addToken(groupPart);
      splitTopLevelCommas(groupPart).forEach(addToken);
    });

    splitTopLevelCommas(rawWord).forEach(addToken);
  });

  return tokens;
}

function buildLegacyTagState(existingTags, allowStrengthAdjustment) {
  return existingTags.reduce((acc, tag) => {
    const parsed = parseSerializedText(tag.text);
    const key = parsed.text;
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push({
      active: tag.active,
      strength:
        allowStrengthAdjustment
          ? (tag.strength !== undefined && tag.strength !== null ? tag.strength : parsed.strength)
          : null,
    });
    return acc;
  }, {});
}

function buildGroupState(existingTags, allowStrengthAdjustment) {
  return existingTags.reduce((acc, tag) => {
    const parsed = parseSerializedText(tag.text);
    const key = parsed.text;
    if (!acc[key]) {
      acc[key] = [];
    }

    const itemState = {};
    if (Array.isArray(tag.items)) {
      tag.items.forEach((item) => {
        const itemKey = item.text;
        if (!itemState[itemKey]) {
          itemState[itemKey] = [];
        }
        itemState[itemKey].push({
          active: item.active,
        });
      });
    } else {
      splitTopLevelCommas(tag.text).forEach((itemText) => {
        if (!itemState[itemText]) {
          itemState[itemText] = [];
        }
        itemState[itemText].push({
          active: tag.active,
        });
      });
    }

    acc[key].push({
      active: tag.active,
      strength:
        allowStrengthAdjustment
          ? (tag.strength !== undefined && tag.strength !== null ? tag.strength : parsed.strength)
          : null,
      itemState,
    });
    return acc;
  }, {});
}

function consumeQueuedState(stateMap, key) {
  const queue = stateMap[key];
  if (queue && queue.length > 0) {
    return queue.shift();
  }
  return null;
}

function buildGroupSourceKey(group) {
  const sourceLora = typeof group?.source_lora === "string" ? group.source_lora : "";
  const text = normalizeTagText(group?.text);
  const occurrence = Number.isInteger(group?.occurrence) ? group.occurrence : 0;
  return JSON.stringify([sourceLora, text, occurrence]);
}

function buildItemSourceKey(groupKey, text, occurrence) {
  return JSON.stringify([groupKey, normalizeTagText(text), occurrence]);
}

function buildSourceStateMap(tags) {
  const stateMap = new Map();
  tags.forEach((tag) => {
    if (typeof tag?.source_key === "string" && tag.source_key) {
      stateMap.set(tag.source_key, tag);
    }
  });
  return stateMap;
}

function preserveExistingOrder(tags, existingTags) {
  const existingPositions = new Map();
  existingTags.forEach((tag, index) => {
    if (typeof tag?.source_key === "string" && tag.source_key) {
      existingPositions.set(tag.source_key, index);
    }
  });

  return tags
    .map((tag, payloadIndex) => ({ tag, payloadIndex }))
    .sort((left, right) => {
      const leftPosition = existingPositions.get(left.tag.source_key);
      const rightPosition = existingPositions.get(right.tag.source_key);
      const leftKnown = leftPosition !== undefined;
      const rightKnown = rightPosition !== undefined;

      if (leftKnown && rightKnown) {
        return leftPosition - rightPosition;
      }
      if (leftKnown) {
        return -1;
      }
      if (rightKnown) {
        return 1;
      }
      return left.payloadIndex - right.payloadIndex;
    })
    .map(({ tag }) => tag);
}

function buildStructuredGroupTags(
  groups,
  existingTags,
  defaultActive,
  allowStrengthAdjustment
) {
  const existingBySource = buildSourceStateMap(existingTags);
  const legacyState = buildGroupState(existingTags, allowStrengthAdjustment);

  const tags = groups.map((group) => {
    const groupKey = buildGroupSourceKey(group);
    const exactExisting = existingBySource.get(groupKey);
    const fallbackExisting = exactExisting
      ? null
      : consumeQueuedState(legacyState, group.text);
    const savedGroup = exactExisting || fallbackExisting;
    const savedItems = Array.isArray(exactExisting?.items)
      ? exactExisting.items
      : [];
    const savedItemsBySource = buildSourceStateMap(savedItems);
    const fallbackItemState = fallbackExisting?.itemState || {};
    const itemOccurrences = new Map();

    const items = splitTopLevelCommas(group.text).map((itemText) => {
      const normalizedText = normalizeTagText(itemText);
      const occurrence = itemOccurrences.get(normalizedText) || 0;
      itemOccurrences.set(normalizedText, occurrence + 1);
      const itemKey = buildItemSourceKey(groupKey, itemText, occurrence);
      const savedItem = savedItemsBySource.get(itemKey) ||
        consumeQueuedState(fallbackItemState, itemText);

      return {
        text: itemText,
        active: savedItem ? savedItem.active : true,
        highlighted: false,
        strength: null,
        source_key: itemKey,
        available: group.available !== false,
      };
    });

    return {
      text: group.text,
      active: savedGroup ? savedGroup.active : defaultActive,
      highlighted: false,
      strength: savedGroup ? savedGroup.strength : null,
      items,
      source_key: groupKey,
      available: group.available !== false,
    };
  });

  return preserveExistingOrder(tags, existingTags);
}

function buildStructuredFlatTags(
  groups,
  existingTags,
  defaultActive,
  allowStrengthAdjustment
) {
  const existingBySource = buildSourceStateMap(existingTags);
  const legacyState = buildLegacyTagState(existingTags, allowStrengthAdjustment);
  const tags = [];

  groups.forEach((group) => {
    const groupKey = buildGroupSourceKey(group);
    const wordOccurrences = new Map();

    splitTopLevelCommas(group.text).forEach((word) => {
      const normalizedWord = normalizeTagText(word);
      const occurrence = wordOccurrences.get(normalizedWord) || 0;
      wordOccurrences.set(normalizedWord, occurrence + 1);
      const sourceKey = buildItemSourceKey(groupKey, word, occurrence);
      const existing = existingBySource.get(sourceKey) ||
        consumeQueuedState(legacyState, word);

      tags.push({
        text: word,
        active: existing ? existing.active : defaultActive,
        highlighted: false,
        strength: existing ? existing.strength : null,
        source_key: sourceKey,
        available: group.available !== false,
      });
    });
  });

  return preserveExistingOrder(tags, existingTags);
}

function getRevisionSourceKey(sourceNode) {
  if (!sourceNode) {
    return "__legacy__";
  }
  if (typeof sourceNode !== "object") {
    return String(sourceNode);
  }
  return JSON.stringify({
    graph_id: sourceNode.graph_id ?? null,
    node_id: sourceNode.node_id ?? null,
  });
}

app.registerExtension({
  name: "LoraManager.TriggerWordToggle",

  setup() {
    api.addEventListener("trigger_word_update", (event) => {
      const { id, graph_id: graphId, message } = event.detail;
      this.handleTriggerWordUpdate(id, graphId, message, event.detail);
    });
  },

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "TriggerWord Toggle (LoraManager)") {
      return;
    }

    const originalConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function(info, ...args) {
      const widgetIds = info?.properties?.[TRIGGER_WORD_WIDGET_IDS_PROPERTY];
      const canonicalValues = normalizeTriggerWordWidgetValues(info?.widgets_values, widgetIds);
      const normalizedInfo = {
        ...info,
        properties: {
          ...(info?.properties || {}),
          [TRIGGER_WORD_WIDGET_IDS_PROPERTY]: [...TRIGGER_WORD_WIDGET_NAMES],
        },
        widgets_values: canonicalValues,
      };

      this.__lmPendingTriggerWordRestore = {
        tags: cloneSavedTags(canonicalValues[3], canonicalValues[1]),
        originalMessage: canonicalValues[4],
      };

      const result = originalConfigure?.call(this, normalizedInfo, ...args);
      this.widgets_values = canonicalValues;
      this.properties = {
        ...(this.properties || {}),
        [TRIGGER_WORD_WIDGET_IDS_PROPERTY]: [...TRIGGER_WORD_WIDGET_NAMES],
      };

      const nativeWidgetNames = TRIGGER_WORD_WIDGET_NAMES.slice(0, 3);
      nativeWidgetNames.forEach((name, index) => {
        const widget = getWidgetByName(this, name);
        if (widget) {
          widget.value = canonicalValues[index];
        }
      });
      return result;
    };

    const originalOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function(serialized, ...args) {
      const result = originalOnSerialize?.call(this, serialized, ...args);
      serialized.properties = {
        ...(serialized.properties || {}),
        [TRIGGER_WORD_WIDGET_IDS_PROPERTY]: [...TRIGGER_WORD_WIDGET_NAMES],
      };
      serialized.widgets_values = buildCanonicalWidgetValues(this, serialized.widgets_values);
      this.properties = {
        ...(this.properties || {}),
        [TRIGGER_WORD_WIDGET_IDS_PROPERTY]: [...TRIGGER_WORD_WIDGET_NAMES],
      };
      this.widgets_values = serialized.widgets_values;
      return result;
    };
  },

  async nodeCreated(node) {
    if (node.comfyClass !== "TriggerWord Toggle (LoraManager)") {
      return;
    }

    node.serialize_widgets = true;
    node.addInput("trigger_words", "string", {
      shape: 7,
    });

    const originalOnConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = (...args) => {
      const result = originalOnConnectionsChange?.apply(node, args);
      const [type, index, connected] = args;
      const input = node.inputs?.[index];
      if (type === 1 && input?.name === "trigger_words" && !connected) {
        this.clearTriggerWordState(node);
      }
      return result;
    };

    requestAnimationFrame(async () => {
      const wheelSensitivity = getWheelSensitivity();
      const groupModeWidget = getWidgetByName(node, "group_mode");
      const defaultActiveWidget = getWidgetByName(node, "default_active");
      const strengthAdjustmentWidget = getWidgetByName(node, "allow_strength_adjustment");
      const initialStrengthAdjustment = Boolean(strengthAdjustmentWidget?.value);

      const result = addTagsWidget(node, "toggle_trigger_words", {
        defaultVal: [],
      }, null, wheelSensitivity, {
        allowStrengthAdjustment: initialStrengthAdjustment,
      });

      node.tagWidget = result.widget;
      node.tagWidget.allowStrengthAdjustment = initialStrengthAdjustment;

      const applyHighlightState = () => {
        if (!node.tagWidget) {
          return;
        }

        const highlightSet = node._highlightedTriggerWords || new Set();
        const updatedTags = (node.tagWidget.value || []).map((tag) => {
          if (Array.isArray(tag.items)) {
            const items = tag.items.map((item) => ({
              ...item,
              highlighted: highlightSet.size > 0 && highlightSet.has(normalizeTagText(item.text)),
            }));

            return {
              ...tag,
              items,
              highlighted:
                highlightSet.size > 0 &&
                (highlightSet.has(normalizeTagText(tag.text)) ||
                  items.some((item) => item.highlighted)),
            };
          }

          return {
            ...tag,
            highlighted: highlightSet.size > 0 && highlightSet.has(normalizeTagText(tag.text)),
          };
        });

        node.tagWidget.value = updatedTags;
      };

      node.highlightTriggerWords = (triggerWords) => {
        const wordsArray = Array.isArray(triggerWords)
          ? triggerWords
          : triggerWords
            ? [triggerWords]
            : [];
        node._highlightedTriggerWords = collectHighlightTokens(wordsArray);
        applyHighlightState();
      };

      if (node.__pendingHighlightWords !== undefined) {
        const pending = node.__pendingHighlightWords;
        delete node.__pendingHighlightWords;
        node.highlightTriggerWords(pending);
      }

      node.applyTriggerHighlightState = applyHighlightState;

      const hiddenWidget = node.addWidget("text", "orinalMessage", "");
      hiddenWidget.type = CONVERTED_TYPE;
      hiddenWidget.hidden = true;
      hiddenWidget.computeSize = () => [0, -4];
      node.originalMessageWidget = hiddenWidget;

      const normalizedValues = normalizeTriggerWordWidgetValues(
        node.widgets_values,
        node.properties?.[TRIGGER_WORD_WIDGET_IDS_PROPERTY]
      );
      const pendingRestore = node.__lmPendingTriggerWordRestore;
      const restoredTags = pendingRestore?.tags ?? normalizedValues[3];
      const restoredMessage = pendingRestore?.originalMessage ?? normalizedValues[4];
      result.widget.value = cloneSavedTags(restoredTags, defaultActiveWidget?.value ?? true);
      hiddenWidget.value = typeof restoredMessage === "string" ? restoredMessage : "";
      delete node.__lmPendingTriggerWordRestore;

      const pendingUpdate = node.__lmPendingTriggerWordUpdate;
      if (pendingUpdate) {
        delete node.__lmPendingTriggerWordUpdate;
        hiddenWidget.value = pendingUpdate.message;
        this.updateTagsBasedOnMode(
          node,
          pendingUpdate.message,
          groupModeWidget?.value ?? false,
          Boolean(strengthAdjustmentWidget?.value),
          pendingUpdate.triggerGroups
        );
      }

      requestAnimationFrame(() => node.applyTriggerHighlightState?.());

      groupModeWidget.callback = (value) => {
        node.tagWidget?.closeGroupEditor?.();
        if (node.originalMessageWidget?.value) {
          this.updateTagsBasedOnMode(
            node,
            node.originalMessageWidget.value,
            value,
            Boolean(strengthAdjustmentWidget?.value),
            node.__lmTriggerGroups
          );
        }
      };

      defaultActiveWidget.callback = (value) => {
        if (!node.tagWidget || !node.tagWidget.value) {
          return;
        }

        const groupMode = groupModeWidget?.value ?? false;

        const updatedTags = node.tagWidget.value.map((tag) => {
          if (!Array.isArray(tag.items)) {
            return {
              ...tag,
              active: value,
            };
          }

          // In group mode, default_active only controls the group-level switch.
          // Children's individual active states are managed exclusively via the group editor.
          if (groupMode) {
            return {
              ...tag,
              active: value,
            };
          }

          return {
            ...tag,
            active: value,
            items: tag.items.map((item) => ({
              ...item,
              active: value,
            })),
          };
        });
        node.tagWidget.value = updatedTags;
        node.applyTriggerHighlightState?.();
      };

      if (strengthAdjustmentWidget) {
        strengthAdjustmentWidget.callback = (value) => {
          const allowStrengthAdjustment = Boolean(value);
          if (node.tagWidget) {
            node.tagWidget.allowStrengthAdjustment = allowStrengthAdjustment;
            node.tagWidget.closeGroupEditor?.();
          }
          this.updateTagsBasedOnMode(
            node,
            node.originalMessageWidget?.value || "",
            groupModeWidget?.value ?? false,
            allowStrengthAdjustment,
            node.__lmTriggerGroups
          );
        };
      }

      result.widget.serializeValue = function() {
        const value = this.value || [];
        return value.map((tag) => {
          if (Array.isArray(tag.items)) {
            return {
              ...tag,
              text:
                tag.strength !== undefined && tag.strength !== null
                  ? `(${tag.text}:${tag.strength.toFixed(2)})`
                  : tag.text,
              items: tag.items.map((item) => ({ ...item })),
            };
          }

          if (tag.strength !== undefined && tag.strength !== null) {
            return {
              ...tag,
              text: `(${tag.text}:${tag.strength.toFixed(2)})`,
            };
          }

          return tag;
        });
      };
    });
  },

  clearTriggerWordState(node) {
    node.__lmTriggerGroups = [];
    node.__lmTriggerWordRevisions = new Map();
    delete node.__lmPendingTriggerWordRestore;
    delete node.__lmPendingTriggerWordUpdate;
    if (node.originalMessageWidget) {
      node.originalMessageWidget.value = "";
    }
    if (node.tagWidget) {
      node.tagWidget.value = [];
    }
  },

  handleTriggerWordUpdate(id, graphId, message, detail = {}) {
    const node = getNodeFromGraph(graphId, id);
    if (!node || node.comfyClass !== "TriggerWord Toggle (LoraManager)") {
      console.warn("Node not found or not a TriggerWordToggle:", id);
      return;
    }

    const hasRequestRevision = detail.request_revision !== null &&
      detail.request_revision !== undefined;
    const requestRevision = Number(detail.request_revision);
    if (hasRequestRevision && Number.isFinite(requestRevision)) {
      const sourceKey = getRevisionSourceKey(detail.source_node);
      node.__lmTriggerWordRevisions = node.__lmTriggerWordRevisions || new Map();
      const lastRevision = node.__lmTriggerWordRevisions.get(sourceKey);
      if (lastRevision !== undefined && requestRevision < lastRevision) {
        return;
      }
      node.__lmTriggerWordRevisions.set(sourceKey, requestRevision);
    }

    if (Array.isArray(detail.trigger_groups)) {
      node.__lmTriggerGroups = detail.trigger_groups.map((group) => ({ ...group }));
    }

    if (node.originalMessageWidget) {
      node.originalMessageWidget.value = message;
    }

    if (node.tagWidget) {
      const groupMode = getWidgetByName(node, "group_mode")?.value ?? false;
      const allowStrengthAdjustment = Boolean(
        getWidgetByName(node, "allow_strength_adjustment")?.value
      );
      node.tagWidget.allowStrengthAdjustment = allowStrengthAdjustment;
      this.updateTagsBasedOnMode(
        node,
        message,
        groupMode,
        allowStrengthAdjustment,
        node.__lmTriggerGroups
      );
    } else {
      node.__lmPendingTriggerWordUpdate = {
        message: typeof message === "string" ? message : "",
        triggerGroups: Array.isArray(node.__lmTriggerGroups)
          ? node.__lmTriggerGroups.map((group) => ({ ...group }))
          : undefined,
      };
    }
  },

  updateTagsBasedOnMode(
    node,
    message,
    groupMode,
    allowStrengthAdjustment = false,
    triggerGroups = undefined
  ) {
    if (!node.tagWidget) {
      return;
    }
    node.tagWidget.closeGroupEditor?.();
    node.tagWidget.allowStrengthAdjustment = allowStrengthAdjustment;

    const existingTags = (node.tagWidget.value || []).map(cloneTag);
    const defaultActive = getWidgetByName(node, "default_active")?.value ?? true;
    let tagArray = [];

    if (Array.isArray(triggerGroups)) {
      tagArray = groupMode
        ? buildStructuredGroupTags(
            triggerGroups,
            existingTags,
            defaultActive,
            allowStrengthAdjustment
          )
        : buildStructuredFlatTags(
            triggerGroups,
            existingTags,
            defaultActive,
            allowStrengthAdjustment
          );

      node.tagWidget.value = tagArray;
      node.applyTriggerHighlightState?.();
      return;
    }

    if (groupMode) {
      const existingGroupState = buildGroupState(existingTags, allowStrengthAdjustment);
      const groups = message.trim()
        ? (message.includes(",,") ? message.split(/,{2,}/) : [message])
            .map((group) => group.trim())
            .filter(Boolean)
        : [];

      tagArray = groups.map((group) => {
        const existing = consumeQueuedState(existingGroupState, group);
        const itemState = existing?.itemState || {};
        const items = splitTopLevelCommas(group).map((itemText) => {
          const savedItem = consumeQueuedState(itemState, itemText);
          return {
            text: itemText,
            active: savedItem ? savedItem.active : true,
            highlighted: false,
            strength: null,
          };
        });

        return {
          text: group,
          active: existing ? existing.active : defaultActive,
          highlighted: false,
          strength: existing ? existing.strength : null,
          items,
        };
      });
    } else {
      const existingTagState = buildLegacyTagState(existingTags, allowStrengthAdjustment);
      tagArray = splitTopLevelCommas(message).map((word) => {
        const existing = consumeQueuedState(existingTagState, word);
        return {
          text: word,
          active: existing ? existing.active : defaultActive,
          highlighted: false,
          strength: existing ? existing.strength : null,
        };
      });
    }

    node.tagWidget.value = tagArray;
    node.applyTriggerHighlightState?.();
  },
});
