"""FastAPI server: serves the shared frontend, streams captions over a
multi-client WebSocket, and exposes the history endpoint (export in v1,
audience scrollback in v2)."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .hub import CaptionHub
from .protocol import (
    ControlCommand,
    HistoryMessage,
    RequestHistoryMessage,
    SetConfigMessage,
    SetDictionaryMessage,
    dump_message,
    parse_client_message,
)
from .streaming import Controller


def build_app(
    hub: CaptionHub,
    controller: Controller,
    web_dir: Optional[Path] = None,
    autostart: bool = True,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        hub.bind_loop(asyncio.get_running_loop())
        if autostart:
            controller.start()
        yield
        controller.stop()

    app = FastAPI(title="live-captions", lifespan=lifespan)

    @app.get("/history")
    async def history(since: Optional[float] = None) -> JSONResponse:
        segs = hub.history(since)
        return JSONResponse(
            {"segments": [s.model_dump(by_alias=True, exclude_none=True) for s in segs]}
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
                    _handle_client(hub, controller, data, q)
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
        # Mounted last so /ws and /history take precedence.
        app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
    else:

        @app.get("/")
        async def root() -> HTMLResponse:
            return HTMLResponse(
                "<h1>live-captions server</h1><p>Frontend not built. Run "
                "<code>pnpm --filter @captions/display build</code>, then reload. "
                "WebSocket: <code>/ws</code> · History: <code>/history</code></p>"
            )

    return app


def _handle_client(
    hub: CaptionHub,
    controller: Controller,
    data: str,
    q: "asyncio.Queue",
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
