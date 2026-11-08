"""HTTP interface for the shared grid archive library."""
from __future__ import annotations

import asyncio
import logging

from aiohttp import web

from ..services.errors import GridArchiveError
from ..services.grid_archive_service import GridArchiveService, MAX_IMAGE_BYTES

logger = logging.getLogger(__name__)


class GridArchiveRoutes:
    def __init__(self, service: GridArchiveService | None = None) -> None:
        self.service = service or GridArchiveService()

    @classmethod
    def setup_routes(cls, app: web.Application) -> None:
        routes = cls()
        base = "/api/lm/grid-archives"
        app.router.add_get(base, routes.handle)
        app.router.add_post(base + "/{collection:categories|archives}", routes.handle)
        app.router.add_patch(base + "/{collection:categories|archives}/{id}", routes.handle)
        app.router.add_delete(base + "/{collection:categories|archives}/{id}", routes.handle)
        for method in ("GET", "POST", "DELETE"):
            app.router.add_route(method, base + "/archives/{id}/image", routes.handle)

    async def handle(self, request: web.Request) -> web.StreamResponse:
        try:
            if request.path.endswith("/image"):
                identifier = request.match_info["id"]
                if request.method == "GET":
                    path = await asyncio.to_thread(self.service.image, identifier)
                    return web.FileResponse(path, headers={"Cache-Control": "no-cache"})
                try:
                    revision = int(request.headers.get("If-Match", ""))
                except ValueError:
                    raise GridArchiveError("conflict", 409) from None
                content = None
                if request.method == "POST":
                    chunks = bytearray()
                    async for chunk in request.content.iter_chunked(65536):
                        chunks.extend(chunk)
                        if len(chunks) > MAX_IMAGE_BYTES:
                            raise GridArchiveError("imageInvalid", 413)
                    content = bytes(chunks)
                data = await asyncio.to_thread(self.service.set_image, identifier, revision, content)
            elif request.method == "GET":
                data = await asyncio.to_thread(self.service.list_library)
            else:
                payload = await request.json()
                data = await asyncio.to_thread(self.service.mutate, request.match_info["collection"],
                                               request.method, request.match_info.get("id"), payload)
            return web.json_response(data)
        except GridArchiveError as error:
            return web.json_response({"error": error.code}, status=error.status)
        except (ValueError, TypeError):
            return web.json_response({"error": "invalid"}, status=400)
        except OSError:
            logger.exception("Grid archive storage operation failed")
            return web.json_response({"error": "storage"}, status=500)
