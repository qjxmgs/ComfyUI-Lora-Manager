from py.nodes.lora_loader import LoraLoaderLM


class _DiffusionModel:
    def __init__(self, block_count=40, has_adapter=True):
        self.blocks = [object()] * block_count
        if has_adapter:
            self.llm_adapter = object()


class _Model:
    def __init__(self, diffusion_model):
        self.model = type("Container", (), {"diffusion_model": diffusion_model})()


def _load_one_lora(loader, model, state_dict, monkeypatch, anima_mode):
    monkeypatch.setattr(
        "py.nodes.lora_loader.get_lora_info_absolute",
        lambda name: (f"/abs/{name}.safetensors", [f"{name}_trigger"]),
    )
    monkeypatch.setattr(
        "comfy.utils.load_torch_file", lambda _path, safe_load=True: state_dict
    )
    applied = []
    monkeypatch.setattr(
        "comfy.sd.load_lora_for_models",
        lambda model_arg, clip_arg, lora_arg, model_strength, clip_strength: (
            applied.append((lora_arg, model_strength, clip_strength))
            or (model_arg, clip_arg)
        ),
    )

    result = loader.load_loras(
        model,
        "",
        loras={"__value__": [{"active": True, "name": "demo", "strength": 0.75}]},
        anima_mode=anima_mode,
    )
    return result, applied


def test_anima_mode_remaps_legacy_lora_only_for_a_40_layer_anima_model(monkeypatch):
    tensor = object()
    source = {
        "lora_unet_blocks_2_attn_to_q.lora_down.weight": tensor,
        "lora_unet_llm_adapter_blocks_2_attn_to_q.lora_down.weight": object(),
    }

    _result, applied = _load_one_lora(
        LoraLoaderLM(), _Model(_DiffusionModel()), source, monkeypatch, anima_mode=True
    )

    applied_state_dict, model_strength, clip_strength = applied[0]
    assert applied_state_dict is not source
    assert applied_state_dict["lora_unet_blocks_3_attn_to_q.lora_down.weight"] is tensor
    assert "lora_unet_blocks_2_attn_to_q.lora_down.weight" in source
    assert model_strength == 0.75
    assert clip_strength == 0.75


def test_disabled_mode_and_non_anima_model_use_the_original_state_dict(monkeypatch):
    source = {"lora_unet_blocks_2_attn_to_q.lora_down.weight": object()}
    loader = LoraLoaderLM()

    _result, disabled_applied = _load_one_lora(
        loader, _Model(_DiffusionModel()), source, monkeypatch, anima_mode=False
    )
    _result, non_anima_applied = _load_one_lora(
        loader,
        _Model(_DiffusionModel(has_adapter=False)),
        source,
        monkeypatch,
        anima_mode=True,
    )

    assert disabled_applied[0][0] is source
    assert non_anima_applied[0][0] is source


def test_non_anima_and_already_40_loras_use_the_original_state_dict(monkeypatch):
    loader = LoraLoaderLM()
    model = _Model(_DiffusionModel())
    non_anima = {"lora_te_text_model.encoder.weight": object()}
    already_40 = {"lora_unet_blocks_28_attn_to_q.lora_down.weight": object()}

    _result, non_anima_applied = _load_one_lora(
        loader, model, non_anima, monkeypatch, anima_mode=True
    )
    _result, already_40_applied = _load_one_lora(
        loader, model, already_40, monkeypatch, anima_mode=True
    )

    assert non_anima_applied[0][0] is non_anima
    assert already_40_applied[0][0] is already_40


def test_loader_schema_exposes_a_default_off_anima_mode():
    input_types = LoraLoaderLM.INPUT_TYPES()

    assert input_types["hidden"]["anima_mode"] == ("BOOLEAN", {"default": False})
