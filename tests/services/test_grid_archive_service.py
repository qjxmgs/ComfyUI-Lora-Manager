from __future__ import annotations

import copy
import io
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image

from py.services.errors import GridArchiveError
from py.services.grid_archive_service import GridArchiveService, validate_snapshot


def snapshot():
    return {"version": 1, "groupConfig": {"version": 2, "rows": 1, "columns": 2, "nextAddedOrder": 3,
        "groups": [
            {"id": "a", "title": "Main", "mode": "single", "enabled": True, "pausedActive": [],
             "sortRules": [{"field": "name", "direction": "desc"}], "titleColor": "blue"},
            {"id": "b", "title": "Paused", "mode": "multi", "enabled": False, "pausedActive": ["B"],
             "sortRules": [], "titleColor": None}]},
        "entries": [{"name": "A", "groupId": "a", "strength": "1.00", "clipStrength": 0.3,
                     "active": True, "locked": True, "expanded": True, "addedOrder": 0},
                    {"name": "B", "groupId": "b", "strength": 0.8, "clipStrength": 0.8,
                     "active": False, "locked": False, "expanded": False, "addedOrder": 2}],
        "nodeSize": [1100, 720]}


@pytest.fixture
def store(tmp_path):
    return GridArchiveService(tmp_path / "grid_archives")


def mutate(store, collection, method="POST", identifier=None, **payload):
    return store.mutate(collection, method, identifier, {"revision": store.list_library()["revision"], **payload})


def create(store, name="Example", category="default"):
    return mutate(store, "archives", name=name, categoryId=category, snapshot=snapshot())


def test_full_snapshot_survives_restart_and_no_read_side_effects(store):
    assert store.list_library()["revision"] == 0
    assert not store.directory.exists()
    data = create(store)
    reopened = GridArchiveService(store.directory).list_library()
    assert reopened["archives"][0]["snapshot"] == validate_snapshot(snapshot())
    assert reopened["archives"][0]["id"] == data["resultId"]
    assert reopened["archives"][0]["snapshot"]["entries"][0]["strength"] == 1


def test_partial_grid_count_survives_archive_reload(store):
    value = snapshot()
    value["groupConfig"].update(rows=2, columns=2, groupCount=2)
    mutate(store, "archives", name="Partial grid", categoryId="default", snapshot=value)
    restored = GridArchiveService(store.directory).list_library()["archives"][0]["snapshot"]
    assert restored["groupConfig"]["groupCount"] == 2
    assert len(restored["groupConfig"]["groups"]) == 2
    assert restored["entries"] == validate_snapshot(snapshot())["entries"]


@pytest.mark.parametrize("count", [0, -1, True, "2", 3])
def test_invalid_group_count_rejected(count):
    value = snapshot()
    value["groupConfig"]["groupCount"] = count
    with pytest.raises(GridArchiveError):
        validate_snapshot(value)


def test_cycle_preference_defaults_off_and_survives_archive_reload(store):
    legacy = validate_snapshot(snapshot())
    assert all(group["autoCycle"] is False for group in legacy["groupConfig"]["groups"])
    value = snapshot()
    value["groupConfig"]["groups"][0]["autoCycle"] = True
    mutate(store, "archives", name="Cycle", categoryId="default", snapshot=value)
    restored = GridArchiveService(store.directory).list_library()["archives"][0]["snapshot"]
    assert restored["groupConfig"]["version"] == 2
    assert restored["groupConfig"]["groups"][0]["autoCycle"] is True
    assert restored["groupConfig"]["groups"][1]["autoCycle"] is False


@pytest.mark.parametrize("invalid", ["true", 1, None, []])
def test_cycle_preference_rejects_non_boolean_values(invalid):
    value = snapshot()
    value["groupConfig"]["groups"][0]["autoCycle"] = invalid
    with pytest.raises(GridArchiveError):
        validate_snapshot(value)


def test_categories_move_archive_reorder_and_delete_with_migration(store):
    primary = mutate(store, "categories", name="Styles", parentId=None)["resultId"]
    secondary = mutate(store, "categories", name="Portrait", parentId=primary)["resultId"]
    first = create(store, "First", secondary)["resultId"]
    second = create(store, "Second", secondary)["resultId"]
    data = mutate(store, "archives", "PATCH", "reorder", categoryId=secondary, ids=[second, first])
    assert sorted(data["archives"], key=lambda item: item["order"])[0]["id"] == second
    mutate(store, "categories", "PATCH", secondary, name="Faces", parentId="uncategorized")
    data = mutate(store, "categories", "DELETE", secondary, destinationId="default")
    assert all(item["categoryId"] == "default" for item in data["archives"])
    mutate(store, "categories", "DELETE", primary)
    assert len(store.list_library()["categories"]) == 2


def test_category_menu_changes_persist_without_changing_archives_or_images(store):
    primary = mutate(store, "categories", name="Styles", parentId=None)["resultId"]
    secondary = mutate(store, "categories", name="Portraits", parentId="uncategorized")["resultId"]
    data = create(store, category=secondary)
    identifier = data["resultId"]
    image = io.BytesIO()
    Image.new("RGB", (16, 16), "blue").save(image, "PNG")
    store.set_image(identifier, data["revision"], image.getvalue())
    original = store.list_library()["archives"]
    image_bytes = store.image(identifier).read_bytes()
    mutate(store, "categories", "PATCH", "reorder", parentId=None, ids=[primary, "uncategorized"])
    mutate(store, "categories", "PATCH", "reorder", parentId="uncategorized", ids=[secondary, "default"])
    mutate(store, "categories", "PATCH", secondary, name="Renamed", parentId=primary)
    restored = GridArchiveService(store.directory).list_library()
    categories = {item["id"]: item for item in restored["categories"]}
    assert categories[primary]["order"] == 0
    assert categories["uncategorized"]["order"] == 1
    assert categories[secondary]["parentId"] == primary
    assert categories[secondary]["name"] == "Renamed"
    assert restored["archives"] == original
    assert store.image(identifier).read_bytes() == image_bytes


def test_primary_delete_moves_children_and_rejects_duplicate_destination(store):
    primary = mutate(store, "categories", name="Styles", parentId=None)["resultId"]
    secondary = mutate(store, "categories", name="Default", parentId=primary)["resultId"]
    before = store.list_library()
    with pytest.raises(GridArchiveError, match="duplicate"):
        mutate(store, "categories", "DELETE", primary, destinationId="uncategorized")
    assert store.list_library() == before
    mutate(store, "categories", "PATCH", secondary, name="Moved")
    mutate(store, "categories", "DELETE", primary, destinationId="uncategorized")
    assert next(item for item in store.list_library()["categories"] if item["id"] == secondary)["parentId"] == "uncategorized"


def test_duplicate_names_are_scoped_and_default_categories_protected(store):
    create(store, "Example")
    with pytest.raises(GridArchiveError, match="duplicate"):
        create(store, "example")
    secondary = mutate(store, "categories", name="Other", parentId="uncategorized")["resultId"]
    create(store, "Example", secondary)
    for identifier in ["uncategorized", "default"]:
        with pytest.raises(GridArchiveError, match="protected"):
            mutate(store, "categories", "DELETE", identifier)
    with pytest.raises(GridArchiveError):
        mutate(store, "categories", name="Third level", parentId="default")
    with pytest.raises(GridArchiveError):
        create(store, category="uncategorized")


def test_revision_conflict_does_not_overwrite(store):
    data = create(store)
    old = data["revision"]
    identifier = data["resultId"]
    mutate(store, "archives", "PATCH", identifier, name="Changed")
    with pytest.raises(GridArchiveError, match="conflict"):
        store.mutate("archives", "PATCH", identifier, {"revision": old, "name": "Stale"})
    with pytest.raises(GridArchiveError, match="conflict"):
        mutate(store, "archives", "PATCH", identifier, archiveRevision=1, name="Stale")
    assert store.list_library()["archives"][0]["name"] == "Changed"


def test_concurrent_writers_only_one_succeeds(store):
    data = create(store)
    def write(name):
        try:
            store.mutate("archives", "PATCH", data["resultId"], {"revision": data["revision"], "name": name})
            return "ok"
        except GridArchiveError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(write, ["one", "two"])) == ["conflict", "ok"]


@pytest.mark.parametrize("change", [
    lambda value: value.update(version=9),
    lambda value: value["groupConfig"].update(rows=257),
    lambda value: value["entries"][0].update(strength="NaN"),
    lambda value: value["entries"][0].update(groupId="missing"),
    lambda value: value["entries"][1].update(active=True),
    lambda value: value["entries"].append(copy.deepcopy(value["entries"][0])),
    lambda value: value.update(nodeSize=[0, 100]),
    lambda value: value["groupConfig"]["groups"][1].update(pausedActive=["unknown"]),
])
def test_bad_snapshots_rejected_without_mutating_library(store, change):
    create(store)
    before = store.list_library()
    value = snapshot(); change(value)
    with pytest.raises(GridArchiveError):
        mutate(store, "archives", name="Bad", snapshot=value)
    assert store.list_library() == before


def test_corrupt_library_is_preserved(store):
    create(store)
    path = store.directory / "library.json"
    path.write_bytes(b'{"version":')
    with pytest.raises(GridArchiveError, match="corrupt"):
        store.list_library()
    with pytest.raises(GridArchiveError, match="corrupt"):
        store.mutate("archives", "POST", None, {"revision": 0})
    assert path.read_bytes() == b'{"version":'


def test_image_replacement_validation_and_cleanup(store):
    data = create(store); identifier = data["resultId"]
    output = io.BytesIO(); Image.new("RGB", (2048, 1024), "red").save(output, "PNG")
    data = store.set_image(identifier, data["revision"], output.getvalue())
    first = store.image(identifier)
    with Image.open(first) as preview:
        assert preview.format == "WEBP" and preview.size == (1024, 512)
    data = store.set_image(identifier, data["revision"], output.getvalue())
    assert not first.exists()
    second = store.image(identifier)
    with pytest.raises(GridArchiveError, match="imageInvalid"):
        store.set_image(identifier, data["revision"], b"not an image")
    assert second.exists()
    with pytest.raises(GridArchiveError, match="conflict"):
        store.set_image(identifier, data["revision"] - 1, None)
    store.set_image(identifier, data["revision"], None)
    assert not second.exists()
    with pytest.raises(GridArchiveError, match="notFound"):
        store.image(identifier)
    store.set_image(identifier, store.list_library()["revision"], output.getvalue())
    last = store.image(identifier)
    mutate(store, "archives", "DELETE", identifier)
    assert not last.exists()


def test_path_traversal_in_image_metadata_rejected(store, tmp_path):
    create(store)
    path = store.directory / "library.json"
    data = json.loads(path.read_text(encoding="utf-8")); data["archives"][0]["image"] = "../../outside.webp"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(GridArchiveError, match="corrupt"):
        store.image(data["archives"][0]["id"])


def test_failed_atomic_replace_preserves_previous_library(store, monkeypatch):
    create(store)
    before = (store.directory / "library.json").read_bytes()
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr("py.services.grid_archive_service.os.replace", fail)
    with pytest.raises(OSError):
        create(store, "Second")
    assert (store.directory / "library.json").read_bytes() == before
    assert list(store.directory.iterdir()) == [store.directory / "library.json"]


def test_settings_directory_migration_copies_archives_and_images(store, tmp_path):
    from py.services.settings_manager import SettingsManager
    data = create(store)
    image = io.BytesIO()
    Image.new("RGB", (32, 32), "blue").save(image, "PNG")
    store.set_image(data["resultId"], data["revision"], image.getvalue())
    source = store.directory.parent
    target = tmp_path / "portable"
    manager = object.__new__(SettingsManager)
    manager._migrate_settings_directory_content(str(source), str(target))
    migrated = GridArchiveService(target / "grid_archives")
    assert migrated.list_library() == store.list_library()
    assert migrated.image(data["resultId"]).read_bytes() == store.image(data["resultId"]).read_bytes()


def test_default_service_resolves_current_settings_directory(tmp_path, monkeypatch):
    directory = [tmp_path / "first"]
    monkeypatch.setattr("py.services.grid_archive_service.get_settings_dir", lambda: str(directory[0]))
    store = GridArchiveService(); create(store)
    directory[0] = tmp_path / "second"
    assert store.list_library()["archives"] == []


@pytest.mark.parametrize("identifier,parent", [("uncategorized", None), ("default", "uncategorized")])
def test_default_category_rename_persists_and_keeps_archive_references(store, identifier, parent):
    original = create(store)["archives"]
    mutate(store, "categories", "PATCH", identifier, name="Custom category", parentId=parent)
    restored = GridArchiveService(store.directory).list_library()
    category = next(item for item in restored["categories"] if item["id"] == identifier)
    assert category["name"] == "Custom category"
    assert category["parentId"] == parent
    assert restored["archives"] == original
    other = mutate(store, "categories", name="Other", parentId=None)["resultId"]
    with pytest.raises(GridArchiveError, match="protected"):
        mutate(store, "categories", "PATCH", identifier, parentId=other)
    with pytest.raises(GridArchiveError, match="protected"):
        mutate(store, "categories", "DELETE", identifier)
    mutate(store, "categories", name="Sibling", parentId=parent)
    with pytest.raises(GridArchiveError, match="duplicate"):
        mutate(store, "categories", "PATCH", identifier, name="sibling")
    assert next(item for item in store.list_library()["categories"] if item["id"] == identifier)["name"] == "Custom category"
