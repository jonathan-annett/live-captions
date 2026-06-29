"""`captions` command-line entry point."""

from __future__ import annotations

import argparse
from typing import Optional, Sequence

from .hub import CaptionHub
from .web import find_web_dir


def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = argparse.ArgumentParser(prog="captions")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="run the caption server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--model", default="base.en", help="faster-whisper model")
    serve.add_argument("--device", default="auto", help="auto|cpu|cuda")
    serve.add_argument("--mic", type=int, default=None, help="input device index")
    serve.add_argument("--demo", action="store_true", help="mock captions, no audio/ASR")
    serve.add_argument("--web", default=None, help="path to built frontend dir")

    args = parser.parse_args(argv)
    if args.cmd == "serve":
        _serve(args)


def _serve(args: argparse.Namespace) -> None:
    import uvicorn

    from .server import build_app
    from .streaming import LiveStreamer, MockProducer

    hub = CaptionHub()
    if args.demo:
        controller = MockProducer(hub)
        engine_desc = "mock (demo)"
    else:
        from .engines.faster_whisper import FasterWhisperEngine

        engine = FasterWhisperEngine(model=args.model, device=args.device)
        controller = LiveStreamer(hub, engine, device=args.mic)
        engine_desc = f"faster-whisper {args.model} ({args.device})"

    web_dir = find_web_dir(args.web)
    app = build_app(hub, controller, web_dir=web_dir)

    base = f"http://{args.host}:{args.port}"
    print("live-captions desktop server")
    print(f"  engine:   {engine_desc}")
    print(f"  frontend: {web_dir or '(not built — see / for help)'}")
    print(f"  display:  {base}/?source=ws")
    print(f"  ws:       {base}/ws   history: {base}/history")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
