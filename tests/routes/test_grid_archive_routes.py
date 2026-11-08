from __future__ import annotations

import json
import io
from unittest.mock import AsyncMock, MagicMock

import pytest
from aiohttp import web
from PIL import Image

from py.routes.grid_archive_routes import GridArchiveRoutes
from py.services.grid_archive_service import GridArchiveService


def request(method="GET", path="/api/lm/grid-archives", match=None, payload=None):
    result = MagicMock(method=method, path=path, match_info=match or {}, headers={})
    result.json = AsyncMock(return_value=payload)
    return result


@pytest.mark.asyncio
async def test_library_crud_and_error_statuses(tmp_path):
    routes = GridArchiveRoutes(GridArchiveService(tmp_path / "archives"))
    response = await routes.handle(request())
    assert response.status == 200 and json.loads(response.text)["revision"] == 0
    response = await routes.handle(request("POST", match={"collection": "categories"},
                                          payload={"revision": 0, "name": "Style", "parentId": None}))
    data = json.loads(response.text)
    assert response.status == 200 and data["resultId"]
    response = await routes.handle(request("PATCH", match={"collection": "categories", "id": data["resultId"]},
                                          payload={"revision": 0, "name": "Stale"}))
    assert response.status == 409 and json.loads(response.text)["error"] == "conflict"
    response = await routes.handle(request("POST", match={"collection": "categories"}, payload=[]))
    assert response.status == 400
    response = await routes.handle(request("DELETE", match={"collection": "categories", "id": "missing"}, payload={"revision": 1}))
    assert response.status == 404


@pytest.mark.asyncio
async def test_image_requires_revision_and_missing_image_returns_404(tmp_path):
    routes = GridArchiveRoutes(GridArchiveService(tmp_path))
    response = await routes.handle(request("POST", "/api/lm/grid-archives/archives/a/image", {"id": "a"}))
    assert response.status == 409
    response = await routes.handle(request("GET", "/api/lm/grid-archives/archives/a/image", {"id": "../../a"}))
    assert response.status == 404


def test_routes_register_expected_methods():
    app = web.Application()
    GridArchiveRoutes.setup_routes(app)
    methods = {(route.method, route.resource.canonical) for route in app.router.routes()}
    assert ("GET", "/api/lm/grid-archives") in methods
    assert ("PATCH", "/api/lm/grid-archives/{collection}/{id}") in methods
    assert ("POST", "/api/lm/grid-archives/archives/{id}/image") in methods


@pytest.mark.asyncio
async def test_image_stream_limit_and_valid_upload(tmp_path, monkeypatch):
    from tests.services.test_grid_archive_service import snapshot
    service = GridArchiveService(tmp_path)
    data = service.mutate("archives", "POST", None, {"revision": 0, "name": "Preview", "snapshot": snapshot()})
    identifier = data["resultId"]
    routes = GridArchiveRoutes(service)
    output = io.BytesIO(); Image.new("RGB", (32, 16), "blue").save(output, "PNG")
    async def chunks(size):
        yield output.getvalue()
    req = request("POST", f"/api/lm/grid-archives/archives/{identifier}/image", {"id": identifier})
    req.headers = {"If-Match": "1"}; req.content.iter_chunked = chunks
    response = await routes.handle(req)
    assert response.status == 200 and json.loads(response.text)["archives"][0]["image"]
    monkeypatch.setattr("py.routes.grid_archive_routes.MAX_IMAGE_BYTES", 10)
    response = await routes.handle(req)
    assert response.status == 413
    assert service.list_library()["revision"] == 2
