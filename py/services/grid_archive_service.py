"""Versioned grid snapshots, independent of model sidecars and recipes."""
from __future__ import annotations

import copy
import io
import json
import logging
import math
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from .errors import GridArchiveError
from ..utils.settings_paths import get_settings_dir

logger = logging.getLogger(__name__)
DEFAULT_PRIMARY = "uncategorized"
DEFAULT_SECONDARY = "default"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_STORE_BYTES = 32 * 1024 * 1024
GROUP_COLORS = frozenset((
    "red", "coral", "orange", "peach", "amber", "yellow", "olive", "green", "mint", "teal",
    "cyan", "sky", "blue", "navy", "indigo", "purple", "lavender", "pink", "rose", "brown",
    "slate", "gray", "white", "black", "rgb", "gbr", "brg",
))
_STORE_LOCK = threading.RLock()


def _require(condition: bool, code: str = "invalid") -> None:
    if not condition:
        raise GridArchiveError(code)


def _name(value: Any) -> str:
    _require(isinstance(value, str) and 0 < len(value.strip()) <= 100)
    return value.strip()


def _number(value: Any) -> float:
    _require(isinstance(value, (str, int, float)) and not isinstance(value, bool))
    try:
        result = float(value)
    except (ValueError, OverflowError):
        raise GridArchiveError("invalid") from None
    _require(math.isfinite(result))
    return result


def validate_snapshot(value: Any) -> dict[str, Any]:
    """Validate references and semantics without applying live-node state."""
    _require(isinstance(value, dict) and value.get("version") == 1)
    config = value.get("groupConfig")
    _require(isinstance(config, dict) and config.get("version") == 2)
    rows, columns = config.get("rows"), config.get("columns")
    _require(type(rows) is int and type(columns) is int and rows > 0 and columns > 0 and rows * columns <= 256)
    groups = config.get("groups")
    count = config.get("groupCount", rows * columns)
    _require(type(count) is int and 0 < count <= rows * columns)
    _require(isinstance(groups, list) and len(groups) == count)
    ids: set[str] = set()
    normalized_groups = []
    for group in groups:
        _require(isinstance(group, dict))
        gid = _name(group.get("id"))
        _require(gid not in ids)
        ids.add(gid)
        _require(group.get("mode") in ("single", "multi"))
        paused = group.get("pausedActive", [])
        _require(isinstance(paused, list) and all(isinstance(name, str) for name in paused))
        rules = group.get("sortRules", [])
        _require(isinstance(rules, list) and len(rules) <= 4)
        _require(all(isinstance(rule, dict) and rule.get("field") in ("addedOrder", "active", "strength", "name")
                     and rule.get("direction") in ("asc", "desc") for rule in rules))
        _require(len({rule["field"] for rule in rules}) == len(rules))
        color = group.get("titleColor")
        _require(color is None or isinstance(color, str) and color in GROUP_COLORS)
        _require(type(group.get("enabled", True)) is bool)
        _require(type(group.get("autoCycle", False)) is bool)
        normalized_groups.append({"id": gid, "title": _name(group.get("title")), "mode": group["mode"],
                                  "enabled": group.get("enabled", True), "pausedActive": list(dict.fromkeys(paused)),
                                  "autoCycle": group.get("autoCycle", False),
                                  "sortRules": rules, "titleColor": color})
    entries = value.get("entries")
    _require(isinstance(entries, list) and len(entries) <= 10000)
    names: set[str] = set()
    normalized_entries = []
    for entry in entries:
        _require(isinstance(entry, dict))
        name = entry.get("name")
        _require(isinstance(name, str) and 0 < len(name) <= 4096 and name not in names)
        names.add(name)
        _require(entry.get("groupId") in ids)
        order = entry.get("addedOrder", 0)
        _require(type(order) is int and 0 <= order < 2**53 - 1)
        _require(all(type(entry.get(key, False)) is bool for key in ("active", "locked", "expanded")))
        normalized_entries.append({"name": name, "groupId": entry["groupId"], "addedOrder": order,
                                   "strength": _number(entry.get("strength")),
                                   "clipStrength": _number(entry.get("clipStrength", entry.get("strength"))),
                                   **{key: entry.get(key, False) for key in ("active", "locked", "expanded")}})
    for group in normalized_groups:
        members = [entry for entry in normalized_entries if entry["groupId"] == group["id"]]
        _require(all(name in {entry["name"] for entry in members} for name in group["pausedActive"]))
        active_count = sum(entry["active"] for entry in members)
        _require((group["enabled"] or active_count == 0) and (group["mode"] != "single" or active_count <= 1))
    counter = config.get("nextAddedOrder", 0)
    _require(type(counter) is int and 0 <= counter < 2**53)
    orders = [entry["addedOrder"] for entry in normalized_entries]
    _require(len(orders) == len(set(orders)) and all(order < counter for order in orders))
    size = value.get("nodeSize")
    _require(isinstance(size, list) and len(size) == 2)
    size = [_number(dimension) for dimension in size]
    _require(all(0 < dimension <= 100000 for dimension in size))
    return {"version": 1, "groupConfig": {"version": 2, "rows": rows, "columns": columns,
            **({"groupCount": count} if count < rows * columns else {}),
            "groups": normalized_groups, "nextAddedOrder": counter}, "entries": normalized_entries, "nodeSize": size}


class GridArchiveService:
    """Resolve the settings directory per operation so portable migration works."""

    def __init__(self, directory: str | Path | None = None) -> None:
        self.directory = Path(directory) if directory is not None else None

    def _root(self) -> Path:
        return self.directory if self.directory is not None else Path(get_settings_dir()) / "grid_archives"

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"version": 1, "revision": 0, "categories": [
            {"id": DEFAULT_PRIMARY, "parentId": None, "name": "Uncategorized", "order": 0},
            {"id": DEFAULT_SECONDARY, "parentId": DEFAULT_PRIMARY, "name": "Default", "order": 0},
        ], "archives": []}

    def _read(self, root: Path) -> dict[str, Any]:
        path = root / "library.json"
        if not path.exists():
            return self._empty()
        try:
            _require(path.stat().st_size <= MAX_STORE_BYTES)
            data = json.loads(path.read_text(encoding="utf-8"))
            _require(data["version"] == 1 and type(data["revision"]) is int and data["revision"] >= 0)
            categories, archives = data["categories"], data["archives"]
            _require(isinstance(categories, list) and isinstance(archives, list))
            by_id = {item["id"]: item for item in categories}
            _require(len(by_id) == len(categories) and DEFAULT_PRIMARY in by_id and DEFAULT_SECONDARY in by_id)
            _require(by_id[DEFAULT_PRIMARY]["parentId"] is None and by_id[DEFAULT_SECONDARY]["parentId"] == DEFAULT_PRIMARY)
            for category in categories:
                _name(category["name"])
                parent = category["parentId"]
                _require(parent is None or parent in by_id and by_id[parent]["parentId"] is None)
                _require(type(category["order"]) is int)
            _require(len({(item["parentId"], item["name"].casefold()) for item in categories}) == len(categories))
            _require(len({item["id"] for item in archives}) == len(archives))
            _require(len({(item["categoryId"], item["name"].casefold()) for item in archives}) == len(archives))
            for archive in archives:
                _name(archive["name"])
                _require(archive["categoryId"] in by_id and by_id[archive["categoryId"]]["parentId"] is not None)
                _require(type(archive["revision"]) is int and type(archive["order"]) is int)
                _require(archive.get("image") is None or re.fullmatch(r"[a-f0-9]{32}\.webp", archive["image"]) is not None)
                archive["snapshot"] = validate_snapshot(archive["snapshot"])
            return data
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
            logger.warning("Could not read grid archive library: %s", error)
            raise GridArchiveError("corrupt", 500) from error

    @staticmethod
    def _atomic_write(path: Path, content: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
                temporary = handle.name
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def _write(self, root: Path, data: dict[str, Any]) -> None:
        content = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        _require(len(content) <= MAX_STORE_BYTES, "capacity")
        self._atomic_write(root / "library.json", content)

    def list_library(self) -> dict[str, Any]:
        with _STORE_LOCK:
            return self._read(self._root())

    @staticmethod
    def _find(items: list[dict[str, Any]], item_id: str) -> dict[str, Any]:
        result = next((item for item in items if item["id"] == item_id), None)
        if result is None:
            raise GridArchiveError("notFound", 404)
        return result

    @staticmethod
    def _unique(items: list[dict[str, Any]], candidate: dict[str, Any], parent_key: str) -> None:
        if any(item["id"] != candidate["id"] and item[parent_key] == candidate[parent_key]
               and item["name"].casefold() == candidate["name"].casefold() for item in items):
            raise GridArchiveError("duplicate", 409)

    def mutate(self, collection: str, method: str, item_id: str | None, payload: dict[str, Any]) -> dict[str, Any]:
        with _STORE_LOCK:
            root = self._root()
            data = self._read(root)
            _require(isinstance(payload, dict))
            if type(payload.get("revision")) is not int or payload["revision"] != data["revision"]:
                raise GridArchiveError("conflict", 409)
            _require(collection in ("categories", "archives"))
            items = data[collection]
            if item_id == "reorder":
                _require(method == "PATCH")
                ids = payload.get("ids")
                parent_key = "parentId" if collection == "categories" else "categoryId"
                siblings = [item for item in items if item[parent_key] == payload.get(parent_key)]
                _require(isinstance(ids, list) and all(isinstance(i, str) for i in ids)
                         and len(ids) == len(set(ids)) and set(ids) == {item["id"] for item in siblings})
                for index, identifier in enumerate(ids):
                    self._find(siblings, identifier)["order"] = index
            elif method == "POST":
                _require(len(items) < 10000, "capacity")
                item = {"id": uuid.uuid4().hex, "name": _name(payload.get("name")), "order": len(items)}
                if collection == "categories":
                    item["parentId"] = payload.get("parentId")
                    self._validate_parent(data, item["parentId"], primary=True)
                else:
                    item.update(categoryId=payload.get("categoryId", DEFAULT_SECONDARY),
                                snapshot=validate_snapshot(payload.get("snapshot")), image=None,
                                revision=0, createdAt=datetime.now(timezone.utc).isoformat())
                    self._validate_parent(data, item["categoryId"], primary=False)
                parent_key = "parentId" if collection == "categories" else "categoryId"
                item["order"] = max((other["order"] for other in items if other[parent_key] == item[parent_key]), default=-1) + 1
                self._unique(items, item, "parentId" if collection == "categories" else "categoryId")
                items.append(item)
                data["resultId"] = item["id"]
            else:
                item = self._find(items, item_id)
                if collection == "archives" and "archiveRevision" in payload and payload["archiveRevision"] != item["revision"]:
                    raise GridArchiveError("conflict", 409)
                if collection == "categories" and item_id in (DEFAULT_PRIMARY, DEFAULT_SECONDARY):
                    _require(method == "PATCH" and payload.get("parentId", item["parentId"]) == item["parentId"], "protected")
                if method == "DELETE":
                    if collection == "categories":
                        self._delete_category(data, item, payload.get("destinationId"))
                    items.remove(item)
                elif method == "PATCH":
                    candidate = copy.deepcopy(item)
                    if "name" in payload:
                        candidate["name"] = _name(payload["name"])
                    parent_key = "parentId" if collection == "categories" else "categoryId"
                    if parent_key in payload:
                        candidate[parent_key] = payload[parent_key]
                        self._validate_parent(data, candidate[parent_key], primary=collection == "categories")
                        if collection == "categories":
                            _require((item["parentId"] is None) == (candidate["parentId"] is None))
                        if candidate[parent_key] != item[parent_key]:
                            candidate["order"] = max((other["order"] for other in items
                                                      if other[parent_key] == candidate[parent_key]), default=-1) + 1
                    if collection == "archives" and "snapshot" in payload:
                        candidate["snapshot"] = validate_snapshot(payload["snapshot"])
                    self._unique(items, candidate, parent_key)
                    item.update(candidate)
                else:
                    raise GridArchiveError("invalid")
            data["revision"] += 1
            if collection == "archives" and item_id != "reorder" and method != "DELETE":
                item["revision"] += 1
                item["updatedAt"] = datetime.now(timezone.utc).isoformat()
            result_id = data.pop("resultId", None)
            self._write(root, data)
            if collection == "archives" and method == "DELETE" and item.get("image"):
                try:
                    (root / "images" / item["image"]).unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove deleted grid archive preview %s", item["image"])
            if result_id:
                data["resultId"] = result_id
            return data

    def _validate_parent(self, data: dict[str, Any], parent: Any, *, primary: bool) -> None:
        if parent is None and primary:
            return
        category = self._find(data["categories"], parent)
        _require((category["parentId"] is None) == primary)

    def _delete_category(self, data: dict[str, Any], item: dict[str, Any], destination: str | None) -> None:
        primary = item["parentId"] is None
        children = [child for child in data["categories" if primary else "archives"]
                    if child["parentId" if primary else "categoryId"] == item["id"]]
        if not children:
            return
        target = self._find(data["categories"], destination)
        _require(target["id"] != item["id"] and (target["parentId"] is None) == primary)
        collection = data["categories" if primary else "archives"]
        key = "parentId" if primary else "categoryId"
        next_order = max((other["order"] for other in collection if other[key] == destination), default=-1) + 1
        for index, child in enumerate(sorted(children, key=lambda value: value["order"])):
            child[key] = destination
            child["order"] = next_order + index
            if not primary:
                child["revision"] += 1
                child["updatedAt"] = datetime.now(timezone.utc).isoformat()
            self._unique(collection, child, key)

    def image(self, archive_id: str) -> Path:
        with _STORE_LOCK:
            root = self._root()
            archive = self._find(self._read(root)["archives"], archive_id)
            if not archive.get("image"):
                raise GridArchiveError("notFound", 404)
            path = root / "images" / archive["image"]
            if not path.is_file():
                raise GridArchiveError("notFound", 404)
            return path

    def set_image(self, archive_id: str, revision: int, content: bytes | None) -> dict[str, Any]:
        encoded = None
        if content is not None:
            _require(0 < len(content) <= MAX_IMAGE_BYTES, "imageInvalid")
            try:
                with Image.open(io.BytesIO(content)) as source:
                    _require(source.format in ("PNG", "JPEG", "WEBP") and source.width * source.height <= 40_000_000, "imageInvalid")
                    source.load()
                    preview = ImageOps.exif_transpose(source).convert("RGBA")
                    preview.thumbnail((1024, 1024))
                    output = io.BytesIO()
                    preview.save(output, format="WEBP", quality=85)
                    encoded = output.getvalue()
            except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
                raise GridArchiveError("imageInvalid") from error
        with _STORE_LOCK:
            root = self._root()
            data = self._read(root)
            if type(revision) is not int or revision != data["revision"]:
                raise GridArchiveError("conflict", 409)
            archive = self._find(data["archives"], archive_id)
            old = archive.get("image")
            filename = f"{uuid.uuid4().hex}.webp" if encoded else None
            if filename:
                self._atomic_write(root / "images" / filename, encoded)
            archive.update(image=filename, revision=archive["revision"] + 1,
                           updatedAt=datetime.now(timezone.utc).isoformat())
            data["revision"] += 1
            try:
                self._write(root, data)
            except Exception:
                if filename:
                    (root / "images" / filename).unlink(missing_ok=True)
                raise
            if old:
                try:
                    (root / "images" / old).unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove old grid archive preview %s", old)
            return data
