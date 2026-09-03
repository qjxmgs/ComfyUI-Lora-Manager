"""In-memory key remapping for legacy 28-layer Anima LoRAs.

The 28 -> 40 layer layout follows the mapping documented by the MIT-licensed
ComfyUI-Anima-28to40-Lora-Converter project:
https://github.com/R0smontis/ComfyUI-Anima-28to40-Lora-Converter

This module intentionally does not write files.  A successful remap creates a
new mapping whose tensor values are the exact objects from the source mapping.
The caller can therefore apply it without changing the source LoRA or creating
a converted copy on disk.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any


OLD_BLOCK_COUNT = 28
NEW_BLOCK_COUNT = 40
INSERTION_POSITIONS = (2, 5, 8, 11, 14, 17, 21, 24, 27, 30, 33, 36)

STATUS_CONVERTED = "converted"
STATUS_ALREADY_40 = "already_40"
STATUS_NOT_ANIMA = "not_anima"
STATUS_ERROR = "error"


def build_old_to_new_map(
    old_block_count: int = OLD_BLOCK_COUNT,
    new_block_count: int = NEW_BLOCK_COUNT,
    insertion_positions: tuple[int, ...] = INSERTION_POSITIONS,
) -> dict[int, int]:
    """Build the old Anima block index to new Anima block index mapping."""
    insertion_set = set(insertion_positions)
    if len(insertion_set) != new_block_count - old_block_count:
        raise ValueError("The insertion count does not match the block-count delta")
    if any(index < 0 or index >= new_block_count for index in insertion_set):
        raise ValueError("An insertion position is outside the new block range")

    mapping: dict[int, int] = {}
    old_index = 0
    for new_index in range(new_block_count):
        if new_index in insertion_set:
            continue
        if old_index >= old_block_count:
            raise ValueError("The old block range overflows while building the map")
        mapping[old_index] = new_index
        old_index += 1

    if old_index != old_block_count:
        raise ValueError("The old block range was not fully mapped")
    return mapping


OLD_TO_NEW = build_old_to_new_map()

# Supported Anima main-backbone key forms.  The LLM adapter has its own block
# sequence and must never be remapped with the diffusion-model backbone.
BLOCK_PATTERNS = (
    re.compile(r"(?P<prefix>lora_unet_blocks_)(?P<idx>\d+)(?P<suffix>_)"),
    re.compile(r"(?P<prefix>(?:^|[./])net[./]blocks[./])(?P<idx>\d+)(?P<suffix>[./])"),
    re.compile(
        r"(?P<prefix>(?:^|[./])diffusion_model[./]blocks[./])"
        r"(?P<idx>\d+)(?P<suffix>[./])"
    ),
)
LLM_ADAPTER_PATTERN = re.compile(r"(?:^|[._/])llm_adapter(?:[._/]|$)")


class LoraRemapError(ValueError):
    """Raised internally when a state dictionary cannot be remapped safely."""


def find_main_block(key: str) -> tuple[re.Match[str] | None, int | None]:
    """Return the matched Anima backbone block and its index for *key*."""
    if LLM_ADAPTER_PATTERN.search(key):
        return None, None
    for pattern in BLOCK_PATTERNS:
        match = pattern.search(key)
        if match is not None:
            return match, int(match.group("idx"))
    return None, None


def remap_key(
    key: str, old_to_new: Mapping[int, int] = OLD_TO_NEW
) -> tuple[str, int | None, int | None]:
    """Return ``(new_key, old_index, new_index)`` for one LoRA key."""
    match, old_index = find_main_block(key)
    if match is None or old_index is None:
        return key, None, None
    if old_index not in old_to_new:
        raise LoraRemapError(
            f"Unsupported Anima backbone block {old_index} in key {key!r}"
        )

    new_index = old_to_new[old_index]
    new_key = f"{key[:match.start('idx')]}{new_index}{key[match.end('idx'):]}"
    return new_key, old_index, new_index


def analyze_lora_blocks(state_dict: Mapping[str, Any]) -> dict[str, Any]:
    """Describe recognized Anima backbone block indices in *state_dict*."""
    indices: set[int] = set()
    matched_keys = 0
    for key in state_dict:
        _match, index = find_main_block(key)
        if index is not None:
            matched_keys += 1
            indices.add(index)
    return {
        "matched_keys": matched_keys,
        "indices": indices,
        "min_index": min(indices) if indices else None,
        "max_index": max(indices) if indices else None,
    }


def remap_lora_state_dict(
    state_dict: Mapping[str, Any],
    *,
    source_name: str = "<memory>",
    old_to_new: Mapping[int, int] = OLD_TO_NEW,
) -> dict[str, Any]:
    """Strictly remap a recognized legacy Anima state dictionary.

    The source mapping is never mutated.  Values are assigned directly, so no
    tensor is cloned, converted, or moved.
    """
    remapped: dict[str, Any] = {}
    matched_keys = 0
    collisions: list[str] = []

    for key, value in state_dict.items():
        new_key, old_index, _new_index = remap_key(key, old_to_new)
        if old_index is not None:
            matched_keys += 1
        if new_key in remapped:
            collisions.append(new_key)
            continue
        remapped[new_key] = value

    if matched_keys == 0:
        raise LoraRemapError(
            f"{source_name} has no recognized Anima backbone block keys"
        )
    if collisions:
        preview = ", ".join(collisions[:5])
        suffix = "" if len(collisions) <= 5 else ", ..."
        raise LoraRemapError(
            f"{source_name} would produce duplicate remapped keys: {preview}{suffix}"
        )
    return remapped


def remap_lora_state_dict_safe(
    state_dict: Mapping[str, Any], *, source_name: str = "<memory>"
) -> tuple[Mapping[str, Any], str, str]:
    """Safely remap a LoRA, returning the original mapping on every failure."""
    if not state_dict:
        return state_dict, STATUS_NOT_ANIMA, f"{source_name} is empty; loading unchanged"

    analysis = analyze_lora_blocks(state_dict)
    if analysis["matched_keys"] == 0:
        return (
            state_dict,
            STATUS_NOT_ANIMA,
            f"{source_name} has no recognized Anima backbone blocks; loading unchanged",
        )
    if analysis["max_index"] >= OLD_BLOCK_COUNT:
        return (
            state_dict,
            STATUS_ALREADY_40,
            f"{source_name} already uses a 40-layer-style backbone; loading unchanged",
        )

    try:
        remapped = remap_lora_state_dict(state_dict, source_name=source_name)
    except Exception as error:  # The loader must remain able to use the original LoRA.
        return state_dict, STATUS_ERROR, f"{source_name} remap skipped: {error}"

    return (
        remapped,
        STATUS_CONVERTED,
        f"{source_name}: remapped {analysis['matched_keys']} backbone keys "
        f"across {len(analysis['indices'])} layers (28 -> 40) in memory",
    )


def _get_diffusion_model(model: Any) -> Any | None:
    return getattr(getattr(model, "model", None), "diffusion_model", None)


def is_anima_40_model(model: Any) -> bool:
    """Return whether *model* is an Anima 2.9B-style 40-block backbone."""
    try:
        diffusion_model = _get_diffusion_model(model)
        if diffusion_model is None or not hasattr(diffusion_model, "llm_adapter"):
            return False
        blocks = getattr(diffusion_model, "blocks", None)
        return blocks is not None and len(blocks) == NEW_BLOCK_COUNT
    except Exception:
        return False


__all__ = [
    "BLOCK_PATTERNS",
    "INSERTION_POSITIONS",
    "LLM_ADAPTER_PATTERN",
    "LoraRemapError",
    "NEW_BLOCK_COUNT",
    "OLD_BLOCK_COUNT",
    "OLD_TO_NEW",
    "STATUS_ALREADY_40",
    "STATUS_CONVERTED",
    "STATUS_ERROR",
    "STATUS_NOT_ANIMA",
    "analyze_lora_blocks",
    "build_old_to_new_map",
    "find_main_block",
    "is_anima_40_model",
    "remap_key",
    "remap_lora_state_dict",
    "remap_lora_state_dict_safe",
]
