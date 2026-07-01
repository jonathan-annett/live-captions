"""FastAPI server: serves the shared frontend, streams captions over a
multi-client WebSocket, and exposes the history endpoint (export in v1,
audience scrollback in v2)."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .export import export_transcript
from .hub import CaptionHub
from .protocol import (
    ControlCommand,
    EditSegmentMessage,
    HistoryMessage,
    RequestHistoryMessage,
    RoomControlMessage,
    SetConfigMessage,
    SetDictionaryMessage,
    SetModelMessage,
    dump_message,
    parse_client_message,
)
from .rooms import RoomManager
from .streaming import Controller


def build_app(
    hub: CaptionHub,
    controller: Controller,
    web_dir: Optional[Path] = None,
    autostart: bool = True,
    room_publish_url: Optional[str] = None,
    room_join_url: Optional[str] = None,
    room_base: Optional[str] = None,
    viewer_base: Optional[str] = None,
    qr_png_path: Optional[str] = None,
) -> FastAPI:
    # Runtime audience-room state (start/stop/restart from the operator panel).
    manager = RoomManager(
        hub, room_base=room_base, viewer_base=viewer_base, qr_png_path=qr_png_path
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        hub.bind_loop(asyncio.get_running_loop())
        if autostart:
            controller.start()
        if room_publish_url:
            from .room_publisher import RoomPublisher

            publisher = RoomPublisher(hub, room_publish_url)
            publisher.start()
            # Adopt the launch-time room so runtime stop/restart can manage it.
            manager.adopt(publisher, room_publish_url, room_join_url)
        yield
        await manager._stop_publisher()
        controller.stop()

    app = FastAPI(title="Caption Guru", lifespan=lifespan)

    @app.get("/history")
    async def history(since: Optional[float] = None) -> JSONResponse:
        segs = hub.history(since)
        return JSONResponse(
            {"segments": [s.model_dump(by_alias=True, exclude_none=True) for s in segs]}
        )

    @app.get("/export")
    async def export(format: str = "txt") -> Response:
        body, mime, filename = export_transcript(hub.history(), format)
        return Response(
            content=body,
            media_type=mime,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.websocket("/ws")
    async def ws(sock: WebSocket) -> None:
        await sock.accept()
        q = hub.subscribe()

        # Catch a freshly connected client up: config + recent history.
        for m in hub.snapshot_for_new_client():
            await sock.send_text(dump_message(m))

        async def reader() -> None:
            try:
                while True:
                    data = await sock.receive_text()
                    _handle_client(hub, controller, data, q, manager)
            except WebSocketDisconnect:
                pass

        async def writer() -> None:
            try:
                while True:
                    msg = await q.get()
                    await sock.send_text(dump_message(msg))
            except (WebSocketDisconnect, RuntimeError):
                pass

        rt = asyncio.create_task(reader())
        wt = asyncio.create_task(writer())
        try:
            _, pending = await asyncio.wait(
                {rt, wt}, return_when=asyncio.FIRST_COMPLETED
            )
            for t in pending:
                t.cancel()
        finally:
            hub.unsubscribe(q)

    if web_dir is not None:
        control_html = Path(web_dir) / "control.html"

        # Operator control / config panel. Convenience alias for /control.html
        # (registered before the catch-all mount so it takes precedence).
        @app.get("/control")
        async def control() -> Response:
            if control_html.is_file():
                return FileResponse(str(control_html))
            return HTMLResponse(
                "<h1>Control panel not built</h1><p>Run "
                "<code>pnpm --filter @captions/display build</code>, then reload.</p>",
                status_code=404,
            )

        # Mounted last so /ws and /history take precedence.
        app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
    else:

        @app.get("/")
        async def root() -> HTMLResponse:
            return HTMLResponse(
                "<h1>Caption Guru server</h1><p>Frontend not built. Run "
                "<code>pnpm --filter @captions/display build</code>, then reload. "
                "WebSocket: <code>/ws</code> · History: <code>/history</code></p>"
            )

    return app


def _handle_client(
    hub: CaptionHub,
    controller: Controller,
    data: str,
    q: "asyncio.Queue",
    manager: Optional[RoomManager] = None,
) -> None:
    try:
        msg = parse_client_message(data)
    except Exception:
        return

    if isinstance(msg, SetConfigMessage):
        hub.set_config(msg.config)
    elif isinstance(msg, ControlCommand):
        if msg.command == "clear":
            hub.clear()
        elif msg.command == "start":
            controller.start()
        elif msg.command == "stop":
            controller.stop()
    elif isinstance(msg, RequestHistoryMessage):
        # Reply only to the requesting client.
        try:
            q.put_nowait(HistoryMessage(segments=hub.history(msg.since)))
        except asyncio.QueueFull:
            pass
    elif isinstance(msg, SetDictionaryMessage):
        controller.set_dictionary(msg.terms)
    elif isinstance(msg, SetModelMessage):
        controller.set_model(msg.model, msg.refine_model)
    elif isinstance(msg, EditSegmentMessage):
        # Operator correction: emit as a final → hub upserts by id (lock-aware),
        # replacing the segment in place and rebroadcasting to display + room.
        hub.emit_final(msg.segment)
    elif isinstance(msg, RoomControlMessage):
        # Runtime room start/stop/restart. Minting does network I/O and toggling
        # the publisher is async, so run it as a task on the ws loop (this handler
        # stays sync for the other, synchronous branches).
        if manager is not None:
            asyncio.create_task(manager.handle(msg.action, msg.qr))
