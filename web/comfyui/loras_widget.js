import { app } from "../../scripts/app.js";
import { createToggle, createArrowButton, createDragHandle, updateEntrySelection, createExpandButton, updateExpandButtonState, createLockButton, updateLockButtonState } from "./loras_widget_components.js";
import { 
  parseLoraValue, 
  formatLoraValue, 
  shouldShowClipEntry, 
  syncClipStrengthIfCollapsed,
  getAvailableLoras,
  getAvailableLorasSync,
  getLoraStrengthRange,
  getLoraDisplayName,
  applyStrengthRangeCue,
  isLoraNameAvailable,
  onLibraryChanged
} from "./loras_widget_utils.js";
import { initDrag, createContextMenu, initHeaderDrag, initReorderDrag, handleKeyboardNavigation } from "./loras_widget_events.js";
import { forwardMiddleMouseToCanvas, forwardWheelToCanvas, enableListWheelScroll, updateDownstreamLoaders } from "./utils.js";
import { applySelectionHighlight } from "./trigger_word_highlight.js";
import { updateConnectedLoraInfoNodes } from "./lora_info.js";
import { PreviewTooltip } from "./preview_tooltip.js";
import { ensureLmStyles } from "./lm_styles_loader.js";
import { getStrengthStepPreference, getNodeLoraNameDisplayPreference, onNodeLoraNameDisplayChanged } from "./settings.js";
import { createLoraGroupsController } from "./lora_groups.js";

export function addLorasWidget(node, name, opts, callback) {
  ensureLmStyles();
  let groupsController = null;
  const grouped = node.comfyClass === 'Lora Loader (LoraManager)' || opts?.isAnimaModeNode === true;

  // Create container for loras — search for an empty container already
  // in the DOM first. During undo/redo in ComfyUI Vue render mode,
  // WidgetDOM.vue reuses its component without re-calling
  // mountWidgetElement(), so we must reuse the existing DOM element
  // instead of creating an orphaned replacement.
  let container = null;
  let reuseExisting = false;
  const existingContainers = document.querySelectorAll('.lm-loras-container');
  for (const el of existingContainers) {
    if (el.children.length === 0) {
      container = el;
      reuseExisting = true;
      break;
    }
  }

  if (!container) {
    container = document.createElement("div");
    container.className = "lm-widget-root lm-loras-container";
  }

  // Containers reused from a previous mount (undo/redo) may predate the
  // theme context class, so always make sure it is present.
  container.classList.add("lm-widget-root");
  container.classList.toggle('lm-loras-grouped', grouped);

  if (!reuseExisting) {
    forwardMiddleMouseToCanvas(container);
    forwardWheelToCanvas(container);
  }

  // Set initial height using CSS variables approach
  const defaultHeight = 200;

  // Set a fixed minimum height so the node has a reasonable starting size.
  // Adding or removing LoRAs does NOT change the node size — the container
  // scrolls when content exceeds the allocated space.
  container.style.setProperty('--comfy-widget-min-height', `${defaultHeight}px`);

  if (!reuseExisting && typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode) {
    container.classList.add('lm-vue-node');
    enableListWheelScroll(container);
  }

  // Check if this is a randomizer node (lock button instead of drag handle)
  const isRandomizerNode = opts?.isRandomizerNode === true;
  const isAnimaModeNode = opts?.isAnimaModeNode === true;

  // Initialize default value
  const defaultValue = opts?.defaultVal || [];
  const onSelectionChange = typeof opts?.onSelectionChange === "function"
    ? opts.onSelectionChange
    : null;

  // Create preview tooltip instance
  const previewTooltip = new PreviewTooltip({ modelType: "loras" });
  
  // Selection state - only one LoRA can be selected at a time
  let selectedLora = null;
  let selectedNames = new Set();
  let currentLorasData = parseLoraValue(defaultValue);
  let lastSelectionKey = "__none__";
  let pendingFocusTarget = null;

  const PREVIEW_SUPPRESSION_AFTER_DRAG_MS = 500;
  let strengthDragActive = false;
  let lastStrengthDragEndAt = 0;

  const shouldSuppressPreview = () => {
    if (strengthDragActive || widget.__dragActive) {
      return true;
    }
    return Date.now() - lastStrengthDragEndAt < PREVIEW_SUPPRESSION_AFTER_DRAG_MS;
  };

  const markStrengthDragStart = () => {
    groupsController?.beginStrengthEdit();
    strengthDragActive = true;
    previewTooltip.hide();
  };

  const markStrengthDragEnd = () => {
    strengthDragActive = false;
    lastStrengthDragEndAt = Date.now();
    previewTooltip.hide();
  };
  
  // Function to select a LoRA
  const buildSelectionPayload = (loraName) => {
    if (!loraName) {
      return null;
    }

    const entry = currentLorasData.find((lora) => lora.name === loraName);
    if (!entry) {
      return null;
    }

    return {
      name: entry.name,
      active: !!entry.active,
      entry: { ...entry },
    };
  };

  const emitSelectionChange = (payload, options = {}) => {
    if (!onSelectionChange) {
      return;
    }

    const key = payload
      ? `${payload.name || ""}|${payload.active ? "1" : "0"}`
      : "__null__";

    if (!options.force && key === lastSelectionKey) {
      return;
    }

    lastSelectionKey = key;
    onSelectionChange(payload);
  };

  const selectLora = (loraName, options = {}) => {
    selectedLora = loraName;
    if (grouped) selectedNames = new Set(options.names || (selectedNames.has(loraName) ? [...selectedNames] : loraName ? [loraName] : []));
    // Update visual feedback for all entries
    container.querySelectorAll('.lm-lora-entry').forEach(entry => {
      const entryLoraName = entry.dataset.loraName;
      updateEntrySelection(entry, grouped ? selectedNames.has(entryLoraName) : entryLoraName === selectedLora);
    });

    if (!options.silent) {
      emitSelectionChange(buildSelectionPayload(loraName));
    }
  };

  // Mirror ComfyUI's setNodeHasErrors: has_errors is not an auto-tracked
  // litegraph property, so the node:property:changed event must be fired
  // manually for the Vue renderer to pick up the error state.
  //
  // The flag is applied asynchronously (setTimeout 0): applying it during
  // LGraphNode.configure makes ComfyUI's errorNodeWidgets.onConfigure create
  // a fallback UNKNOWN widget for every widgets_values entry, because it
  // treats has_errors as "node definition missing".
  let pendingErrorFlag = null;
  let errorFlagTimer = null;

  const flushErrorFlag = () => {
    errorFlagTimer = null;
    const hasMissing = pendingErrorFlag;
    pendingErrorFlag = null;
    if (typeof hasMissing !== 'boolean') {
      return;
    }
    const oldValue = node.has_errors === true;
    if (oldValue === hasMissing) {
      return;
    }
    node.has_errors = hasMissing;
    if (node.graph) {
      node.graph.trigger('node:property:changed', {
        type: 'node:property:changed',
        nodeId: node.id,
        property: 'has_errors',
        oldValue,
        newValue: hasMissing
      });
      node.graph.setDirtyCanvas(true, true);
    }
  };

  const updateNodeErrorFlag = (hasMissing) => {
    pendingErrorFlag = hasMissing;
    if (errorFlagTimer === null) {
      errorFlagTimer = setTimeout(flushErrorFlag, 0);
    }
  };
  
  // Add keyboard event listener to container
  const handleContainerKeydown = (e) => {
    if (grouped ? groupsController?.keydown(e) : handleKeyboardNavigation(e, selectedLora, widget, renderLoras, selectLora)) {
      e.stopPropagation();
    }
  };
  container.addEventListener('keydown', handleContainerKeydown);
  
  // Make container focusable for keyboard events
  container.tabIndex = 0;
  
  // Function to render loras from data
  const renderLoras = (value, widget) => {
    groupsController?.beforeRender();
    // Clear existing content
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    // Parse the loras data
    const lorasData = parseLoraValue(value);
    currentLorasData = lorasData;
    const focusSequence = [];

    const updateWidgetValue = (newValue) => {
      if (groupsController) {
        groupsController.commit(newValue);
        return;
      }
      widget.value = newValue;

      if (typeof widget.callback === "function") {
        widget.callback(widget.value);
      }
    };

    const createFocusEntry = (loraName, type) => {
      const entry = { name: loraName, type };
      focusSequence.push(entry);
      return entry;
    };

    const findFocusEntryIndex = (entry) =>
      focusSequence.findIndex(
        (sequenceEntry) =>
          sequenceEntry?.name === entry?.name && sequenceEntry?.type === entry?.type
      );

    const getAdjacentFocusEntry = (currentEntry, direction) => {
      const currentIndex = findFocusEntryIndex(currentEntry);
      if (currentIndex === -1) {
        return null;
      }
      return focusSequence[currentIndex + direction] || null;
    };

    const queueFocusEntry = (entry) => {
      if (!entry) {
        return false;
      }
      pendingFocusTarget = { ...entry };
      return true;
    };

    const queueFocusAdjacentFrom = (currentEntry, direction) => {
      const targetEntry = getAdjacentFocusEntry(currentEntry, direction);
      return queueFocusEntry(targetEntry);
    };

    const escapeLoraName = (loraName) => {
      const css =
        (typeof window !== "undefined" && window.CSS) ||
        (typeof globalThis !== "undefined" && globalThis.CSS);
      if (css && typeof css.escape === "function") {
        return css.escape(loraName);
      }
      return loraName.replace(/"|\\/g, "\\$&");
    };

    if (lorasData.length === 0 && !grouped) {
      // Show message when no loras are added
      const emptyMessage = document.createElement("div");
      emptyMessage.textContent = "No LoRAs added";
      emptyMessage.className = "lm-lora-empty-state";
      container.appendChild(emptyMessage);
      updateNodeErrorFlag(false);
      return;
    }

    // Create header
    const header = document.createElement("div");
    header.className = "lm-loras-header";

    // Add toggle all control
    const allActive = lorasData.every(lora => lora.active);
    const toggleAll = createToggle(allActive, (active) => {
      // Update all loras active state
      const lorasData = parseLoraValue(widget.value);
      lorasData.forEach(lora => lora.active = active);
      
      const newValue = formatLoraValue(lorasData);
      updateWidgetValue(newValue);
    });

    // Add label to toggle all
    const toggleLabel = document.createElement("div");
    toggleLabel.textContent = "Toggle All";
    toggleLabel.className = "lm-toggle-label";

    const toggleContainer = document.createElement("div");
    toggleContainer.className = "lm-toggle-container";
    toggleContainer.appendChild(toggleAll);
    toggleContainer.appendChild(toggleLabel);

    let animaModeContainer = null;
    if (isAnimaModeNode) {
      const animaModeWidget = node._animaModeWidget ||
        node.widgets?.find((candidate) => candidate?.name === "anima_mode");
      const animaModeActive = animaModeWidget?.value === true ||
        animaModeWidget?.value === "true";
      const animaModeToggle = createToggle(animaModeActive, (active) => {
        const backingWidget = node._animaModeWidget ||
          node.widgets?.find((candidate) => candidate?.name === "anima_mode");
        if (!backingWidget) {
          return;
        }
        backingWidget.value = active;
        if (typeof backingWidget.callback === "function") {
          backingWidget.callback(active);
        } else {
          node.properties = node.properties || {};
          node.properties.anima_mode = active;
          node.graph?.setDirtyCanvas?.(true, true);
          renderLoras(widget.value, widget);
        }
      });

      const animaModeLabel = document.createElement("div");
      animaModeLabel.textContent = "Anima 2.9B 模式";
      animaModeLabel.className = "lm-toggle-label";

      animaModeContainer = document.createElement("div");
      animaModeContainer.className = "lm-toggle-container lm-anima-mode-container";
      animaModeContainer.title = "在 40 层 Anima 2.9B 模型上以内存方式加载旧版 28 层 Anima LoRA";
      animaModeContainer.appendChild(animaModeToggle);
      animaModeContainer.appendChild(animaModeLabel);
    }

    // Strength label with drag hint
    const strengthLabel = document.createElement("div");
    strengthLabel.textContent = "Strength";
    strengthLabel.className = "lm-strength-label";

    // Add drag hint icon next to strength label
    const dragHint = document.createElement("span");
    dragHint.innerHTML = "↔"; // Simple left-right arrow as drag indicator
    dragHint.className = "lm-drag-hint";
    strengthLabel.appendChild(dragHint);

    if (groupsController) {
      groupsController.render(animaModeContainer);
    } else {
      header.appendChild(toggleContainer);
      if (animaModeContainer) header.appendChild(animaModeContainer);
      header.appendChild(strengthLabel);
      container.appendChild(header);
      initHeaderDrag(header, widget, renderLoras);
    }

    // Render each lora entry
    const availableSet = getAvailableLorasSync();
    if (!availableSet) {
      // Availability data missing (workflow switch without node recreation,
      // cache expiry): fetch it and re-render once it lands so missing cues
      // and the node flag always resolve. Only re-render on success to avoid
      // retry loops on failure.
      getAvailableLoras().then((set) => {
        if (set && !widget.__dragActive && container.isConnected) {
          renderLoras(widget.value, widget);
        }
      });
    }
    lorasData.forEach((loraData) => {
      const { name, strength, clipStrength, active } = loraData;
      const listContainer = groupsController?.body(loraData.groupId) || container;
      const missing = !isLoraNameAvailable(name, availableSet);
      
      // Determine expansion state using our helper function
      const isExpanded = shouldShowClipEntry(loraData);
      const strengthFocusEntry = createFocusEntry(name, "strength");
      
      // Create the main LoRA entry
      const loraEl = document.createElement("div");
      loraEl.className = "lm-lora-entry";

      // Store lora name, active state, and locked state in dataset
      loraEl.dataset.loraName = name;
      loraEl.dataset.active = active ? "true" : "false";
      loraEl.dataset.locked = (loraData.locked || false) ? "true" : "false";

      if (missing) {
        loraEl.setAttribute("data-missing", "true");
      }

      // Add click handler for selection
      loraEl.addEventListener('click', (e) => {
        // Skip if clicking on interactive elements
        if (e.target.closest('.lm-lora-toggle') ||
            e.target.closest('input') ||
            e.target.closest('.lm-lora-arrow') ||
            e.target.closest('.lm-lora-drag-handle') ||
            e.target.closest('.lm-lora-lock-button') ||
            e.target.closest('.lm-lora-expand-button')) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        if (groupsController) groupsController.selectItem(name, e);
        else selectLora(name === selectedLora ? null : name);
        container.focus();
      });

      if (groupsController) {
        loraEl.addEventListener('dblclick', event => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey ||
              event.target.closest('button,input,select,textarea,a,.lm-lora-toggle,.lm-lora-arrow')) return;
          event.preventDefault(); event.stopPropagation();
          const entry = widget.value.find(item => item.name === name);
          const group = groupsController.config().groups.find(item => item.id === entry?.groupId);
          if (entry && group?.enabled) groupsController.setActive(name, !entry.active);
        });
      }

      // Conditionally create drag handle OR lock button
      let dragHandleOrLockButton;

      if (isRandomizerNode) {
        // For randomizer node, show lock button instead of drag handle
        const isLocked = loraData.locked || false;
        dragHandleOrLockButton = createLockButton(isLocked, (newLocked) => {
          // Update this lora's locked state
          const lorasData = parseLoraValue(widget.value);
          const loraIndex = lorasData.findIndex(l => l.name === name);

          if (loraIndex >= 0) {
            lorasData[loraIndex].locked = newLocked;
            const newValue = formatLoraValue(lorasData);
            updateWidgetValue(newValue);
          }
        });
      } else if (!groupsController) {
        // Ungrouped nodes retain their dedicated drag handle.
        dragHandleOrLockButton = createDragHandle();
        // Initialize reorder drag functionality
        initReorderDrag(dragHandleOrLockButton, name, widget, renderLoras);
      }

      // Create toggle for this lora
      const toggle = createToggle(active, (newActive) => {
        if (groupsController) {
          groupsController.setActive(name, newActive);
          return;
        }
        // Update this lora's active state
        const lorasData = parseLoraValue(widget.value);
        const loraIndex = lorasData.findIndex(l => l.name === name);
        
        if (loraIndex >= 0) {
          lorasData[loraIndex].active = newActive;
          
          if (selectedLora === name) {
            emitSelectionChange({
              name,
              active: newActive,
              entry: { ...lorasData[loraIndex] },
            });
          }

          const newValue = formatLoraValue(lorasData);
          updateWidgetValue(newValue);
        }
      });

      if (groupsController) {
        toggle.classList.toggle('lm-lora-radio', groupsController.isSingle(loraData.groupId));
        toggle.setAttribute('role', 'checkbox');
        toggle.setAttribute('aria-checked', String(!!active));
        toggle.setAttribute('aria-label', name);
        toggle.tabIndex = 0;
        toggle.addEventListener('keydown', event => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation();
            groupsController.setActive(name, !active);
          }
        });
      }

      // Create expand button
      const expandButton = createExpandButton(isExpanded, (shouldExpand) => {
        // Toggle the clip entry expanded state
        const lorasData = parseLoraValue(widget.value);
        const loraIndex = lorasData.findIndex(l => l.name === name);
        
        if (loraIndex >= 0) {
          // Set the expansion state
          lorasData[loraIndex].expanded = shouldExpand;
          
          // If collapsing, set clipStrength = strength
          if (!shouldExpand) {
            lorasData[loraIndex].clipStrength = lorasData[loraIndex].strength;
          } 
          
          // Update the widget value
          updateWidgetValue(formatLoraValue(lorasData));

          // Re-render to show/hide clip entry
          renderLoras(widget.value, widget);
        }
      });

      // Create name display. The row is labelled with the library model name
      // when ComfyUI's node label setting asks for it (read at render time, so
      // the setting needs no caching); the stored LoRA name (the file name)
      // stays in the dataset and the value, and the hover preview tooltip keeps
      // showing it.
      const displayName = getLoraDisplayName(name, getNodeLoraNameDisplayPreference());
      const nameEl = document.createElement("div");
      nameEl.textContent = displayName;
      nameEl.className = "lm-lora-name";
      if (groupsController) {
        // Split the label into flexible prefix and preserved suffix. CSS
        // truncates the prefix first, keeping training steps recognizable.
        const file = name.replace(/\.(safetensors|ckpt|pt|bin)$/i, '');
        const suffix = file.match(/(?:[_ -](?:step|epoch)[_ -]?\d+|[_ -]\d{3,})$/i)?.[0];
        const label = suffix && !displayName.includes(suffix) ? `${displayName}${suffix}` : displayName.replace(/\.(safetensors|ckpt|pt|bin)$/i, '');
        const keep = suffix || label.slice(-Math.min(12, Math.ceil(label.length / 3)));
        const prefix = document.createElement('span');
        prefix.className = 'lm-lora-name-prefix';
        prefix.textContent = label.slice(0, label.length - keep.length);
        const tail = document.createElement('span');
        tail.className = 'lm-lora-name-suffix';
        tail.textContent = keep;
        nameEl.replaceChildren(prefix, tail);
        nameEl.setAttribute('aria-label', displayName === name ? name : `${displayName}\n${name}`);
      }
      if (displayName !== name) {
        nameEl.dataset.loraFileName = name;
      }
      if (missing) {
        nameEl.title = "LoRA not found in local library";
      }

      // Move preview tooltip events to nameEl instead of loraEl
      let previewTimer = null; // Timer for delayed preview

      const clearPreviewTimer = () => {
        if (previewTimer) {
          clearTimeout(previewTimer);
          previewTimer = null;
        }
      };

      nameEl.addEventListener('mouseenter', (e) => {
        e.stopPropagation();
        // Missing LoRAs have no preview data — skip the placeholder tooltip.
        if (missing || shouldSuppressPreview()) {
          return;
        }
        previewTimer = setTimeout(async () => {
          previewTimer = null;
          if (shouldSuppressPreview()) {
            return;
          }
          const rect = nameEl.getBoundingClientRect();
          await previewTooltip.show(name, rect.right, rect.top);
        }, 400); // 400ms delay
      });

      nameEl.addEventListener('mouseleave', (e) => {
        e.stopPropagation();
        clearPreviewTimer(); // Cancel if not triggered
        previewTooltip.hide();
      });
      
      // Initialize drag functionality for strength adjustment
      if (groupsController) {
        groupsController.bindDrag(nameEl, name);
        nameEl.addEventListener('pointerdown', () => { clearPreviewTimer(); previewTooltip.hide(); });
      } else initDrag(loraEl, name, widget, false, previewTooltip, renderLoras, {
        onDragStart: () => {
          clearPreviewTimer();
          markStrengthDragStart();
        },
        onDragEnd: () => {
          clearPreviewTimer();
          markStrengthDragEnd();
        },
        onDragCommit: () => groupsController?.endStrengthEdit(),
      });

      // Add context menu event
      loraEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        createContextMenu(e.clientX, e.clientY, name, widget, previewTooltip, renderLoras, groupsController);
      });

      // Create strength control
      const strengthControl = document.createElement("div");
      strengthControl.className = "lm-lora-strength-control";

      // Left arrow
      const leftArrow = createArrowButton("left", () => {
        // Decrease strength
        const lorasData = parseLoraValue(widget.value);
        const loraIndex = lorasData.findIndex(l => l.name === name);
        
        if (loraIndex >= 0) {
          lorasData[loraIndex].strength = (parseFloat(lorasData[loraIndex].strength) - getStrengthStepPreference()).toFixed(2);
          // Sync clipStrength if collapsed
          syncClipStrengthIfCollapsed(lorasData[loraIndex]);
          
          const newValue = formatLoraValue(lorasData);
          updateWidgetValue(newValue);
        }
      });

      // Strength display
      const strengthEl = document.createElement("input");
      strengthEl.classList.add("lm-lora-strength-input");
      strengthEl.type = "text";
      strengthEl.value = typeof strength === 'number' ? strength.toFixed(2) : Number(strength).toFixed(2);
      applyStrengthRangeCue(strengthEl, strength, getLoraStrengthRange(name));
      strengthEl.addEventListener('pointerdown', () => {
        pendingFocusTarget = { name, type: "strength" };
      });

        // Handle focus
        strengthEl.addEventListener('focus', () => {
          pendingFocusTarget = null;
          // Auto-select all content
          strengthEl.select();
          selectLora(name);
        });

      // Handle input changes
      const commitStrengthValue = () => {
        let parsedValue = parseFloat(strengthEl.value);
        if (isNaN(parsedValue)) {
          parsedValue = 1.0;
        }
        const normalizedValue = parsedValue.toFixed(2);

        const currentLoras = parseLoraValue(widget.value);
        const loraIndex = currentLoras.findIndex(l => l.name === name);

        if (loraIndex >= 0) {
          currentLoras[loraIndex].strength = normalizedValue;
          // Sync clipStrength if collapsed
          syncClipStrengthIfCollapsed(currentLoras[loraIndex]);

          strengthEl.value = normalizedValue;
          const newLorasValue = formatLoraValue(currentLoras);
          updateWidgetValue(newLorasValue);
        } else {
          strengthEl.value = normalizedValue;
        }
      };

      strengthEl.addEventListener('change', commitStrengthValue);

      // Handle key events
      strengthEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          strengthEl.blur();
        } else if (e.key === 'Tab') {
          const moved = queueFocusAdjacentFrom(strengthFocusEntry, e.shiftKey ? -1 : 1);
          commitStrengthValue();
          if (moved) {
            e.preventDefault();
          }
        }
      });

      // Right arrow
      const rightArrow = createArrowButton("right", () => {
        // Increase strength
        const lorasData = parseLoraValue(widget.value);
        const loraIndex = lorasData.findIndex(l => l.name === name);
        
        if (loraIndex >= 0) {
          lorasData[loraIndex].strength = (parseFloat(lorasData[loraIndex].strength) + getStrengthStepPreference()).toFixed(2);
          // Sync clipStrength if collapsed
          syncClipStrengthIfCollapsed(lorasData[loraIndex]);
          
          const newValue = formatLoraValue(lorasData);
          updateWidgetValue(newValue);
        }
      });

      strengthControl.appendChild(leftArrow);
      strengthControl.appendChild(strengthEl);
      strengthControl.appendChild(rightArrow);

      // Assemble entry
      const leftSection = document.createElement("div");
      leftSection.className = "lm-lora-entry-left";

      if (dragHandleOrLockButton) leftSection.appendChild(dragHandleOrLockButton);
      leftSection.appendChild(toggle);
      leftSection.appendChild(expandButton); // Add expand button
      leftSection.appendChild(nameEl);
      
      loraEl.appendChild(leftSection);
      loraEl.appendChild(strengthControl);

      listContainer.appendChild(loraEl);

      // If expanded, show the clip entry
      if (isExpanded) {
        const clipEl = document.createElement("div");
        clipEl.className = "lm-lora-clip-entry";

        // Store the same lora name in clip entry dataset
        clipEl.dataset.loraName = name;
        clipEl.dataset.active = active ? "true" : "false";

        if (missing) {
          clipEl.setAttribute("data-missing", "true");
        }

        // Create clip name display
        const clipNameEl = document.createElement("div");
        clipNameEl.textContent = "[clip] " + displayName;
        clipNameEl.className = "lm-lora-name";
        if (missing) {
          clipNameEl.title = "LoRA not found in local library";
        }

        // Create clip strength control
        const clipStrengthControl = document.createElement("div");
        clipStrengthControl.className = "lm-lora-strength-control";

        // Left arrow for clip
        const clipLeftArrow = createArrowButton("left", () => {
          // Decrease clip strength
          const lorasData = parseLoraValue(widget.value);
          const loraIndex = lorasData.findIndex(l => l.name === name);
          
          if (loraIndex >= 0) {
            lorasData[loraIndex].clipStrength = (parseFloat(lorasData[loraIndex].clipStrength) - getStrengthStepPreference()).toFixed(2);
            
            const newValue = formatLoraValue(lorasData);
            updateWidgetValue(newValue);
          }
        });

        // Clip strength display
        const clipStrengthEl = document.createElement("input");
        clipStrengthEl.classList.add("lm-lora-strength-input", "lm-lora-clip-strength-input");
        clipStrengthEl.type = "text";
        clipStrengthEl.value = typeof clipStrength === 'number' ? clipStrength.toFixed(2) : Number(clipStrength).toFixed(2);
        applyStrengthRangeCue(clipStrengthEl, clipStrength, getLoraStrengthRange(name));
        clipStrengthEl.addEventListener('pointerdown', () => {
          pendingFocusTarget = { name, type: "clip" };
        });

        // Handle focus
        clipStrengthEl.addEventListener('focus', () => {
          pendingFocusTarget = null;
          // Auto-select all content
          clipStrengthEl.select();
          selectLora(name);
        });

        // Handle input changes
        const clipFocusEntry = createFocusEntry(name, "clip");

        const commitClipStrengthValue = () => {
          let parsedValue = parseFloat(clipStrengthEl.value);
          if (isNaN(parsedValue)) {
            parsedValue = 1.0;
          }
          const normalizedValue = parsedValue.toFixed(2);

          const currentLoras = parseLoraValue(widget.value);
          const loraIndex = currentLoras.findIndex(l => l.name === name);

          if (loraIndex >= 0) {
            currentLoras[loraIndex].clipStrength = normalizedValue;
            clipStrengthEl.value = normalizedValue;

            const newLorasValue = formatLoraValue(currentLoras);
            updateWidgetValue(newLorasValue);
          } else {
            clipStrengthEl.value = normalizedValue;
          }
        };

        clipStrengthEl.addEventListener('change', commitClipStrengthValue);

        // Handle key events
        clipStrengthEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            clipStrengthEl.blur();
          } else if (e.key === 'Tab') {
            const moved = queueFocusAdjacentFrom(clipFocusEntry, e.shiftKey ? -1 : 1);
            commitClipStrengthValue();
            if (moved) {
              e.preventDefault();
            }
          }
        });

        // Right arrow for clip
        const clipRightArrow = createArrowButton("right", () => {
          // Increase clip strength
          const lorasData = parseLoraValue(widget.value);
          const loraIndex = lorasData.findIndex(l => l.name === name);
          
          if (loraIndex >= 0) {
            lorasData[loraIndex].clipStrength = (parseFloat(lorasData[loraIndex].clipStrength) + getStrengthStepPreference()).toFixed(2);
            
            const newValue = formatLoraValue(lorasData);
            updateWidgetValue(newValue);
          }
        });

        clipStrengthControl.appendChild(clipLeftArrow);
        clipStrengthControl.appendChild(clipStrengthEl);
        clipStrengthControl.appendChild(clipRightArrow);

        // Assemble clip entry
        const clipLeftSection = document.createElement("div");
        clipLeftSection.className = "lm-lora-entry-left";

        clipLeftSection.appendChild(clipNameEl);

        clipEl.appendChild(clipLeftSection);
        clipEl.appendChild(clipStrengthControl);

        // Add drag functionality to clip entry
        if (groupsController) groupsController.bindDrag(clipNameEl, name);
        else initDrag(clipEl, name, widget, true, previewTooltip, renderLoras, {
          onDragStart: markStrengthDragStart,
          onDragEnd: markStrengthDragEnd,
          onDragCommit: () => groupsController?.endStrengthEdit(),
        });

        listContainer.appendChild(clipEl);
      }
    });
    groupsController?.afterRender();
    
    // After all LoRA elements are created, apply selection state as the last step
    // This ensures the selection state is not overwritten
    container.querySelectorAll('.lm-lora-entry').forEach(entry => {
      const entryLoraName = entry.dataset.loraName;
      updateEntrySelection(entry, grouped ? selectedNames.has(entryLoraName) : entryLoraName === selectedLora);
    });

    // Flag the node when any active entry references a LoRA missing locally.
    // Skipped while the availability set is not loaded (null) to avoid
    // clearing or setting the flag based on incomplete information.
    const hasMissingActive = availableSet
      ? lorasData.some(
          (lora) => lora.active && !isLoraNameAvailable(lora.name, availableSet)
        )
      : null;
    updateNodeErrorFlag(hasMissingActive);

    const selectionExists = selectedLora
      ? currentLorasData.some((lora) => lora.name === selectedLora)
      : false;

    if (selectedLora && !selectionExists) {
      selectLora(grouped ? [...selectedNames][0] || null : null, { names: [...selectedNames] });
    } else if (selectedLora) {
      emitSelectionChange(buildSelectionPayload(selectedLora));
    }

    if (pendingFocusTarget) {
      const focusTarget = pendingFocusTarget;
      const safeName = escapeLoraName(focusTarget.name);
      let selector = "";

      if (focusTarget.type === "strength") {
        selector = `.lm-lora-entry[data-lora-name="${safeName}"] .lm-lora-strength-input`;
      } else if (focusTarget.type === "clip") {
        selector = `.lm-lora-clip-entry[data-lora-name="${safeName}"] .lm-lora-clip-strength-input`;
      }

      if (selector) {
        const targetInput = container.querySelector(selector);
        if (targetInput) {
          requestAnimationFrame(() => {
            targetInput.focus();
            if (typeof targetInput.select === "function") {
              targetInput.select();
            }
            selectLora(focusTarget.name, { silent: true });
          });
        }
      }

      pendingFocusTarget = null;
    }
  };

  // Store the value in a variable to avoid recursion
  let widgetValue = defaultValue;

  // Create widget with new DOM Widget API
  const widget = node.addDOMWidget(name, "custom", container, {
    getValue: function() {
      return widgetValue.map(lora => {
        const entry = { ...lora };
        entry.selected = grouped ? selectedNames.has(lora.name) : lora.name === selectedLora;
        return entry;
      });
    },
    setValue: function(v) {
      // Ensure v is an array; handle falsy, string, or object values safely
      v = Array.isArray(v) ? v : [];
      // Remove duplicates by keeping the last occurrence of each lora name
      const uniqueValue = v.reduce((acc, lora) => {
        // Remove any existing lora with the same name
        const filtered = acc.filter(l => l.name !== lora.name);
        // Add the current lora
        return [...filtered, lora];
      }, []);
      
      // Apply existing clip strength values and transfer them to the new value
      const updatedValue = uniqueValue.map(lora => {
        // For new loras, default clip strength to model strength and expanded to false
        // unless clipStrength is already different from strength
        const clipStrength = lora.clipStrength ?? lora.strength;
        return {
          ...lora,
          clipStrength: clipStrength,
          expanded: lora.hasOwnProperty('expanded') ?
                    lora.expanded :
                    Number(clipStrength) !== Number(lora.strength),
          locked: lora.hasOwnProperty('locked') ? lora.locked : false  // Initialize locked to false if not present
        };
      });

      widgetValue = groupsController ? groupsController.normalize(updatedValue) : updatedValue;
      if (grouped) {
        const existing = new Set(widgetValue.map(entry => entry.name));
        selectedNames = new Set([...selectedNames].filter(name => existing.has(name)));
        if (!selectedLora && !selectedNames.size) {
          selectedNames = new Set(updatedValue.filter(entry => entry.selected).map(entry => entry.name));
        }
      }

      // Restore selection state when loading a saved workflow
      if (!selectedLora) {
        const selectedEntry = updatedValue.find(lora => lora.selected);
        if (selectedEntry) {
          selectedLora = selectedEntry.name;
        }
      }

      // Skip DOM re-render during drag to preserve pointer capture and event listeners.
      // The strength inputs are updated directly via the pointermove handler instead.
      if (!widget.__dragActive) {
        renderLoras(widgetValue, widget);
      }
    },
    hideOnZoom: true,
    selectOn: ['click', 'focus'],
    // Keep this DOM widget out of the right-side Properties Panel: the panel
    // falls back to WidgetLegacy for unknown widget types and writes
    // widget.width, which squashes the canvas overlay (frontend #11574).
    hideInPanel: true
  });

  if (grouped) {
    groupsController = createLoraGroupsController({ node, container, widget, getSelected: () => selectedLora, getSelection: () => [...selectedNames], select: selectLora });
    const oldConfigure = node.onConfigure;
    node.onConfigure = function (data) {
      const result = oldConfigure?.apply(this, arguments);
      groupsController.restore();
      selectedLora = null;
      selectedNames.clear();
      const index = node.widgets?.indexOf(widget) ?? -1;
      const restored = data?.widgets_values?.[index];
      widget.value = Array.isArray(restored) ? restored : widget.value;
      widget.callback?.(widget.value);
      node._lmFlushLoraText?.();
      return result;
    };
  }
  widget.value = defaultValue;
  
  widget.callback = callback;

  // Invalidate the availability cache and re-render when the local library
  // changes (e.g. a LoRA is deleted from the Lora Manager UI) so missing
  // cues and the node error flag update without waiting for the TTL.
  const unsubscribeLibraryChange = onLibraryChanged(() => {
    if (!widget.__dragActive && container.isConnected) {
      renderLoras(widget.value, widget);
    }
  });

  // Relabel open rows when the node label preference changes, so switching
  // between file names and model names does not need a workflow reload.
  const unsubscribeNodeLabelChange = onNodeLoraNameDisplayChanged(() => {
    if (!widget.__dragActive && container.isConnected) {
      renderLoras(widget.value, widget);
    }
  });

  // Fetch the local library and re-render once available so missing entries
  // get their visual cue and the node error flag as soon as the data lands.
  getAvailableLoras().then(() => {
    if (!widget.__dragActive && container.isConnected) {
      renderLoras(widget.value, widget);
    }
  });

  widget.onRemove = () => {
    groupsController?.dispose();
    unsubscribeLibraryChange();
    unsubscribeNodeLabelChange();
    if (errorFlagTimer !== null) {
      clearTimeout(errorFlagTimer);
      errorFlagTimer = null;
      pendingErrorFlag = null;
    }
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    previewTooltip.cleanup();
    container.removeEventListener('keydown', handleContainerKeydown);
  };

  return { minWidth: 400, minHeight: defaultHeight, widget };
}

// Node classes whose declared "loras" input (LORAS widget type) also applies
// trigger-word selection highlighting on lora selection.
const LORAS_WIDGET_HIGHLIGHT_NODE_CLASSES = new Set([
  "Lora Loader (LoraManager)",
  "Lora Stacker (LoraManager)",
  "Create Hook LoRA (LoraManager)",
]);

app.registerExtension({
  name: "LoraManager.LorasWidget",

  getCustomWidgets() {
    return {
      // Synchronous factory for the declared "loras" input (LORAS type) used by
      // Lora Loader / Lora Stacker / Create Hook LoRA / WanVideo Lora Select /
      // Lora Randomizer nodes. ComfyUI calls widget constructors synchronously,
      // so this must NOT be async.
      LORAS(node) {
        const comfyClass = node?.comfyClass;
        const isRandomizerNode = comfyClass === "Lora Randomizer (LoraManager)";

        const opts = {
          isRandomizerNode,
          isAnimaModeNode: comfyClass === "Lora Loader (LoraManager)",
        };

        if (isRandomizerNode || comfyClass === "WanVideo Lora Select (LoraManager)") {
          opts.onSelectionChange = (selection) => {
            updateConnectedLoraInfoNodes(node, selection);
          };
        } else if (LORAS_WIDGET_HIGHLIGHT_NODE_CLASSES.has(comfyClass)) {
          opts.onSelectionChange = (selection) => {
            applySelectionHighlight(node, selection);
            updateConnectedLoraInfoNodes(node, selection);
          };
        }

        // The randomizer has no per-node JS extension; update downstream
        // loaders directly from the widget callback. The other nodes assign
        // their own widget.callback in their onNodeCreated handlers.
        const callback = isRandomizerNode
          ? () => updateDownstreamLoaders(node)
          : null;

        return addLorasWidget(node, "loras", opts, callback);
      },
    };
  },
});
