import pytest

from py.nodes.anima_lora_remap import (
    OLD_TO_NEW,
    STATUS_ALREADY_40,
    STATUS_CONVERTED,
    STATUS_ERROR,
    STATUS_NOT_ANIMA,
    analyze_lora_blocks,
    is_anima_40_model,
    remap_lora_state_dict,
    remap_lora_state_dict_safe,
)


def test_fixed_28_to_40_mapping_matches_anima_layout():
    assert OLD_TO_NEW[0] == 0
    assert OLD_TO_NEW[2] == 3
    assert OLD_TO_NEW[14] == 20
    assert OLD_TO_NEW[27] == 39


def test_remap_supports_all_backbone_key_forms_without_copying_values():
    block_two = object()
    block_fourteen = object()
    block_twenty_seven = object()
    adapter_block = object()
    source = {
        "lora_unet_blocks_2_attn_to_q.lora_down.weight": block_two,
        "net.blocks.14.attn.to_q.lora_down.weight": block_fourteen,
        "diffusion_model/blocks/27/attn/to_q/lora_down.weight": block_twenty_seven,
        "llm_adapter.net.blocks.2.attn.to_q.lora_down.weight": adapter_block,
    }

    remapped, status, _message = remap_lora_state_dict_safe(source, source_name="legacy")

    assert status == STATUS_CONVERTED
    assert remapped is not source
    assert remapped["lora_unet_blocks_3_attn_to_q.lora_down.weight"] is block_two
    assert remapped["net.blocks.20.attn.to_q.lora_down.weight"] is block_fourteen
    assert remapped["diffusion_model/blocks/39/attn/to_q/lora_down.weight"] is block_twenty_seven
    assert remapped["llm_adapter.net.blocks.2.attn.to_q.lora_down.weight"] is adapter_block
    assert set(source) == {
        "lora_unet_blocks_2_attn_to_q.lora_down.weight",
        "net.blocks.14.attn.to_q.lora_down.weight",
        "diffusion_model/blocks/27/attn/to_q/lora_down.weight",
        "llm_adapter.net.blocks.2.attn.to_q.lora_down.weight",
    }


def test_non_anima_and_already_40_loras_are_returned_unchanged():
    non_anima = {"lora_te_text_model.encoder.weight": object()}
    already_40 = {"lora_unet_blocks_28_attn_to_q.lora_down.weight": object()}

    returned_non_anima, non_anima_status, _ = remap_lora_state_dict_safe(non_anima)
    returned_already_40, already_40_status, _ = remap_lora_state_dict_safe(already_40)

    assert returned_non_anima is non_anima
    assert non_anima_status == STATUS_NOT_ANIMA
    assert returned_already_40 is already_40
    assert already_40_status == STATUS_ALREADY_40


def test_remap_collision_is_reported_without_replacing_the_original(monkeypatch):
    source = {
        "lora_unet_blocks_0_attn.weight": object(),
        "lora_unet_blocks_1_attn.weight": object(),
    }

    with pytest.raises(ValueError, match="duplicate remapped keys"):
        remap_lora_state_dict(source, old_to_new={0: 1, 1: 1})

    monkeypatch.setattr(
        "py.nodes.anima_lora_remap.remap_lora_state_dict",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("bad remap")),
    )
    returned, status, _ = remap_lora_state_dict_safe(source)

    assert returned is source
    assert status == STATUS_ERROR


class _DiffusionModel:
    def __init__(self, block_count, has_adapter=True):
        self.blocks = [object()] * block_count
        if has_adapter:
            self.llm_adapter = object()


class _Model:
    def __init__(self, diffusion_model):
        self.model = type("Container", (), {"diffusion_model": diffusion_model})()


def test_anima_model_detection_requires_adapter_and_exactly_40_blocks():
    assert is_anima_40_model(_Model(_DiffusionModel(40)))
    assert not is_anima_40_model(_Model(_DiffusionModel(40, has_adapter=False)))
    assert not is_anima_40_model(_Model(_DiffusionModel(28)))
    assert not is_anima_40_model(object())


def test_analyze_ignores_llm_adapter_blocks():
    analysis = analyze_lora_blocks(
        {
            "llm_adapter.net.blocks.4.attn.weight": object(),
            "lora_unet_blocks_4_attn.weight": object(),
        }
    )

    assert analysis["matched_keys"] == 1
    assert analysis["indices"] == {4}
