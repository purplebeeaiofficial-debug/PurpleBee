"""
Upload the current Purple Bee browser package to Hugging Face and refresh
Cloudflare Worker variables.

Usage:
  python cloudflare/hf_upload.py
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from huggingface_hub import HfApi


ROOT = Path(__file__).resolve().parent.parent
CF_DIR = ROOT / "cloudflare"
PKG_DIR = ROOT / "Model" / "versions" / "purple-bee-1-3" / "browser_package"
HF_AUTH = CF_DIR / "hf-auth.local.json"
CF_AUTH = CF_DIR / "cf-auth.local.json"
REPO_NAME = "purple-bee-1-3"
WORKER_NAME = "purple-bee-cloudflare"


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def load_hf_auth() -> tuple[str, str]:
    payload = load_json(HF_AUTH)
    username = str(payload.get("username") or os.environ.get("HF_USER") or "").strip()
    token = str(payload.get("token") or os.environ.get("HF_TOKEN") or "").strip()
    if not username or not token:
        raise RuntimeError(
            "Missing Hugging Face credentials. Fill cloudflare/hf-auth.local.json "
            "or set HF_USER/HF_TOKEN."
        )
    return username, token


def find_browser_artifacts() -> tuple[Path, Path, Path | None]:
    onnx_file = next(iter(sorted(PKG_DIR.glob("*.onnx"))), None)
    onnx_data_file = next(iter(sorted(PKG_DIR.glob("*.onnx.data"))), None)
    tokenizer_file = PKG_DIR / "tokenizer.json"
    if onnx_file is None or not onnx_file.exists():
        raise RuntimeError(f"No ONNX file found in {PKG_DIR}")
    if not tokenizer_file.exists():
        raise RuntimeError(f"Tokenizer file missing: {tokenizer_file}")
    return onnx_file, tokenizer_file, onnx_data_file


def upload_browser_package(
    api: HfApi,
    repo_id: str,
    onnx_file: Path,
    tokenizer_file: Path,
    onnx_data_file: Path | None,
) -> None:
    allow_patterns = [tokenizer_file.name, onnx_file.name]
    if onnx_data_file and onnx_data_file.exists():
        allow_patterns.append(onnx_data_file.name)

    api.upload_folder(
        folder_path=str(PKG_DIR),
        repo_id=repo_id,
        repo_type="model",
        allow_patterns=allow_patterns,
        commit_message="Update Purple Bee browser package",
    )


def update_worker_variables(base_url: str, onnx_name: str, onnx_data_name: str | None) -> None:
    auth = load_json(CF_AUTH)
    cf_token = str(auth.get("api_token") or os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    cf_account = str(auth.get("account_id") or os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    if not cf_token or not cf_account:
        raise RuntimeError("Missing Cloudflare credentials in cloudflare/cf-auth.local.json")

    payload = {
        "bindings": [
            {"type": "assets", "name": "ASSETS"},
            {"type": "plain_text", "name": "PURPLE_BEE_MODEL_PUBLIC_BASE_URL", "text": base_url},
            {"type": "plain_text", "name": "PURPLE_BEE_MODEL_ID", "text": "purple-bee-1-3"},
            {"type": "plain_text", "name": "PURPLE_BEE_MODEL_DISPLAY_NAME", "text": "Purple Bee 1.3"},
            {"type": "plain_text", "name": "PURPLE_BEE_MODEL_ONNX", "text": onnx_name},
            {"type": "plain_text", "name": "PURPLE_BEE_MODEL_TOKENIZER", "text": "tokenizer.json"},
        ]
    }
    if onnx_data_name:
        payload["bindings"].append(
            {"type": "plain_text", "name": "PURPLE_BEE_MODEL_ONNX_DATA", "text": onnx_data_name}
        )

    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{cf_account}/workers/scripts/{WORKER_NAME}/settings",
        data=json.dumps(payload).encode("utf-8"),
        method="PATCH",
        headers={
            "Authorization": f"Bearer {cf_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"[WARN] Cloudflare variable update skipped: HTTP {exc.code} {detail}")
        return

    if not body.get("success"):
        print(f"[WARN] Cloudflare variable update skipped: {body}")


def main() -> None:
    username, token = load_hf_auth()
    onnx_file, tokenizer_file, onnx_data_file = find_browser_artifacts()
    repo_id = f"{username}/{REPO_NAME}"
    base_url = f"https://huggingface.co/{repo_id}/resolve/main"

    api = HfApi(token=token)
    api.create_repo(repo_id, repo_type="model", private=False, exist_ok=True)
    upload_browser_package(api, repo_id, onnx_file, tokenizer_file, onnx_data_file)

    deploy_cfg = {"public_base_url": base_url, "storage": "hf-hub"}
    (CF_DIR / "model-deploy.local.json").write_text(
        json.dumps(deploy_cfg, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    update_worker_variables(base_url, onnx_file.name, onnx_data_file.name if onnx_data_file else None)

    print(
        json.dumps(
            {
                "repo_id": repo_id,
                "base_url": base_url,
                "onnx": onnx_file.name,
                "onnx_data": onnx_data_file.name if onnx_data_file else None,
                "tokenizer": "tokenizer.json",
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
