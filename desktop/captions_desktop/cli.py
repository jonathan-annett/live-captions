"""`captions` command-line entry point."""

from __future__ import annotations

import argparse
import threading
import time
from typing import Optional, Sequence

from .hub import CaptionHub
from .web import find_web_dir


def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = argparse.ArgumentParser(prog="captions")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="run the caption server + display")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--model", default="small.en", help="model name or HF repo")
    serve.add_argument(
        "--engine",
        default="auto",
        choices=["auto", "faster-whisper", "mlx"],
        help="ASR backend (auto: MLX on Apple Silicon, else faster-whisper)",
    )
    serve.add_argument("--device", default="auto", help="auto|cpu|cuda (faster-whisper)")
    serve.add_argument("--mic", type=int, default=None, help="input device index")
    serve.add_argument(
        "--refine",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="two-tier refinement (ON by default): a background pass re-decodes "
        "each utterance at higher quality (beam + long-form context) and replaces "
        "it in place. Compute-heavy — use --no-refine to disable.",
    )
    serve.add_argument(
        "--refine-model",
        default="large-v3",
        help="model for the refinement pass (default: large-v3; try large-v3-turbo "
        "for a lighter/faster refine, or match --model to disable the quality jump)",
    )
    serve.add_argument(
        "--refine-engine",
        default=None,
        choices=["auto", "faster-whisper", "mlx"],
        help="ASR backend for the refinement pass (default: --engine)",
    )
    serve.add_argument("--demo", action="store_true", help="mock captions, no audio/ASR")
    serve.add_argument("--web", default=None, help="path to built frontend dir")
    serve.add_argument(
        "--dictionary",
        default=None,
        help="custom terms to bias toward: comma-separated, or @path/to/file",
    )
    serve.add_argument(
        "--publish-url",
        default=None,
        help="CaptionRoom publish URL (token-gated) to relay captions to an "
        "audience room, e.g. wss://v2.caption.guru/r/<id>/publish?token=<tok>",
    )
    serve.add_argument(
        "--start-room",
        default=None,
        metavar="BASE",
        help="create a fresh audience room at this base (e.g. https://v2.caption.guru), "
        "relay captions to it, and show a join QR on the display (in chroma mode)",
    )
    serve.add_argument(
        "--viewer-base",
        default=None,
        metavar="URL",
        help="public base that serves the audience viewer page (default: --start-room "
        "base); the join QR points at <viewer-base>/viewer.html",
    )

    # Display output
    serve.add_argument("--monitor", type=int, default=0, help="monitor index (HDMI out)")
    serve.add_argument("--windowed", action="store_true", help="don't go fullscreen")
    serve.add_argument("--kiosk", action="store_true", help="use Chrome kiosk fallback")
    serve.add_argument("--no-open", action="store_true", help="server only, no window")
    serve.add_argument("--list-monitors", action="store_true", help="list monitors + exit")

    # Background (painted by the page; default solid black suits HDMI capture)
    serve.add_argument(
        "--background", choices=["solid", "chroma", "transparent"], default=None
    )
    serve.add_argument("--bg-color", default=None, help="hex color for solid/chroma")
    serve.add_argument(
        "--caption-region",
        default=None,
        metavar="X,Y,W,H",
        help="operator caption box as percentages of the frame (e.g. 5,70,90,25 "
        "for a lower-thirds band); pairs with --background chroma for keying",
    )

    args = parser.parse_args(argv)
    if args.cmd == "serve":
        _serve(args)


def _serve(args: argparse.Namespace) -> None:
    from .server import build_app
    from .streaming import LiveStreamer, MockProducer
    from . import window

    if args.list_monitors:
        screens = window.list_screens()
        if not screens:
            print("No monitor info (pywebview not installed).")
        for s in screens:
            print(
                f"  [{s['index']}] {s['width']}x{s['height']} @ ({s['x']},{s['y']})"
            )
        return

    hub = CaptionHub()
    _apply_background(hub, args)
    _apply_caption_region(hub, args)

    if args.demo:
        controller = MockProducer(hub)
        engine_desc = "mock (demo)"
    else:
        from .engines import create_engine

        # Factories so the live model can be hot-swapped from the control panel
        # (LiveStreamer.set_model rebuilds the engine via these).
        def make_engine(model: str):
            return create_engine(args.engine, model=model, device=args.device)

        def make_refine_engine(model: str):
            return create_engine(
                args.refine_engine or args.engine, model=model, device=args.device
            )

        engine = make_engine(args.model)
        refiner = None
        refine_model = None
        if args.refine:
            from .refine import RefinementPass

            refine_model = args.refine_model or args.model
            refiner = RefinementPass(hub, make_refine_engine(refine_model))
        controller = LiveStreamer(
            hub,
            engine,
            device=args.mic,
            refiner=refiner,
            make_engine=make_engine,
            make_refine_engine=make_refine_engine,
            model=args.model,
            refine_model=refine_model,
        )
        engine_desc = f"{engine.__class__.__name__} ({args.model})"
        if refiner is not None:
            engine_desc += f" + refine ({refine_model})"

    terms = _parse_dictionary(args.dictionary)
    if terms:
        controller.set_dictionary(terms)

    publish_url = args.publish_url
    join_url = None
    if args.start_room:
        room = _create_room(args.start_room)
        publish_url = room["publishUrl"]
        join_url = _join_url(args.viewer_base or args.start_room, args.start_room, room["id"])
        # Show a join QR on the display (rendered only in chroma-key mode).
        hub.set_config(
            {"qr": {"url": join_url, "x": 72.0, "y": 6.0, "size": 24.0}}
        )

    web_dir = find_web_dir(args.web)
    app = build_app(hub, controller, web_dir=web_dir, room_publish_url=publish_url)

    transparent = args.background == "transparent"
    base = f"http://{args.host}:{args.port}"
    url = f"{base}/?source=ws"

    print("Caption Guru desktop server")
    print(f"  engine:   {engine_desc}")
    print(f"  frontend: {web_dir or '(not built — see / for help)'}")
    print(f"  display:  {url}")
    print(f"  ws:       {base}/ws   history: {base}/history")
    if publish_url:
        print(f"  room:     relaying captions to {publish_url}")
    if join_url:
        print(f"  join:     audience QR → {join_url}")
    if args.caption_region:
        print(f"  caption:  box at {args.caption_region} (% x,y,w,h)")

    if args.no_open:
        import uvicorn

        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
        return

    # Window needs the main thread (esp. macOS), so run uvicorn in a thread.
    server, thread = _run_server_threaded(app, args.host, args.port)
    try:
        if args.kiosk or not window.webview_available():
            if not args.kiosk:
                print("  (pywebview not installed — using Chrome kiosk)")
            proc = window.launch_chrome_kiosk(url, monitor=args.monitor)
            if proc is None:
                print("  No Chrome found. Open the display URL manually.")
            _block_until_interrupt(thread)
            if proc is not None:
                proc.terminate()
        else:
            window.run_webview(
                url,
                fullscreen=not args.windowed,
                monitor=args.monitor,
                transparent=transparent,
            )
    finally:
        server.should_exit = True
        thread.join(timeout=3.0)


def _parse_dictionary(value: Optional[str]) -> list[str]:
    if not value:
        return []
    if value.startswith("@"):
        with open(value[1:], encoding="utf-8") as fh:
            raw = fh.read()
    else:
        raw = value
    return [t.strip() for t in raw.replace("\n", ",").split(",") if t.strip()]


def _apply_background(hub: CaptionHub, args: argparse.Namespace) -> None:
    if not args.background:
        return
    if args.background == "transparent":
        hub.set_config({"background": {"kind": "transparent"}})
    elif args.background == "chroma":
        hub.set_config(
            {"background": {"kind": "chroma", "color": args.bg_color or "#00b140"}}
        )
    else:  # solid
        hub.set_config(
            {"background": {"kind": "solid", "color": args.bg_color or "#000000"}}
        )


def _apply_caption_region(hub: CaptionHub, args: argparse.Namespace) -> None:
    if not args.caption_region:
        return
    try:
        x, y, w, h = (float(p) for p in args.caption_region.split(","))
    except ValueError:
        raise SystemExit(
            "--caption-region must be four numbers: X,Y,W,H (percent of frame)"
        )
    hub.set_config({"region": {"x": x, "y": y, "width": w, "height": h}})


def _join_url(viewer_base: str, room_base: str, room_id: str) -> str:
    """Short audience join URL the QR encodes (the /room page, not the ws socket)."""
    vb = viewer_base.rstrip("/")
    if room_base.rstrip("/") == vb:
        return f"{vb}/room?{room_id}"  # → /room?<id>
    # Room WebSocket on a different host than the viewer page: be explicit.
    from urllib.parse import quote

    return f"{vb}/room?room={room_id}&base=" + quote(room_base.rstrip("/"), safe="")


def _create_room(base: str) -> dict:
    """POST <base>/r/new to mint an audience room; returns the room's URLs."""
    import json
    import urllib.request

    url = base.rstrip("/") + "/r/new"
    req = urllib.request.Request(url, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:  # noqa: BLE001 - surface a clean startup error
        raise SystemExit(f"--start-room: could not create a room at {url}: {exc}")


def _run_server_threaded(app, host: str, port: int):
    import uvicorn

    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started and thread.is_alive():
        time.sleep(0.05)
    return server, thread


def _block_until_interrupt(thread: threading.Thread) -> None:
    try:
        while thread.is_alive():
            thread.join(0.5)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
