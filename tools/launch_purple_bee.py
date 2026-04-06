import argparse
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_DIR = PROJECT_ROOT / "app"
LOG_DIR = PROJECT_ROOT / "logs"
PORT = 7860


def ensure_dependencies():
    try:
        import flask  # noqa: F401
        import requests  # noqa: F401
        import bs4  # noqa: F401
    except Exception:
        print("[setup] Installing required Python packages...")
        subprocess.check_call(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "flask",
                "requests",
                "beautifulsoup4",
                "lxml",
            ]
        )


def ping(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status < 500
    except urllib.error.URLError:
        return False
    except Exception:
        return False


def tail_text(path: Path, line_limit: int = 60) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    return "\n".join(lines[-line_limit:])


def start_server(log_path: Path):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(PROJECT_ROOT / "tools" / "run_local_server.py")]
    kwargs = {
        "cwd": str(PROJECT_ROOT),
        "stdout": log_path.open("ab"),
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return subprocess.Popen(command, **kwargs)


def wait_until_ready(health_url: str, timeout_seconds: int = 25) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if ping(health_url):
            return True
        time.sleep(1.5)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("chat", "panel"), required=True)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    ensure_dependencies()

    if args.mode == "chat":
        health_url = f"http://127.0.0.1:{PORT}/"
        open_url = f"http://127.0.0.1:{PORT}/"
        log_path = LOG_DIR / "server.log"
    else:
        health_url = f"http://127.0.0.1:{PORT}/api/model_panel/overview"
        open_url = f"http://127.0.0.1:{PORT}/model-panel"
        log_path = LOG_DIR / "model_panel_server.log"

    print("=" * 58)
    print(f" Purple Bee launcher ({args.mode})")
    print("=" * 58)

    if ping(health_url):
        print("[ok] Existing local server is already responding.")
    else:
        print(f"[run] Starting local server. Log: {log_path}")
        start_server(log_path)
        if not wait_until_ready(health_url):
            print("[error] Local server did not become ready in time.")
            tail = tail_text(log_path)
            if tail:
                print("-" * 58)
                print(tail)
                print("-" * 58)
            raise SystemExit(1)

    print(f"[open] {open_url}")
    if not args.no_browser:
        webbrowser.open(open_url)


if __name__ == "__main__":
    main()
