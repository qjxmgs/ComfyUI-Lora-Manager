import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { CONVERTED_TYPE, getNodeFromGraph } from "./utils.js";
import { addTagsWidget } from "./tags_widget.js";
import { getWheelSensitivity } from "./settings.js";

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
      const groupModeWidget = node.widgets[0];
      const defaultActiveWidget = node.widgets[1];
      const strengthAdjustmentWidget = node.widgets[2];
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

      const tagWidgetIndex = node.widgets.indexOf(result.widget);
      const originalMessageWidgetIndex = node.widgets.indexOf(hiddenWidget);
      if (node.widgets_values && node.widgets_values.length > 0) {
        if (tagWidgetIndex >= 0) {
          const savedValue = node.widgets_values[tagWidgetIndex];
          if (savedValue) {
            result.widget.value = Array.isArray(savedValue) ? savedValue : [];
          }
        }
        if (originalMessageWidgetIndex >= 0) {
          const originalMessage = node.widgets_values[originalMessageWidgetIndex];
          if (originalMessage) {
            hiddenWidget.value = originalMessage;
          }
        }
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
      const groupMode = node.widgets[0] ? node.widgets[0].value : false;
      const allowStrengthAdjustment = Boolean(node.widgets[2]?.value);
      node.tagWidget.allowStrengthAdjustment = allowStrengthAdjustment;
      this.updateTagsBasedOnMode(
        node,
        message,
        groupMode,
        allowStrengthAdjustment,
        node.__lmTriggerGroups
      );
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
    const defaultActive = node.widgets[1] ? node.widgets[1].value : true;
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
