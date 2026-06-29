from captions_desktop import window
from captions_desktop.cli import main as cli_main


def test_chrome_kiosk_args_shape():
    args = window.chrome_kiosk_args(
        "/path/chrome",
        "http://127.0.0.1:8765/?source=ws",
        position=(1920, 0),
        user_data_dir="/tmp/x",
    )
    assert args[0] == "/path/chrome"
    assert "--app=http://127.0.0.1:8765/?source=ws" in args
    assert "--kiosk" in args
    assert "--window-position=1920,0" in args
    assert "--user-data-dir=/tmp/x" in args


def test_chrome_kiosk_args_omits_optional():
    args = window.chrome_kiosk_args("chrome", "http://x")
    assert not any(a.startswith("--window-position") for a in args)
    assert not any(a.startswith("--user-data-dir") for a in args)


def test_list_screens_safe_without_pywebview():
    # Returns a list (empty if pywebview missing); never raises.
    assert isinstance(window.list_screens(), list)


def test_cli_list_monitors_runs(capsys):
    # Exercises the CLI arg parsing + the list-monitors branch end to end.
    cli_main(["serve", "--list-monitors"])
    out = capsys.readouterr().out
    assert "monitor" in out.lower() or "[" in out
