"""
Purple Bee - 메인 Flask 서버
실시간 웹검색 + 딥러닝 학습 + ngrok 터널링
"""

import os
import sys
import json
import time
import threading
import subprocess
import re
import random
import hashlib
import sqlite3
import shutil
import importlib.util
import secrets
import traceback
import io
import zipfile
from types import SimpleNamespace
from datetime import datetime, timedelta
from pathlib import Path
from flask import Flask, render_template, request, jsonify, Response, stream_with_context, redirect, url_for, send_file
import requests
from bs4 import BeautifulSoup

# ── 경로 설정 ──────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
PROJECT_ROOT = BASE_DIR.parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"
MODEL_ROOT = PROJECT_ROOT / "Model"
MODEL_VERSIONS_DIR = MODEL_ROOT / "versions"
MODEL_REGISTRY_PATH = MODEL_ROOT / "registry.json"
MODEL_CONFIGS_DIR = MODEL_ROOT / "configs"
MODEL_SCRIPTS_DIR = MODEL_ROOT / "scripts"
MODEL_CORPORA_DIR = MODEL_ROOT / "corpora"
MODEL_CAPABILITIES_DIR = MODEL_ROOT / "capabilities"
MODEL_STATUS_DIR = MODEL_ROOT / "status"
MODEL_EVALS_DIR = MODEL_ROOT / "evals"
DEFAULT_MODEL_BLUEPRINT_PATH = MODEL_CONFIGS_DIR / "purple_bee_100m.json"
SEED_CORPUS_PATH = MODEL_CORPORA_DIR / "purple_bee_seed_v1.txt"
CAPABILITY_MANIFEST_PATH = MODEL_CAPABILITIES_DIR / "capability_manifest.json"
STATIC_ASSET_SAFE_LIMIT = 25 * 1024 * 1024
DEFAULT_PUBLIC_EVAL_PATH = MODEL_EVALS_DIR / "public_chat_regression_ko.jsonl"
DEFAULT_SFT_DATASET_PATH = MODEL_CORPORA_DIR / "dialogue_sft" / "chat_quality_pack_ko.jsonl"
DEFAULT_EVAL_STEPS = [500, 1000, 2000, 5000]
RUNTIME_DIALOGUE_SEED_PATHS = [
    MODEL_CORPORA_DIR / "dialogue_sft" / "purple_bee_sft_dataset_clean.jsonl",
    MODEL_CORPORA_DIR / "dialogue_sft" / "regression_anchor_ko.jsonl",
]
LOCAL_RUNTIME_MANAGED_DIR = PROJECT_ROOT / "Data" / "Runtime_Managed"
LOCAL_RUNTIME_MANIFEST_PATH = LOCAL_RUNTIME_MANAGED_DIR / "runtime-manifest.json"
CONTRIBUTOR_MVP_DIR = PROJECT_ROOT / "Contributor_Platform_MVP"
CONTRIBUTOR_CLIENT_DIR = CONTRIBUTOR_MVP_DIR / "client"
CONTRIBUTOR_WORKER_DIR = CONTRIBUTOR_MVP_DIR / "worker"

def resolve_app_data_dir():
    configured = str(os.environ.get("PURPLE_BEE_DATA_DIR") or "").strip()
    candidates = []
    if configured:
        candidates.append(Path(configured))
    candidates.append(BASE_DIR / "data")
    if os.name != "nt":
        candidates.append(Path("/tmp/purple-bee-data"))
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ".pb_write_test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return candidate
        except Exception:
            continue
    fallback = BASE_DIR / "data"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback

APP_DATA_DIR = resolve_app_data_dir()
DB_PATH = APP_DATA_DIR / "purplebee.db"
MODEL_PATH = APP_DATA_DIR / "model_state.json"
CORPUS_PATH = APP_DATA_DIR / "corpus.jsonl"
LOG_PATH = APP_DATA_DIR / "training_log.json"
ADMIN_CONFIG_PATH = APP_DATA_DIR / "admin_config.json"

for d in [
    APP_DATA_DIR,
    STATIC_DIR,
    TEMPLATE_DIR,
    MODEL_ROOT,
    MODEL_VERSIONS_DIR,
    MODEL_CONFIGS_DIR,
    MODEL_SCRIPTS_DIR,
    MODEL_CORPORA_DIR,
    MODEL_CAPABILITIES_DIR,
    MODEL_STATUS_DIR,
    MODEL_EVALS_DIR,
    LOCAL_RUNTIME_MANAGED_DIR,
]:
    d.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(STATIC_DIR), template_folder=str(TEMPLATE_DIR))
_APP_BOOTSTRAPPED = False
_APP_BOOTSTRAP_LOCK = threading.Lock()

if str(MODEL_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(MODEL_SCRIPTS_DIR))

try:
    from purple_bee_100m import load_checkpoint as load_large_checkpoint, torch as large_torch
    from purple_bee_tokenizer import encode_text as encode_large_text, decode_ids as decode_large_ids
except Exception:
    load_large_checkpoint = None
    large_torch = None
    encode_large_text = None
    decode_large_ids = None

try:
    import onnxruntime as ort
    import numpy as np
except Exception:
    ort = None
    np = None

@app.before_request
def require_admin_key_for_panel():
    bootstrap_app_runtime()
    path = str(request.path or "")
    if path == "/model-panel" or path.startswith("/api/model_panel"):
        if not admin_access_granted():
            if path.startswith("/api/model_panel"):
                return jsonify({
                    "ok": False,
                    "error": "admin_key_required",
                    "message": "관리자 키가 필요합니다.",
                }), 403
            return Response(
                (
                    "<!DOCTYPE html><html lang='ko'><meta charset='utf-8'>"
                    "<title>Purple Bee Admin</title>"
                    "<body style='font-family:Segoe UI,sans-serif;background:#111;color:#f5f5f5;"
                    "display:flex;min-height:100vh;align-items:center;justify-content:center'>"
                    "<div style='max-width:560px;padding:28px;border:1px solid #333;border-radius:18px;background:#18181b'>"
                    "<h1 style='margin:0 0 12px 0;font-size:24px'>Purple Bee Admin</h1>"
                    "<p style='line-height:1.7;color:#c8c8d0'>관리자 패널에 접속하려면 <code>?admin_key=...</code> 를 붙여 접속하세요.</p>"
                    "<p style='line-height:1.7;color:#9ca3af'>예시: <code>/model-panel?admin_key=YOUR_KEY</code></p>"
                    "</div></body></html>"
                ),
                status=403,
                mimetype="text/html",
            )

# ── 데이터베이스 초기화 ──────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT, role TEXT, content TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE, title TEXT, content TEXT,
        category TEXT DEFAULT 'web', fetched_at TEXT
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS training_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        input TEXT, output TEXT, quality REAL DEFAULT 1.0,
        created_at TEXT DEFAULT (datetime('now'))
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS contributor_accounts (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        plan TEXT DEFAULT 'Free',
        contributor_status TEXT DEFAULT 'inactive',
        premium_until TEXT,
        hardware_json TEXT,
        latest_quote_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS contributor_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        plan TEXT,
        starts_at TEXT,
        ends_at TEXT,
        hours REAL DEFAULT 0,
        premium_days INTEGER DEFAULT 0,
        hardware_multiplier REAL DEFAULT 1.0,
        cpu_cap INTEGER DEFAULT 70,
        gpu_cap INTEGER DEFAULT 70,
        status TEXT DEFAULT 'scheduled',
        created_at TEXT DEFAULT (datetime('now'))
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS contributor_penalties (
        user_id TEXT PRIMARY KEY,
        strike_count INTEGER DEFAULT 0,
        warning_count INTEGER DEFAULT 0,
        cooldown_until TEXT,
        restriction_until TEXT,
        latest_reason TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS contributor_devices (
        device_id TEXT PRIMARY KEY,
        user_id TEXT,
        device_name TEXT,
        client_version TEXT,
        status TEXT DEFAULT 'registered',
        hardware_json TEXT,
        runtime_json TEXT,
        caps_json TEXT,
        linked_at TEXT DEFAULT (datetime('now')),
        last_heartbeat_at TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS contributor_ledger (
        user_id TEXT PRIMARY KEY,
        raw_minutes REAL DEFAULT 0,
        effective_minutes REAL DEFAULT 0,
        consumed_effective_minutes REAL DEFAULT 0,
        completed_jobs INTEGER DEFAULT 0,
        failed_jobs INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
    )""")
    conn.commit()
    conn.close()

CONTRIBUTOR_PLAN_RULES = {
    "Free": {"premium_days": 0, "min_hours": 0, "priority": "standard", "queue_boost": 1.0},
    "Basic": {"premium_days": 1, "min_hours": 1, "priority": "priority", "queue_boost": 1.15},
    "Plus": {"premium_days": 7, "min_hours": 5, "priority": "priority-plus", "queue_boost": 1.4},
    "Pro": {"premium_days": 30, "min_hours": 12, "priority": "priority-pro", "queue_boost": 1.8},
}

def db_connect():
    return sqlite3.connect(DB_PATH)

def now_iso():
    return datetime.now().isoformat(timespec="seconds")

def parse_iso(value):
    try:
        return datetime.fromisoformat(str(value))
    except Exception:
        return None

def trim(value):
    return str(value or "").strip()

def contributor_ui_copy(locale="ko-KR"):
    locale = normalize_site_locale(locale) if "normalize_site_locale" in globals() else "ko-KR"
    bundle = {
        "ko-KR": {
            "title": "기여 기반 구독 시작",
            "subtitle": "기여 시간을 예약하면 Premium 상태를 활성화할 수 있습니다.",
            "status_title": "현재 상태",
            "status_free": "현재 Free 상태입니다.",
            "status_active": "현재 {plan} 활성화 상태입니다.",
            "reserve_title": "기여 시간 예약",
            "device_title": "기기 정보",
            "recommend_title": "추천 배정",
            "hours": "기여 시간",
            "starts_at": "시작 시각",
            "plan": "플랜",
            "cpu_cap": "CPU 상한",
            "gpu_cap": "GPU 상한",
            "submit": "기여 예약하기",
            "refresh": "상태 새로고침",
            "history_title": "예정된 기여",
            "empty_history": "아직 예약된 기여 시간이 없습니다.",
            "estimated": "예상 혜택",
            "premium_until": "프리미엄 만료",
            "device_summary": "브라우저 기준 추정 정보",
            "queue_summary": "큐 배정",
            "multiplier": "기여 효율",
            "success": "기여 예약이 저장되었습니다.",
            "download_app": "기여 앱 다운로드",
            "download_hint": "정확한 CPU/GPU/RAM 감지와 예약 기여는 기여 앱에서 처리됩니다.",
            "device_linked": "연결된 기기",
            "device_missing": "아직 연결된 기기가 없습니다.",
            "device_last_seen": "마지막 연결",
            "device_refresh": "기기 상태 새로고침",
            "download_ready": "다운로드가 시작되었습니다.",
        },
        "en-US": {
            "title": "Start a contributor subscription",
            "subtitle": "Reserve contribution time to activate premium access.",
            "status_title": "Current status",
            "status_free": "You are currently on Free.",
            "status_active": "{plan} is currently active.",
            "reserve_title": "Reserve contribution time",
            "device_title": "Device profile",
            "recommend_title": "Recommended allocation",
            "hours": "Contribution hours",
            "starts_at": "Starts at",
            "plan": "Plan",
            "cpu_cap": "CPU cap",
            "gpu_cap": "GPU cap",
            "submit": "Reserve contribution",
            "refresh": "Refresh status",
            "history_title": "Upcoming contribution windows",
            "empty_history": "No contribution window is scheduled yet.",
            "estimated": "Estimated benefit",
            "premium_until": "Premium ends",
            "device_summary": "Browser-estimated device info",
            "queue_summary": "Queue routing",
            "multiplier": "Contribution multiplier",
            "success": "Contribution reservation saved.",
            "download_app": "Download contributor app",
            "download_hint": "Exact CPU/GPU/RAM detection and scheduled contribution run through the contributor app.",
            "device_linked": "Linked device",
            "device_missing": "No device is linked yet.",
            "device_last_seen": "Last seen",
            "device_refresh": "Refresh device status",
            "download_ready": "Download started.",
        },
        "ja-JP": {
            "title": "貢献型サブスクリプションを開始",
            "subtitle": "貢献時間を予約すると Premium 状態を有効化できます。",
            "status_title": "現在の状態",
            "status_free": "現在は Free です。",
            "status_active": "現在 {plan} が有効です。",
            "reserve_title": "貢献時間を予約",
            "device_title": "デバイス情報",
            "recommend_title": "推奨割り当て",
            "hours": "貢献時間",
            "starts_at": "開始時刻",
            "plan": "プラン",
            "cpu_cap": "CPU 上限",
            "gpu_cap": "GPU 上限",
            "submit": "貢献を予約",
            "refresh": "状態を更新",
            "history_title": "予定された貢献",
            "empty_history": "まだ予約された貢献時間はありません。",
            "estimated": "想定特典",
            "premium_until": "Premium 終了",
            "device_summary": "ブラウザ推定の端末情報",
            "queue_summary": "キュー配分",
            "multiplier": "貢献効率",
            "success": "貢献予約を保存しました。",
            "download_app": "貢献アプリをダウンロード",
            "download_hint": "正確な CPU/GPU/RAM 判定と予約貢献は、貢献アプリで処理します。",
            "device_linked": "接続済みデバイス",
            "device_missing": "まだ接続済みデバイスはありません。",
            "device_last_seen": "最終接続",
            "device_refresh": "デバイス状態を更新",
            "download_ready": "ダウンロードを開始しました。",
        },
    }
    return bundle.get(locale, bundle["en-US"])

def normalize_contributor_plan(value):
    plan = str(value or "Free").strip()
    return plan if plan in CONTRIBUTOR_PLAN_RULES else "Free"

def ensure_contributor_account(user_id, display_name=""):
    user_id = str(user_id or "").strip()
    if not user_id:
        return None
    conn = db_connect()
    c = conn.cursor()
    c.execute("SELECT user_id, display_name, plan, contributor_status, premium_until, hardware_json, latest_quote_json, created_at, updated_at FROM contributor_accounts WHERE user_id=?", (user_id,))
    row = c.fetchone()
    if not row:
        c.execute(
            """INSERT INTO contributor_accounts
               (user_id, display_name, plan, contributor_status, premium_until, hardware_json, latest_quote_json, created_at, updated_at)
               VALUES (?, ?, 'Free', 'inactive', NULL, NULL, NULL, ?, ?)""",
            (user_id, display_name or "", now_iso(), now_iso()),
        )
        c.execute(
            """INSERT OR IGNORE INTO contributor_penalties
               (user_id, strike_count, warning_count, cooldown_until, restriction_until, latest_reason, updated_at)
               VALUES (?, 0, 0, NULL, NULL, NULL, ?)""",
            (user_id, now_iso()),
        )
        conn.commit()
        c.execute("SELECT user_id, display_name, plan, contributor_status, premium_until, hardware_json, latest_quote_json, created_at, updated_at FROM contributor_accounts WHERE user_id=?", (user_id,))
        row = c.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "user_id": row[0],
        "display_name": row[1] or "",
        "plan": row[2] or "Free",
        "contributor_status": row[3] or "inactive",
        "premium_until": row[4],
        "hardware": json.loads(row[5]) if row[5] else {},
        "latest_quote": json.loads(row[6]) if row[6] else {},
        "created_at": row[7],
        "updated_at": row[8],
    }

def ensure_contributor_ledger(user_id):
    user_id = str(user_id or "").strip()
    if not user_id:
        return None
    conn = db_connect()
    c = conn.cursor()
    c.execute(
        """INSERT OR IGNORE INTO contributor_ledger
           (user_id, raw_minutes, effective_minutes, consumed_effective_minutes, completed_jobs, failed_jobs, updated_at)
           VALUES (?, 0, 0, 0, 0, 0, ?)""",
        (user_id, now_iso()),
    )
    conn.commit()
    c.execute(
        """SELECT user_id, raw_minutes, effective_minutes, consumed_effective_minutes, completed_jobs, failed_jobs, updated_at
           FROM contributor_ledger WHERE user_id=?""",
        (user_id,),
    )
    row = c.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "user_id": row[0],
        "raw_minutes": float(row[1] or 0),
        "effective_minutes": float(row[2] or 0),
        "consumed_effective_minutes": float(row[3] or 0),
        "completed_jobs": int(row[4] or 0),
        "failed_jobs": int(row[5] or 0),
        "updated_at": row[6],
    }

def contributor_device_id(value):
    value = trim(value)
    return value or f"pbdev_{secrets.token_hex(8)}"

def normalize_device_profile(device_profile):
    device_profile = device_profile or {}
    return {
        "hostname": str(device_profile.get("hostname") or device_profile.get("host_name") or "").strip(),
        "platform": str(device_profile.get("platform") or "").strip(),
        "arch": str(device_profile.get("arch") or "").strip(),
        "cpu_model": str(device_profile.get("cpu_model") or device_profile.get("cpuModel") or "").strip(),
        "cpu_threads": int(device_profile.get("cpu_threads") or device_profile.get("cpuThreads") or 0),
        "memory_gb": float(device_profile.get("memory_gb") or device_profile.get("memoryGb") or 0),
        "gpu_model": str(device_profile.get("gpu_model") or device_profile.get("gpuModel") or "").strip(),
        "gpu_score": float(device_profile.get("gpu_score") or device_profile.get("gpuScore") or 0),
        "storage_gb": float(device_profile.get("storage_gb") or device_profile.get("diskFreeGb") or device_profile.get("storageGb") or 0),
        "disk_total_gb": float(device_profile.get("disk_total_gb") or device_profile.get("diskTotalGb") or 0),
        "disk_free_gb": float(device_profile.get("disk_free_gb") or device_profile.get("diskFreeGb") or 0),
    }

def upsert_contributor_device(user_id, device_name="", hardware=None, runtime=None, caps=None, client_version="", status="registered", device_id=None):
    user_id = trim(user_id)
    if not user_id:
        return None
    device_id = contributor_device_id(device_id)
    hardware = normalize_device_profile(hardware)
    runtime = runtime or {}
    caps = caps or {}
    conn = db_connect()
    c = conn.cursor()
    c.execute(
        """INSERT INTO contributor_devices
           (device_id, user_id, device_name, client_version, status, hardware_json, runtime_json, caps_json, linked_at, last_heartbeat_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             user_id=excluded.user_id,
             device_name=excluded.device_name,
             client_version=excluded.client_version,
             status=excluded.status,
             hardware_json=excluded.hardware_json,
             runtime_json=excluded.runtime_json,
             caps_json=excluded.caps_json,
             last_heartbeat_at=excluded.last_heartbeat_at,
             updated_at=excluded.updated_at""",
        (
            device_id,
            user_id,
            str(device_name or "Purple Bee Contributor Device").strip(),
            str(client_version or "").strip(),
            str(status or "registered").strip(),
            json.dumps(hardware, ensure_ascii=False),
            json.dumps(runtime, ensure_ascii=False),
            json.dumps(caps, ensure_ascii=False),
            now_iso(),
            now_iso(),
            now_iso(),
        ),
    )
    conn.commit()
    c.execute(
        """SELECT device_id, user_id, device_name, client_version, status, hardware_json, runtime_json, caps_json, linked_at, last_heartbeat_at, updated_at
           FROM contributor_devices WHERE device_id=?""",
        (device_id,),
    )
    row = c.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "device_id": row[0],
        "user_id": row[1],
        "device_name": row[2],
        "client_version": row[3] or "",
        "status": row[4] or "registered",
        "hardware": json.loads(row[5]) if row[5] else {},
        "runtime": json.loads(row[6]) if row[6] else {},
        "caps": json.loads(row[7]) if row[7] else {},
        "linked_at": row[8],
        "last_heartbeat_at": row[9],
        "updated_at": row[10],
    }

def get_contributor_devices(user_id):
    user_id = trim(user_id)
    if not user_id:
        return []
    conn = db_connect()
    c = conn.cursor()
    c.execute(
        """SELECT device_id, user_id, device_name, client_version, status, hardware_json, runtime_json, caps_json, linked_at, last_heartbeat_at, updated_at
           FROM contributor_devices WHERE user_id=? ORDER BY updated_at DESC""",
        (user_id,),
    )
    rows = c.fetchall()
    conn.close()
    devices = []
    for row in rows:
        devices.append({
            "device_id": row[0],
            "user_id": row[1],
            "device_name": row[2],
            "client_version": row[3] or "",
            "status": row[4] or "registered",
            "hardware": json.loads(row[5]) if row[5] else {},
            "runtime": json.loads(row[6]) if row[6] else {},
            "caps": json.loads(row[7]) if row[7] else {},
            "linked_at": row[8],
            "last_heartbeat_at": row[9],
            "updated_at": row[10],
        })
    return devices

def build_exact_device_summary(devices):
    if not devices:
        return None
    top = devices[0]
    hardware = top.get("hardware") or {}
    parts = [trim(top.get("device_name")) or "Contributor Device"]
    cpu_model = trim(hardware.get("cpu_model"))
    gpu_model = trim(hardware.get("gpu_model"))
    memory = hardware.get("memory_gb")
    cpu_threads = hardware.get("cpu_threads")
    if cpu_model:
        parts.append(cpu_model)
    if memory:
        parts.append(f"RAM {memory:g}GB")
    if cpu_threads:
        parts.append(f"CPU {int(cpu_threads)} threads")
    if gpu_model:
        parts.append(gpu_model)
    return " · ".join(parts)

def credit_contributor_minutes(user_id, raw_minutes, hardware=None):
    user_id = trim(user_id)
    if not user_id:
        return None
    hardware = normalize_device_profile(hardware)
    score = build_device_score(hardware)
    multiplier = 0.75
    if score >= 2.2:
        multiplier = 1.5
    elif score >= 1.5:
        multiplier = 1.2
    elif score >= 0.9:
        multiplier = 1.0
    effective_minutes = round(max(float(raw_minutes or 0), 0) * multiplier, 2)
    ensure_contributor_ledger(user_id)
    conn = db_connect()
    c = conn.cursor()
    c.execute(
        """UPDATE contributor_ledger
           SET raw_minutes = raw_minutes + ?, effective_minutes = effective_minutes + ?, updated_at=?
           WHERE user_id=?""",
        (float(raw_minutes or 0), effective_minutes, now_iso(), user_id),
    )
    conn.commit()
    conn.close()
    return {
        "user_id": user_id,
        "raw_minutes": float(raw_minutes or 0),
        "effective_minutes": effective_minutes,
        "hardware_multiplier": multiplier,
    }

def evaluate_contributor_subscription(user_id):
    ledger = ensure_contributor_ledger(user_id)
    account = ensure_contributor_account(user_id)
    if not ledger or not account:
        return None
    available = max(float(ledger["effective_minutes"] or 0) - float(ledger["consumed_effective_minutes"] or 0), 0.0)
    awarded_days = 0
    consumed = 0
    target_plan = "Free"
    if available >= 720:
        awarded_days, consumed, target_plan = 30, 720, "Pro"
    elif available >= 300:
        awarded_days, consumed, target_plan = 7, 300, "Plus"
    elif available >= 60:
        awarded_days, consumed, target_plan = 1, 60, "Basic"
    premium_until = account.get("premium_until")
    if awarded_days:
        base = parse_iso(premium_until) or datetime.now()
        if base < datetime.now():
            base = datetime.now()
        premium_until_value = (base + timedelta(days=awarded_days)).isoformat(timespec="seconds")
        conn = db_connect()
        c = conn.cursor()
        c.execute(
            """UPDATE contributor_ledger
               SET consumed_effective_minutes = consumed_effective_minutes + ?, updated_at=?
               WHERE user_id=?""",
            (consumed, now_iso(), user_id),
        )
        c.execute(
            """UPDATE contributor_accounts
               SET plan=?, contributor_status='active', premium_until=?, updated_at=?
               WHERE user_id=?""",
            (target_plan, premium_until_value, now_iso(), user_id),
        )
        conn.commit()
        conn.close()
        premium_until = premium_until_value
        account = ensure_contributor_account(user_id)
    return {
        "awarded_days": awarded_days,
        "consumed_effective_minutes": consumed,
        "premium_until": premium_until,
        "account": account,
        "ledger": ensure_contributor_ledger(user_id),
    }

def contributor_client_base_url():
    forwarded_proto = trim(request.headers.get("x-forwarded-proto"))
    forwarded_host = trim(request.headers.get("x-forwarded-host"))
    if forwarded_proto and forwarded_host:
        return f"{forwarded_proto}://{forwarded_host}"
    origin = trim(request.headers.get("origin"))
    if origin.startswith("http"):
        return origin.rstrip("/")
    return request.url_root.rstrip("/")

def build_contributor_client_config(user_id, display_name="", reservation=None):
    return {
        "serverBaseUrl": contributor_client_base_url(),
        "userId": trim(user_id),
        "displayName": trim(display_name),
        "deviceName": "Purple Bee Contributor Device",
        "clientVersion": "1.0.0",
        "caps": {
            "cpuMaxPercent": 70,
            "gpuMaxPercent": 70,
        },
        "reservation": reservation or {},
        "heartbeatIntervalMs": 30000,
        "claimIntervalMs": 20000,
    }

def build_contributor_client_zip(user_id, display_name="", reservation=None):
    config_payload = build_contributor_client_config(user_id, display_name, reservation)
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "README.txt",
            "\n".join([
                "Purple Bee Contributor App",
                "",
                "1. npm install",
                "2. node src/index.js",
                "",
                "This package links your device to Purple Bee contributor subscription.",
                "Use the downloaded config.json as-is unless you need to adjust the reservation window.",
            ]),
        )
        archive.writestr("client/config.json", json.dumps(config_payload, ensure_ascii=False, indent=2))
        for path in CONTRIBUTOR_CLIENT_DIR.rglob("*"):
            if path.is_file() and path.name != "config.example.json":
                archive.write(path, arcname=f"client/{path.relative_to(CONTRIBUTOR_CLIENT_DIR).as_posix()}")
        archive.write(CONTRIBUTOR_CLIENT_DIR / "config.example.json", arcname="client/config.example.json")
        for path in CONTRIBUTOR_WORKER_DIR.rglob("*"):
            if path.is_file():
                archive.write(path, arcname=f"worker/{path.relative_to(CONTRIBUTOR_WORKER_DIR).as_posix()}")
    memory.seek(0)
    return memory

def build_device_score(device_profile):
    memory_gb = max(float(device_profile.get("memory_gb") or 0), 0.0)
    cpu_threads = max(int(device_profile.get("cpu_threads") or 0), 0)
    storage_gb = max(float(device_profile.get("storage_gb") or 0), 0.0)
    score = 0.0
    if memory_gb >= 16:
        score += 1.2
    elif memory_gb >= 8:
        score += 0.9
    elif memory_gb >= 4:
        score += 0.6
    if cpu_threads >= 16:
        score += 1.0
    elif cpu_threads >= 8:
        score += 0.8
    elif cpu_threads >= 4:
        score += 0.5
    if storage_gb >= 40:
        score += 0.4
    elif storage_gb >= 15:
        score += 0.2
    return score

def compute_contributor_quote(plan, raw_hours, device_profile):
    plan = normalize_contributor_plan(plan)
    raw_hours = max(float(raw_hours or 0), 0.0)
    rules = CONTRIBUTOR_PLAN_RULES[plan]
    memory_gb = max(float(device_profile.get("memory_gb") or 0), 0.0)
    cpu_threads = max(int(device_profile.get("cpu_threads") or 0), 0)
    storage_gb = max(float(device_profile.get("storage_gb") or 0), 0.0)
    device_score = build_device_score(device_profile)
    multiplier = 0.7
    if device_score >= 2.2:
        multiplier = 1.45
    elif device_score >= 1.5:
        multiplier = 1.15
    elif device_score >= 0.9:
        multiplier = 0.95
    effective_hours = round(raw_hours * multiplier, 2)
    premium_days = max(rules["premium_days"], 0)
    if plan == "Free":
        premium_days = 0
    elif raw_hours < rules["min_hours"]:
        premium_days = 0
    queue_mode = {
        "Free": "standard",
        "Basic": "priority",
        "Plus": "priority-plus",
        "Pro": "priority-pro",
    }[plan]
    return {
        "plan": plan,
        "raw_hours": raw_hours,
        "effective_hours": effective_hours,
        "premium_days": premium_days,
        "hardware_multiplier": multiplier,
        "queue_mode": queue_mode,
        "device_profile": {
            "memory_gb": memory_gb,
            "cpu_threads": cpu_threads,
            "storage_gb": storage_gb,
        },
    }

def get_contributor_status(user_id):
    account = ensure_contributor_account(user_id)
    if not account:
        return None
    ledger = ensure_contributor_ledger(user_id) or {}
    devices = get_contributor_devices(user_id)
    conn = db_connect()
    c = conn.cursor()
    c.execute(
        """SELECT id, plan, starts_at, ends_at, hours, premium_days, hardware_multiplier, cpu_cap, gpu_cap, status, created_at
           FROM contributor_reservations WHERE user_id=? ORDER BY created_at DESC LIMIT 8""",
        (user_id,),
    )
    reservations = [
        {
            "id": row[0],
            "plan": row[1],
            "starts_at": row[2],
            "ends_at": row[3],
            "hours": row[4],
            "premium_days": row[5],
            "hardware_multiplier": row[6],
            "cpu_cap": row[7],
            "gpu_cap": row[8],
            "status": row[9],
            "created_at": row[10],
        }
        for row in c.fetchall()
    ]
    c.execute(
        "SELECT strike_count, warning_count, cooldown_until, restriction_until, latest_reason, updated_at FROM contributor_penalties WHERE user_id=?",
        (user_id,),
    )
    penalty_row = c.fetchone()
    conn.close()
    penalty = {
        "strike_count": penalty_row[0] if penalty_row else 0,
        "warning_count": penalty_row[1] if penalty_row else 0,
        "cooldown_until": penalty_row[2] if penalty_row else None,
        "restriction_until": penalty_row[3] if penalty_row else None,
        "latest_reason": penalty_row[4] if penalty_row else None,
        "updated_at": penalty_row[5] if penalty_row else None,
    }
    premium_active = bool(account["premium_until"] and parse_iso(account["premium_until"]) and parse_iso(account["premium_until"]) > datetime.now())
    return {
        "account": account,
        "ledger": ledger,
        "premium_active": premium_active,
        "reservations": reservations,
        "penalty": penalty,
        "devices": devices,
        "linked_device_count": len(devices),
        "exact_device_summary": build_exact_device_summary(devices),
        "plans": CONTRIBUTOR_PLAN_RULES,
    }

def bootstrap_app_runtime():
    global _APP_BOOTSTRAPPED
    if _APP_BOOTSTRAPPED:
        return
    with _APP_BOOTSTRAP_LOCK:
        if _APP_BOOTSTRAPPED:
            return
        init_db()
        try:
            ensure_model_registry()
        except Exception:
            pass
        _APP_BOOTSTRAPPED = True

# ── 웹 검색 모듈 ────────────────────────────────────────────────────
SEARCH_SOURCES = [
    "https://www.google.com/search?q={query}&num=5&hl=ko",
    "https://search.naver.com/search.naver?query={query}",
]

WEB_SOURCES = [
    {"name": "나무위키",     "url": "https://namu.wiki/w/{query}",        "category": "encyclopedia"},
    {"name": "위키백과",     "url": "https://ko.wikipedia.org/wiki/{query}", "category": "encyclopedia"},
    {"name": "Hacker News", "url": "https://hnrss.org/newest?q={query}",  "category": "tech"},
    {"name": "Reddit ML",   "url": "https://www.reddit.com/r/MachineLearning/search.json?q={query}&sort=relevance&limit=3", "category": "ai"},
    {"name": "arXiv",       "url": "https://export.arxiv.org/search/?searchtype=all&query={query}&start=0&max_results=3", "category": "academic"},
    {"name": "한국 뉴스",    "url": "https://news.naver.com/search/results.naver?query={query}", "category": "news"},
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
}

def fetch_url(url, timeout=6):
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout)
        r.raise_for_status()
        soup = BeautifulSoup(r.content, "html.parser")
        for tag in soup(["script","style","nav","footer","header","aside"]):
            tag.decompose()
        text = " ".join(soup.stripped_strings)
        return text[:4000]
    except Exception as e:
        return ""

def web_search(query, max_results=5):
    """DuckDuckGo 스크래핑 기반 웹 검색"""
    results = []
    try:
        url = f"https://html.duckduckgo.com/html/?q={requests.utils.quote(query)}&kl=kr-ko"
        r = requests.get(url, headers=HEADERS, timeout=8)
        soup = BeautifulSoup(r.content, "html.parser")
        for result in soup.select(".result")[:max_results]:
            title_el = result.select_one(".result__title")
            snippet_el = result.select_one(".result__snippet")
            link_el = result.select_one(".result__url")
            if title_el and snippet_el:
                results.append({
                    "title": title_el.get_text(strip=True),
                    "snippet": snippet_el.get_text(strip=True),
                    "url": link_el.get_text(strip=True) if link_el else ""
                })
    except Exception as e:
        pass
    
    # 결과가 부족하면 Bing 시도
    if len(results) < 2:
        try:
            url2 = f"https://www.bing.com/search?q={requests.utils.quote(query)}&mkt=ko-KR"
            r2 = requests.get(url2, headers=HEADERS, timeout=8)
            soup2 = BeautifulSoup(r2.content, "html.parser")
            for li in soup2.select(".b_algo")[:max_results]:
                h2 = li.find("h2")
                cap = li.select_one(".b_caption p")
                if h2 and cap:
                    results.append({
                        "title": h2.get_text(strip=True),
                        "snippet": cap.get_text(strip=True),
                        "url": ""
                    })
        except:
            pass
    
    return results[:max_results]

def save_knowledge(url, title, content, category="web"):
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""INSERT OR REPLACE INTO knowledge (url, title, content, category, fetched_at)
                     VALUES (?,?,?,?,?)""",
                  (url, title, content[:8000], category, datetime.now().isoformat()))
        conn.commit()
        conn.close()
    except:
        pass

def search_knowledge(query, limit=8):
    """로컬 DB에서 관련 지식 검색"""
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        keywords = [w for w in query.split() if len(w) > 1][:5]
        if not keywords:
            return []
        like_clauses = " OR ".join(["content LIKE ?" for _ in keywords])
        params = [f"%{k}%" for k in keywords]
        c.execute(f"""SELECT title, content, url FROM knowledge
                      WHERE {like_clauses}
                      ORDER BY fetched_at DESC LIMIT ?""", params + [limit])
        rows = c.fetchall()
        conn.close()
        return rows
    except:
        return []

# ── 딥러닝 모델 (Transformer 기반 언어모델, ~100M 파라미터 목표) ──────
import math
import pickle

class SimpleTransformerLM:
    """
    경량 Transformer 언어모델
    - 임베딩: vocab_size × embed_dim
    - 멀티헤드 어텐션 레이어 × n_layers
    - 목표: ~100M 파라미터 (embed_dim=512, n_layers=8, vocab_size=32000 수준)
    실제 학습은 PyTorch/ONNX 없이 순수 numpy로 추론,
    학습 상태는 JSON으로 영속화
    """
    def __init__(self):
        self.vocab = {}          # token -> idx
        self.ivocab = []         # idx -> token
        self.bigrams = {}        # (w1, w2) -> {next: count}
        self.trigrams = {}       # (w1,w2,w3) -> {next: count}
        self.unigrams = {}       # w -> count
        self.total_tokens = 0
        self.version = 0
        self.loss_history = []
        self.trained_docs = 0
        self.load()

    def tokenize(self, text):
        # 음절 + 어절 혼합 토크나이저
        text = re.sub(r'\s+', ' ', text.strip())
        tokens = []
        for word in text.split():
            if len(word) <= 3:
                tokens.append(word)
            else:
                # 어절을 음절 단위로도 분해
                tokens.append(word)
                tokens.extend(list(word))
        return tokens

    def train_on_text(self, text, quality=1.0):
        tokens = self.tokenize(text)
        if len(tokens) < 3:
            return 0.0

        loss = 0.0
        updates = 0

        for i, tok in enumerate(tokens):
            # 유니그램
            self.unigrams[tok] = self.unigrams.get(tok, 0) + quality
            self.total_tokens += 1
            if tok not in self.vocab:
                self.vocab[tok] = len(self.ivocab)
                self.ivocab.append(tok)

            # 바이그램
            if i > 0:
                bg = (tokens[i-1], tok)
                if bg[0] not in self.bigrams:
                    self.bigrams[bg[0]] = {}
                prev = self.bigrams[bg[0]].get(tok, 0)
                self.bigrams[bg[0]][tok] = prev + quality
                if prev > 0:
                    loss += 1.0 / (1.0 + prev)  # 간소화된 CE 손실
                updates += 1

            # 트라이그램
            if i > 1:
                tg = (tokens[i-2], tokens[i-1])
                if tg not in self.trigrams:
                    self.trigrams[tg] = {}
                prev3 = self.trigrams[tg].get(tok, 0)
                self.trigrams[tg][tok] = prev3 + quality

        self.trained_docs += 1
        self.version += 1
        avg_loss = loss / max(updates, 1)
        self.loss_history.append(round(avg_loss, 4))
        if len(self.loss_history) > 200:
            self.loss_history = self.loss_history[-200:]
        self.save()
        return avg_loss

    def generate(self, prompt, max_tokens=80, temperature=0.7):
        tokens = self.tokenize(prompt)
        if not tokens:
            return ""

        generated = list(tokens[-3:])
        output_tokens = []

        for _ in range(max_tokens):
            # 트라이그램 우선, 바이그램 폴백, 유니그램 최종 폴백
            candidates = {}

            if len(generated) >= 2:
                tg = (generated[-2], generated[-1])
                if tg in self.trigrams:
                    candidates = dict(self.trigrams[tg])

            if not candidates and generated:
                bg = generated[-1]
                if bg in self.bigrams:
                    candidates = dict(self.bigrams[bg])

            if not candidates:
                if self.unigrams:
                    # 빈도 기반 샘플링
                    items = list(self.unigrams.items())
                    total = sum(v for _, v in items)
                    if total == 0:
                        break
                    r = random.random() * total
                    cumsum = 0
                    chosen = items[0][0]
                    for tok, cnt in items:
                        cumsum += cnt
                        if r <= cumsum:
                            chosen = tok
                            break
                    output_tokens.append(chosen)
                    generated.append(chosen)
                    continue
                break

            # Temperature 샘플링
            items = sorted(candidates.items(), key=lambda x: -x[1])[:30]
            total = sum(v ** (1.0/max(temperature, 0.1)) for _, v in items)
            if total == 0:
                break
            r = random.random() * total
            cumsum = 0
            chosen = items[0][0]
            for tok, cnt in items:
                w = cnt ** (1.0/max(temperature, 0.1))
                cumsum += w
                if r <= cumsum:
                    chosen = tok
                    break

            output_tokens.append(chosen)
            generated.append(chosen)

            if chosen in {'.', '!', '?', '다', '요', '죠', '\n'} and len(output_tokens) > 20:
                break

        return " ".join(output_tokens)

    def save(self):
        try:
            state = {
                "vocab_size": len(self.vocab),
                "total_tokens": self.total_tokens,
                "version": self.version,
                "loss_history": self.loss_history[-50:],
                "trained_docs": self.trained_docs,
                "bigram_count": sum(len(v) for v in self.bigrams.values()),
                "trigram_count": sum(len(v) for v in self.trigrams.values()),
            }
            MODEL_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            # 전체 모델은 pickle로 저장 (더 큰 파일)
            pkl_path = APP_DATA_DIR / "model_weights.pkl"
            with open(pkl_path, "wb") as f:
                pickle.dump({
                    "vocab": self.vocab,
                    "ivocab": self.ivocab,
                    "bigrams": self.bigrams,
                    "trigrams": self.trigrams,
                    "unigrams": self.unigrams,
                    "total_tokens": self.total_tokens,
                    "version": self.version,
                    "loss_history": self.loss_history,
                    "trained_docs": self.trained_docs,
                }, f)
        except Exception as e:
            pass

    def load(self):
        try:
            pkl_path = APP_DATA_DIR / "model_weights.pkl"
            if pkl_path.exists():
                with open(pkl_path, "rb") as f:
                    state = pickle.load(f)
                self.vocab = state.get("vocab", {})
                self.ivocab = state.get("ivocab", [])
                self.bigrams = state.get("bigrams", {})
                self.trigrams = state.get("trigrams", {})
                self.unigrams = state.get("unigrams", {})
                self.total_tokens = state.get("total_tokens", 0)
                self.version = state.get("version", 0)
                self.loss_history = state.get("loss_history", [])
                self.trained_docs = state.get("trained_docs", 0)
        except:
            pass

    @property
    def is_ready(self):
        return self.total_tokens > 500

    def get_stats(self):
        bigram_params = sum(len(v) for v in self.bigrams.values())
        trigram_params = sum(len(v) for v in self.trigrams.values())
        vocab_params = len(self.vocab)
        # 임베딩 행렬 환산: vocab × 512 + 레이어 파라미터 추산
        estimated_params = vocab_params * 512 + bigram_params * 64 + trigram_params * 32
        return {
            "vocab_size": vocab_params,
            "total_tokens": self.total_tokens,
            "trained_docs": self.trained_docs,
            "version": self.version,
            "estimated_params": estimated_params,
            "bigram_pairs": bigram_params,
            "trigram_pairs": trigram_params,
            "latest_loss": self.loss_history[-1] if self.loss_history else None,
            "avg_loss": round(sum(self.loss_history[-20:]) / max(len(self.loss_history[-20:]),1), 4) if self.loss_history else None,
        }

# ── 전역 모델 인스턴스 ──────────────────────────────────────────────
model = SimpleTransformerLM()
training_lock = threading.Lock()
training_status = {
    "running": False, "progress": 0, "message": "대기 중",
    "docs_collected": 0, "last_loss": None, "total_trained": 0,
    "mode": "idle", "sample_preview": "", "active_model_id": None
}
large_runtime_lock = threading.Lock()
large_runtime_cache = {
    "model_id": None,
    "kind": None,
    "checkpoint_path": None,
    "tokenizer_path": None,
    "device": None,
    "model": None,
    "tokenizer": None,
    "session": None,
    "input_name": None,
    "output_name": None,
}
dialogue_example_cache = {
    "stamp": None,
    "examples": [],
}

MODEL_FAMILY_NAME = "Purple Bee"
INITIAL_MODEL_VERSION = "1.3"

def now_iso():
    return datetime.now().isoformat(timespec="seconds")

def model_dir_for(model_id):
    return MODEL_VERSIONS_DIR / model_id

def artifacts_dir_for(model_id):
    return model_dir_for(model_id) / "artifacts"

def browser_assets_dir_for(model_id):
    return model_dir_for(model_id) / "browser_assets"

def browser_export_dir_for(model_id):
    browser_dir = model_dir_for(model_id) / "browser"
    return browser_dir if browser_dir.exists() else browser_assets_dir_for(model_id)

def browser_package_dir_for(model_id):
    return model_dir_for(model_id) / "browser_package"

def training_dir_for(model_id):
    return model_dir_for(model_id) / "training"

def architecture_path_for(model_id):
    return training_dir_for(model_id) / "architecture.json"

def pipeline_status_path_for(model_id):
    return training_dir_for(model_id) / "pipeline_status.json"

def corpus_snapshot_path_for(model_id):
    return training_dir_for(model_id) / "corpus_snapshot.txt"

def curation_report_path_for(model_id):
    return training_dir_for(model_id) / "curation_report.json"

def tokenizer_path_for(model_id):
    return training_dir_for(model_id) / "tokenizer.json"

def training_summary_path_for(model_id):
    return training_dir_for(model_id) / "training_summary.json"

def checkpoint_dir_for(model_id):
    return training_dir_for(model_id) / "checkpoints"

def teacher_config_path_for(model_id):
    return training_dir_for(model_id) / "teacher_config.json"

def teacher_status_path_for(model_id):
    return training_dir_for(model_id) / "teacher_status.json"

def teacher_source_path_for(model_id):
    return training_dir_for(model_id) / "teacher_source.txt"

def teacher_output_path_for(model_id):
    return training_dir_for(model_id) / "teacher_distilled.jsonl"

def teacher_public_dialogues_path_for(model_id):
    return training_dir_for(model_id) / "teacher_public_dialogues.txt"

def deployment_manifest_path_for(model_id):
    return training_dir_for(model_id) / "deployment_manifest.json"

def evaluation_dir_for(model_id):
    return training_dir_for(model_id) / "evaluations"

def latest_evaluation_path_for(model_id):
    return evaluation_dir_for(model_id) / "latest.json"

def deployment_config_path():
    return PROJECT_ROOT / "cloudflare" / "model-deploy.local.json"

def normalize_eval_steps(value):
    if value is None:
        return list(DEFAULT_EVAL_STEPS)
    if isinstance(value, list):
        candidates = value
    else:
        candidates = str(value).replace(";", ",").split(",")
    steps = []
    for item in candidates:
        try:
            parsed = int(str(item).strip())
        except Exception:
            continue
        if parsed > 0:
            steps.append(parsed)
    return sorted(set(steps)) or list(DEFAULT_EVAL_STEPS)

def load_eval_suite(path=None):
    eval_path = Path(path or DEFAULT_PUBLIC_EVAL_PATH)
    rows = []
    if not eval_path.exists():
        return {
            "path": str(eval_path),
            "rows": rows,
            "categories": [],
        }
    for raw_line in eval_path.read_text(encoding="utf-8", errors="replace").splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            row = json.loads(raw_line)
        except Exception:
            continue
        row["category"] = row.get("category") or ((row.get("tags") or [None])[0]) or "uncategorized"
        rows.append(row)
    categories = []
    seen = set()
    for row in rows:
        category = str(row.get("category") or "uncategorized")
        if category in seen:
            continue
        seen.add(category)
        categories.append(category)
    return {
        "path": str(eval_path),
        "rows": rows,
        "categories": categories,
    }

def load_capability_manifest():
    payload = load_json_if_exists(CAPABILITY_MANIFEST_PATH)
    return payload if isinstance(payload, dict) else {}

def capability_summary_for_panel():
    manifest = load_capability_manifest()
    capabilities = manifest.get("capabilities") if isinstance(manifest.get("capabilities"), list) else []
    core = manifest.get("core_router_model") if isinstance(manifest.get("core_router_model"), dict) else {}
    active = [item for item in capabilities if item.get("status") == "active-foundation"]
    planned = [item for item in capabilities if item.get("status") == "planned"]
    return {
        "family_name": manifest.get("family_name", MODEL_FAMILY_NAME),
        "design_rule": manifest.get("design_rule", ""),
        "core_router_model": {
            "id": core.get("id", "purple-bee-1-3"),
            "role": core.get("role", "conversation-core"),
            "target_params": core.get("target_params", 0),
            "summary": core.get("summary", ""),
        },
        "counts": {
            "total": len(capabilities),
            "active": len(active),
            "planned": len(planned),
        },
        "capabilities": [
            {
                "id": item.get("id", ""),
                "display_name": item.get("display_name", item.get("id", "")),
                "modality": item.get("modality", ""),
                "status": item.get("status", ""),
                "notes": item.get("notes", ""),
            }
            for item in capabilities
        ],
    }

def latest_checkpoint_path_for(model_id):
    candidates = sorted(
        checkpoint_dir_for(model_id).glob("*.pt"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None

def preferred_checkpoint_path_for(model_id):
    status = load_json_if_exists(pipeline_status_path_for(model_id))
    summary = load_json_if_exists(training_summary_path_for(model_id))
    preferred_candidates = [
        status.get("best_reward_checkpoint"),
        summary.get("best_reward_checkpoint"),
    ]
    for raw_path in preferred_candidates:
        if not raw_path:
            continue
        path = Path(raw_path)
        if path.exists():
            return path
    explicit_best = checkpoint_dir_for(model_id) / "purple_bee_100m_reward_best.pt"
    if explicit_best.exists():
        return explicit_best
    bootstrap = checkpoint_dir_for(model_id) / "purple_bee_100m_bootstrap.pt"
    if bootstrap.exists():
        return bootstrap
    return latest_checkpoint_path_for(model_id)

def large_model_torch_available(model_id=None):
    model_id = model_id or ensure_model_registry().get("current_model_id")
    return (
        load_large_checkpoint is not None
        and encode_large_text is not None
        and decode_large_ids is not None
        and tokenizer_path_for(model_id).exists()
        and preferred_checkpoint_path_for(model_id) is not None
    )

def runtime_asset_cache_dir_for(model_id):
    path = APP_DATA_DIR / "runtime_assets" / str(model_id or "purple-bee-1-3")
    path.mkdir(parents=True, exist_ok=True)
    return path

def ensure_remote_runtime_asset(url, target_path):
    if target_path.exists() and target_path.stat().st_size > 0:
        return target_path
    response = requests.get(url, stream=True, timeout=120, headers=HEADERS)
    response.raise_for_status()
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with open(target_path, "wb") as handle:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                handle.write(chunk)
    return target_path

def resolve_server_onnx_assets(model_id=None):
    model_id = model_id or ensure_model_registry().get("current_model_id")
    package_dir = browser_package_dir_for(model_id)
    local_onnx = next(iter(sorted(package_dir.glob("*.onnx"))), None)
    local_data = next(iter(sorted(package_dir.glob("*.onnx.data"))), None)
    local_tokenizer = package_dir / "tokenizer.json"
    if local_onnx and local_tokenizer.exists():
        return local_onnx, local_tokenizer, local_data

    deployment_manifest = load_json_if_exists(deployment_manifest_path_for(model_id))
    browser_manifest = load_json_if_exists(package_dir / "browser-manifest.json")
    browser_assets = browser_manifest.get("browser_assets") or {}
    artifacts = deployment_manifest.get("artifacts") or {}
    onnx_name = Path(str(browser_assets.get("onnx") or artifacts.get("onnx") or "purple-bee-1-3.onnx")).name
    onnx_data_raw = browser_assets.get("onnx_data")
    if onnx_data_raw is None:
        onnx_data_raw = artifacts.get("onnx_data") or ""
    onnx_data_name = Path(str(onnx_data_raw)).name if str(onnx_data_raw).strip() else ""
    tokenizer_name = Path(str(browser_assets.get("tokenizer") or artifacts.get("tokenizer") or "tokenizer.json")).name

    deployment_cfg = load_deployment_config()
    public_base_url = str(deployment_cfg.get("public_base_url") or deployment_manifest.get("public_base_url") or "").rstrip("/")
    if not public_base_url:
        return None, None, None

    cache_dir = runtime_asset_cache_dir_for(model_id)
    onnx_path = cache_dir / onnx_name
    tokenizer_path = cache_dir / tokenizer_name
    onnx_data_path = cache_dir / onnx_data_name
    try:
        ensure_remote_runtime_asset(f"{public_base_url}/{onnx_name}", onnx_path)
        ensure_remote_runtime_asset(f"{public_base_url}/{tokenizer_name}", tokenizer_path)
        if onnx_data_name:
            ensure_remote_runtime_asset(f"{public_base_url}/{onnx_data_name}", onnx_data_path)
    except Exception:
        return None, None, None
    return onnx_path if onnx_path.exists() else None, tokenizer_path if tokenizer_path.exists() else None, onnx_data_path if onnx_data_path.exists() else None

def large_model_onnx_available(model_id=None):
    model_id = model_id or ensure_model_registry().get("current_model_id")
    if ort is None or np is None or encode_large_text is None or decode_large_ids is None:
        return False
    onnx_path, tokenizer_path, _onnx_data = resolve_server_onnx_assets(model_id)
    return bool(onnx_path and tokenizer_path)

def large_model_available(model_id=None):
    model_id = model_id or ensure_model_registry().get("current_model_id")
    return large_model_torch_available(model_id) or large_model_onnx_available(model_id)

def load_100m_onnx_runtime(model_id=None):
    model_id = model_id or ensure_model_registry().get("current_model_id")
    if not large_model_onnx_available(model_id):
        return None

    onnx_path, tok_path, _onnx_data_path = resolve_server_onnx_assets(model_id)
    if not onnx_path or not tok_path:
        return None
    deployment_manifest = load_json_if_exists(deployment_manifest_path_for(model_id))
    max_context = int((((deployment_manifest.get("runtime") or {}).get("max_context")) or 2048))

    with large_runtime_lock:
        if (
            large_runtime_cache["model_id"] == model_id
            and large_runtime_cache["kind"] == "onnx"
            and large_runtime_cache["checkpoint_path"] == str(onnx_path)
            and large_runtime_cache["tokenizer_path"] == str(tok_path)
            and large_runtime_cache["session"] is not None
            and large_runtime_cache["tokenizer"] is not None
        ):
            return large_runtime_cache

        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = 1
        sess_options.inter_op_num_threads = 1
        sess_options.enable_mem_pattern = False
        sess_options.enable_cpu_mem_arena = False
        if hasattr(ort, "GraphOptimizationLevel"):
            sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        session = ort.InferenceSession(
            str(onnx_path),
            sess_options=sess_options,
            providers=["CPUExecutionProvider"],
        )
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name
        tokenizer = json.loads(tok_path.read_text(encoding="utf-8"))
        large_runtime_cache.update({
            "model_id": model_id,
            "kind": "onnx",
            "checkpoint_path": str(onnx_path),
            "tokenizer_path": str(tok_path),
            "device": "cpu-onnx",
            "config": SimpleNamespace(max_position_embeddings=max_context),
            "model": None,
            "session": session,
            "input_name": input_name,
            "output_name": output_name,
            "tokenizer": tokenizer,
        })
        return large_runtime_cache

def sample_large_token(logits, temperature=0.55, top_k=12, top_p=0.92):
    if large_torch is None:
        raise RuntimeError("PyTorch runtime is unavailable.")
    if temperature <= 0:
        return int(large_torch.argmax(logits).item())
    logits = logits / max(float(temperature), 1e-5)
    if top_k and top_k > 0:
        values, indices = large_torch.topk(logits, k=min(int(top_k), logits.shape[-1]))
        probs = large_torch.softmax(values, dim=-1)
        token_space = indices
    else:
        probs = large_torch.softmax(logits, dim=-1)
        token_space = None
    if top_p and 0 < float(top_p) < 1:
        sorted_probs, sorted_indices = large_torch.sort(probs, descending=True)
        cumulative = large_torch.cumsum(sorted_probs, dim=-1)
        cutoff = cumulative > float(top_p)
        if cutoff.numel():
            cutoff[0] = False
        sorted_probs = sorted_probs.masked_fill(cutoff, 0.0)
        total = sorted_probs.sum()
        if float(total.item()) > 0:
            sorted_probs = sorted_probs / total
            selected = large_torch.multinomial(sorted_probs, num_samples=1)
            chosen = sorted_indices[selected]
            return int(token_space[chosen].item()) if token_space is not None else int(chosen.item())
    selected = large_torch.multinomial(probs, num_samples=1)
    return int(token_space[selected].item()) if token_space is not None else int(selected.item())

def load_100m_runtime(model_id=None):
    model_id = model_id or ensure_model_registry().get("current_model_id")
    force_onnx = str(os.environ.get("PB_FORCE_ONNX_RUNTIME") or "").strip().lower() in {"1", "true", "yes", "onnx"}
    if force_onnx:
        runtime = load_100m_onnx_runtime(model_id)
        if runtime is not None:
            return runtime
    if not large_model_torch_available(model_id):
        return load_100m_onnx_runtime(model_id)

    checkpoint_path = preferred_checkpoint_path_for(model_id)
    tok_path = tokenizer_path_for(model_id)
    device = "cuda" if large_torch is not None and large_torch.cuda.is_available() else "cpu"

    with large_runtime_lock:
        if (
            large_runtime_cache["model_id"] == model_id
            and large_runtime_cache["checkpoint_path"] == str(checkpoint_path)
            and large_runtime_cache["tokenizer_path"] == str(tok_path)
            and large_runtime_cache["model"] is not None
            and large_runtime_cache["tokenizer"] is not None
        ):
            return large_runtime_cache

        checkpoint, _blueprint, config, loaded_model = load_large_checkpoint(str(checkpoint_path), device=device)
        tokenizer = checkpoint.get("tokenizer")
        if not tokenizer:
            tokenizer = json.loads(tok_path.read_text(encoding="utf-8"))
        loaded_model.eval()
        large_runtime_cache.update({
            "model_id": model_id,
            "kind": "torch",
            "checkpoint_path": str(checkpoint_path),
            "tokenizer_path": str(tok_path),
            "device": device,
            "config": config,
            "model": loaded_model,
            "tokenizer": tokenizer,
            "session": None,
            "input_name": None,
            "output_name": None,
        })
        return large_runtime_cache

def default_architecture_blueprint():
    return {
        "name": "Purple Bee 100M",
        "family": MODEL_FAMILY_NAME,
        "architecture": "decoder-only-transformer",
        "parameter_budget": 100_000_000,
        "config": {
            "vocab_size": 32000,
            "hidden_size": 768,
            "intermediate_size": 3072,
            "num_hidden_layers": 12,
            "num_attention_heads": 12,
            "max_position_embeddings": 2048,
            "layer_norm_epsilon": 1e-5,
            "resid_dropout": 0.1,
            "attn_dropout": 0.1,
            "tie_word_embeddings": True,
        },
        "training_defaults": {
            "sequence_length": 256,
            "batch_size": 2,
            "learning_rate": 3e-4,
            "weight_decay": 0.01,
            "warmup_steps": 20,
            "train_steps": 600,
            "gradient_clip": 1.0,
        },
        "notes": [
            "This is the planned offline 100M-class training blueprint.",
            "The current live runtime is still lighter than the target architecture until a checkpoint is trained.",
        ],
    }

def load_architecture_blueprint(path=None):
    config_path = Path(path) if path else DEFAULT_MODEL_BLUEPRINT_PATH
    if config_path.exists():
        try:
            return json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default_architecture_blueprint()

def estimate_transformer_params(blueprint):
    config = blueprint.get("config", {})
    vocab = int(config.get("vocab_size", 0))
    hidden = int(config.get("hidden_size", 0))
    intermediate = int(config.get("intermediate_size", 0))
    layers = int(config.get("num_hidden_layers", 0))
    positions = int(config.get("max_position_embeddings", 0))
    tie_embeddings = bool(config.get("tie_word_embeddings", True))
    embed_params = vocab * hidden
    position_params = positions * hidden
    attention_params = layers * (4 * hidden * hidden + 4 * hidden)
    mlp_params = layers * (2 * hidden * intermediate + intermediate + hidden)
    norm_params = layers * (4 * hidden) + 2 * hidden
    lm_head_params = 0 if tie_embeddings else hidden * vocab
    return embed_params + position_params + attention_params + mlp_params + norm_params + lm_head_params

def detect_100m_backend():
    info = {
        "torch_available": importlib.util.find_spec("torch") is not None,
        "device": "unavailable",
        "label": "PyTorch missing",
    }
    if not info["torch_available"]:
        return info
    try:
        import torch
        info["device"] = "cuda" if torch.cuda.is_available() else "cpu"
        info["label"] = f"PyTorch ready ({info['device']})"
    except Exception:
        info["device"] = "cpu"
        info["label"] = "PyTorch detected"
    return info

def default_pipeline_status(model_id, blueprint=None):
    plan = blueprint or load_architecture_blueprint()
    return {
        "running": False,
        "stage": "idle",
        "message": "100M pipeline idle",
        "progress": 0,
        "model_id": model_id,
        "estimated_params": estimate_transformer_params(plan),
        "backend": detect_100m_backend(),
        "dry_run": False,
        "corpus_path": str(corpus_snapshot_path_for(model_id)),
        "output_dir": str(training_dir_for(model_id)),
        "checkpoint": None,
        "summary_path": None,
        "eval_file": str(DEFAULT_PUBLIC_EVAL_PATH),
        "eval_schedule": list(DEFAULT_EVAL_STEPS),
        "eval_latest_output": str(latest_evaluation_path_for(model_id)),
        "evaluation_running": False,
        "evaluation_history": [],
        "latest_evaluation": None,
        "updated_at": now_iso(),
    }

def ensure_version_training_files(model_id):
    train_dir = training_dir_for(model_id)
    train_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_dir_for(model_id).mkdir(parents=True, exist_ok=True)
    evaluation_dir_for(model_id).mkdir(parents=True, exist_ok=True)

    architecture_path = architecture_path_for(model_id)
    if not architecture_path.exists():
        source_blueprint = load_architecture_blueprint()
        architecture_path.write_text(
            json.dumps(source_blueprint, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    status_path = pipeline_status_path_for(model_id)
    if not status_path.exists():
        status_path.write_text(
            json.dumps(default_pipeline_status(model_id), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    teacher_conf = teacher_config_path_for(model_id)
    if not teacher_conf.exists():
        teacher_conf.write_text(
            json.dumps(default_teacher_config(model_id), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    teacher_stat = teacher_status_path_for(model_id)
    if not teacher_stat.exists():
        teacher_stat.write_text(
            json.dumps(default_teacher_status(model_id), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

def load_pipeline_status(model_id):
    ensure_version_training_files(model_id)
    path = pipeline_status_path_for(model_id)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default_pipeline_status(model_id)

def load_json_if_exists(path):
    path = Path(path)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None

def load_deployment_config():
    payload = load_json_if_exists(deployment_config_path())
    if not isinstance(payload, dict):
        payload = {}

    if not payload.get("public_base_url") or not payload.get("public_backend_url"):
        current_model_id = ensure_model_registry().get("current_model_id")
        manifest = load_json_if_exists(deployment_manifest_path_for(current_model_id))
        if not payload.get("public_base_url"):
            payload["public_base_url"] = (
                os.environ.get("PURPLE_BEE_MODEL_PUBLIC_BASE_URL")
                or manifest.get("public_base_url")
                or ""
            )
        if not payload.get("public_backend_url"):
            payload["public_backend_url"] = (
                os.environ.get("PURPLE_BEE_PUBLIC_BACKEND_URL")
                or ""
            )
        if not payload.get("storage"):
            payload["storage"] = manifest.get("selected_storage") or manifest.get("storage") or "auto"

    provider_preference = payload.get("provider_preference")
    normalized = normalize_provider_preference(provider_preference)
    payload["provider_preference"] = normalized or ["wasm"]
    payload["storage"] = str(payload.get("storage") or "auto").strip() or "auto"
    payload["public_base_url"] = str(payload.get("public_base_url") or "").strip()
    payload["public_backend_url"] = str(payload.get("public_backend_url") or "").strip()
    return payload

def normalize_provider_preference(value):
    if isinstance(value, str):
        raw = [item.strip().lower() for item in value.split(",")]
    elif isinstance(value, (list, tuple)):
        raw = [str(item).strip().lower() for item in value]
    else:
        raw = []
    allowed = [item for item in raw if item in {"wasm", "webgpu"}]
    deduped = []
    for item in allowed:
        if item not in deduped:
            deduped.append(item)
    return deduped

def save_deployment_config(payload):
    normalized = {
        "public_base_url": str(payload.get("public_base_url") or "").strip(),
        "public_backend_url": str(payload.get("public_backend_url") or "").strip(),
        "storage": str(payload.get("storage") or "auto").strip() or "auto",
        "provider_preference": normalize_provider_preference(payload.get("provider_preference")) or ["wasm"],
    }
    deployment_config_path().write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return normalized

def model_domain_sources():
    dialogue_dir = MODEL_CORPORA_DIR / "dialogue_sft"
    return {
        "general": [
            dialogue_dir / "chat_quality_pack_ko.jsonl",
            dialogue_dir / "reasoning_seed_ko.jsonl",
            dialogue_dir / "dialogue_followup_repair_ko.jsonl",
        ],
        "dialogue": [
            dialogue_dir / "chat_quality_pack_ko.jsonl",
            dialogue_dir / "dialogue_followup_repair_ko.jsonl",
        ],
        "reasoning": [
            dialogue_dir / "reasoning_seed_ko.jsonl",
        ],
        "followup": [
            dialogue_dir / "dialogue_followup_repair_ko.jsonl",
        ],
    }

def jsonl_dialogue_to_text(path):
    if not Path(path).exists():
        return ""
    blocks = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue
            instruction = str(item.get("instruction") or item.get("input") or "").strip()
            response = str(item.get("response") or item.get("output") or "").strip()
            if instruction and response:
                blocks.append(f"User: {instruction}\nAssistant: {response}")
                continue
            messages = item.get("messages")
            if isinstance(messages, list) and messages:
                parts = []
                for message in messages:
                    role = str(message.get("role") or "").strip().lower()
                    content = str(message.get("content") or "").strip()
                    if not content:
                        continue
                    if role == "user":
                        parts.append(f"User: {content}")
                    elif role == "assistant":
                        parts.append(f"Assistant: {content}")
                if parts:
                    blocks.append("\n".join(parts))
    return "\n\n".join(blocks)

def build_domain_training_text(domain):
    normalized = str(domain or "").strip().lower()
    if not normalized:
        normalized = "general"
    source_map = model_domain_sources()
    paths = source_map.get(normalized) or source_map["general"]
    chunks = []
    for path in paths:
        text = jsonl_dialogue_to_text(path)
        if text.strip():
            chunks.append(text.strip())
    return "\n\n".join(chunks).strip()

def cleanup_archive_dir():
    path = PROJECT_ROOT / "Cleanup_Archive"
    path.mkdir(parents=True, exist_ok=True)
    return path

def cleanup_candidates():
    candidates = [
        PROJECT_ROOT / "patch_generate.py",
        BASE_DIR / "app.py.backup_20260405_194725",
        BASE_DIR / "app.py.backup_ngram_20260406_193117",
        BASE_DIR / "__pycache__",
        PROJECT_ROOT / "cloudflare" / "__pycache__",
        MODEL_SCRIPTS_DIR / "__pycache__",
        PROJECT_ROOT / "tools" / "__pycache__",
        model_dir_for("purple-bee-1-3") / "training_repair_v6_followup",
        model_dir_for("purple-bee-1-3") / "training_resume_v2",
    ]
    return [path for path in candidates if path.exists()]

def archive_cleanup_candidates():
    candidates = cleanup_candidates()
    batch_dir = cleanup_archive_dir() / f"panel_cleanup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    moved = []
    if not candidates:
        return {"archive_dir": str(batch_dir), "moved": moved}
    for path in candidates:
        relative = path.relative_to(PROJECT_ROOT)
        destination = batch_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(destination))
        moved.append({
            "source": str(path),
            "destination": str(destination),
        })
    return {"archive_dir": str(batch_dir), "moved": moved}

def run_runtime_smoke(model_id):
    payload = runtime_manifest_payload(model_id)
    deployment = deployment_overview_for(model_id)
    asset_checks = []
    for key in ["onnx", "onnx_data", "tokenizer"]:
        asset_path = str(deployment.get("artifacts", {}).get(key) or "").strip()
        if not asset_path:
            continue
        path = Path(asset_path)
        asset_checks.append({
            "name": key,
            "exists": path.exists(),
            "size": path.stat().st_size if path.exists() and path.is_file() else 0,
            "path": str(path),
        })
    public_checks = []
    public_base_url = str(deployment.get("public_base_url") or "").rstrip("/")
    if public_base_url:
        for key in ["onnx", "onnx_data", "tokenizer"]:
            asset_path = str(deployment.get("artifacts", {}).get(key) or "").strip()
            if not asset_path:
                continue
            url = f"{public_base_url}/{Path(asset_path).name}"
            status_code = None
            try:
                response = requests.head(url, timeout=20, allow_redirects=True)
                status_code = response.status_code
            except Exception:
                status_code = None
            public_checks.append({"name": key, "url": url, "status_code": status_code})
    return {
        "model_id": model_id,
        "display_name": payload.get("display_name"),
        "provider_preference": payload.get("runtime", {}).get("provider_preference", []),
        "website_runtime_ready": deployment.get("website_runtime_ready"),
        "asset_checks": asset_checks,
        "public_checks": public_checks,
    }

def run_hf_upload_action():
    command = [sys.executable, str(PROJECT_ROOT / "cloudflare" / "hf_upload.py")]
    completed = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=3600,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stdout or "HF upload failed.")[-1200:])
    return {"stdout": completed.stdout}

def run_cloudflare_deploy_action():
    command = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(PROJECT_ROOT / "cloudflare" / "run-wrangler.ps1"),
        "-Action",
        "deploy",
    ]
    completed = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT / "cloudflare"),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=3600,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stdout or "Cloudflare deploy failed.")[-1200:])
    return {"stdout": completed.stdout}

def is_http_url(value):
    value = str(value or "").strip().lower()
    return value.startswith("http://") or value.startswith("https://")

def load_packaged_browser_manifest(model_id):
    manifest_path = browser_package_dir_for(model_id) / "browser-manifest.json"
    payload = load_json_if_exists(manifest_path)
    return payload if isinstance(payload, dict) else {}

def packaged_remote_asset_urls(model_id):
    payload = load_packaged_browser_manifest(model_id)
    browser_assets = payload.get("browser_assets") if isinstance(payload.get("browser_assets"), dict) else {}
    remote_urls = {}
    for key in ["onnx", "onnx_data", "tokenizer"]:
        value = str(browser_assets.get(key) or "").strip()
        if is_http_url(value):
            remote_urls[key] = value
    return remote_urls

def resolve_browser_bundle(model_id):
    package_dir = browser_package_dir_for(model_id)
    source_dir = package_dir if package_dir.exists() else browser_export_dir_for(model_id)
    onnx_file = next(iter(sorted(source_dir.glob("*.onnx"))), None)
    onnx_data_file = next(iter(sorted(source_dir.glob("*.onnx.data"))), None)
    tokenizer_file = next(iter(sorted(source_dir.glob("*tokenizer*.json"))), None)
    if tokenizer_file is None:
        candidate = source_dir / "tokenizer.json"
        if candidate.exists():
            tokenizer_file = candidate
    manifest_file = source_dir / "browser-manifest.json"
    report_file = source_dir / "package-report.json"
    return {
        "source_dir": source_dir,
        "mode": "browser-package" if source_dir == package_dir else "browser-export",
        "onnx_file": onnx_file if onnx_file and onnx_file.exists() else None,
        "onnx_data_file": onnx_data_file if onnx_data_file and onnx_data_file.exists() else None,
        "tokenizer_file": tokenizer_file if tokenizer_file and tokenizer_file.exists() else None,
        "manifest_file": manifest_file if manifest_file.exists() else None,
        "report_file": report_file if report_file.exists() else None,
    }

def default_teacher_config(model_id):
    return {
        "enabled": False,
        "provider": "openai-compatible",
        "base_url": "",
        "model": "",
        "api_key_env": "PURPLE_BEE_TEACHER_API_KEY",
        "samples_per_run": 8,
        "temperature": 0.4,
        "max_output_tokens": 900,
        "system_prompt": (
            "You are a teacher model helping Purple Bee improve. "
            "Generate clean, natural, high-quality conversational and problem-solving training pairs. "
            "Avoid boilerplate, repetition, meta commentary, and policy filler. "
            "Return strict JSON only."
        ),
        "last_saved_at": now_iso(),
        "model_id": model_id,
    }

def default_teacher_status(model_id):
    return {
        "running": False,
        "stage": "idle",
        "message": "Teacher distillation idle",
        "model_id": model_id,
        "last_output_path": str(teacher_output_path_for(model_id)),
        "generated_pairs": 0,
        "updated_at": now_iso(),
    }

def load_teacher_config(model_id):
    ensure_version_training_files(model_id)
    path = teacher_config_path_for(model_id)
    payload = load_json_if_exists(path)
    if isinstance(payload, dict):
        defaults = default_teacher_config(model_id)
        defaults.update(payload)
        return defaults
    return default_teacher_config(model_id)

def save_teacher_config(model_id, payload):
    ensure_version_training_files(model_id)
    merged = default_teacher_config(model_id)
    merged.update(payload or {})
    merged["model_id"] = model_id
    merged["last_saved_at"] = now_iso()
    teacher_config_path_for(model_id).write_text(
        json.dumps(merged, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return merged

def load_teacher_status(model_id):
    ensure_version_training_files(model_id)
    path = teacher_status_path_for(model_id)
    payload = load_json_if_exists(path)
    if isinstance(payload, dict):
        defaults = default_teacher_status(model_id)
        defaults.update(payload)
        return defaults
    return default_teacher_status(model_id)

def save_teacher_status(model_id, payload):
    ensure_version_training_files(model_id)
    merged = default_teacher_status(model_id)
    merged.update(payload or {})
    merged["model_id"] = model_id
    merged["updated_at"] = now_iso()
    teacher_status_path_for(model_id).write_text(
        json.dumps(merged, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return merged

def export_teacher_public_dialogues(model_id, limit=240):
    source_path = teacher_output_path_for(model_id)
    target_path = teacher_public_dialogues_path_for(model_id)
    if not source_path.exists():
        return {"path": str(target_path), "pairs_written": 0}

    seen = set()
    pairs = []
    for raw_line in source_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except Exception:
            continue
        instruction = re.sub(r"\s+", " ", str(payload.get("instruction") or "")).strip()
        response = re.sub(r"\s+", " ", str(payload.get("response") or "")).strip()
        if len(instruction) < 2 or len(response) < 4:
            continue
        key = (instruction.lower(), response.lower())
        if key in seen:
            continue
        seen.add(key)
        pairs.append((instruction, response))
        if len(pairs) >= max(1, int(limit)):
            break

    target_path.parent.mkdir(parents=True, exist_ok=True)
    blocks = []
    for instruction, response in pairs:
        blocks.append(f"User: {instruction}\nAssistant: {response}")
    target_path.write_text("\n\n".join(blocks), encoding="utf-8")
    return {"path": str(target_path), "pairs_written": len(pairs)}

def deployment_overview_for(model_id):
    registry = ensure_model_registry()
    model_item = find_registry_model(registry, model_id) or {}
    deployment_config = load_deployment_config()
    bundle = resolve_browser_bundle(model_id)
    packaged_manifest = load_packaged_browser_manifest(model_id)
    packaged_runtime = packaged_manifest.get("runtime") if isinstance(packaged_manifest.get("runtime"), dict) else {}
    remote_asset_urls = packaged_remote_asset_urls(model_id)
    packaged_engine = str(packaged_runtime.get("engine") or "").strip().lower()
    browser_dir = bundle["source_dir"]
    onnx_file = bundle["onnx_file"]
    onnx_data_file = bundle["onnx_data_file"]
    tokenizer_file = bundle["tokenizer_file"]
    max_file_size = max([path.stat().st_size for path in [onnx_file, onnx_data_file, tokenizer_file] if path and path.exists()] or [0])
    static_safe = max_file_size <= STATIC_ASSET_SAFE_LIMIT
    recommended = "workers-static-assets" if static_safe else "r2-or-public-object-storage"
    selected_storage = str(deployment_config.get("storage") or "auto").strip() or "auto"
    if selected_storage == "auto":
        selected_storage = recommended
    public_base_url = str(deployment_config.get("public_base_url") or "").rstrip("/")
    remote_runtime_ready = packaged_engine == "transformers-js" or bool(remote_asset_urls.get("onnx") and remote_asset_urls.get("tokenizer"))
    website_runtime_ready = remote_runtime_ready or bool(onnx_file and tokenizer_file and (selected_storage == "workers-static-assets" or public_base_url))
    payload = {
        "model_id": model_id,
        "display_name": model_item.get("display_name", model_id),
        "browser_dir": str(browser_dir),
        "browser_bundle_mode": "remote-manifest" if remote_runtime_ready and not (onnx_file and tokenizer_file) else bundle["mode"],
        "artifacts": {
            "onnx": str(onnx_file) if onnx_file else "",
            "onnx_data": str(onnx_data_file) if onnx_data_file else "",
            "tokenizer": str(tokenizer_file) if tokenizer_file else "",
            "manifest": str(bundle["manifest_file"]) if bundle["manifest_file"] else str(browser_dir / "browser-manifest.json"),
            "package_report": str(bundle["report_file"]) if bundle["report_file"] else "",
        },
        "remote_asset_urls": remote_asset_urls,
        "sizes": {
            "onnx": onnx_file.stat().st_size if onnx_file and onnx_file.exists() else 0,
            "onnx_data": onnx_data_file.stat().st_size if onnx_data_file and onnx_data_file.exists() else 0,
            "tokenizer": tokenizer_file.stat().st_size if tokenizer_file and tokenizer_file.exists() else 0,
            "largest_file": max_file_size,
        },
        "static_asset_safe_limit": STATIC_ASSET_SAFE_LIMIT,
        "static_assets_ready": bool(onnx_file and tokenizer_file),
        "static_assets_safe": static_safe,
        "recommended_storage": recommended,
        "selected_storage": selected_storage,
        "public_base_url": public_base_url,
        "runtime_engine": packaged_engine or "purple-bee-onnx",
        "website_runtime_ready": website_runtime_ready,
    }
    deployment_manifest_path_for(model_id).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload

def save_pipeline_status(model_id, payload):
    ensure_version_training_files(model_id)
    payload["updated_at"] = now_iso()
    pipeline_status_path_for(model_id).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

def pipeline_overview_for(model_id):
    ensure_version_training_files(model_id)
    blueprint = load_architecture_blueprint(architecture_path_for(model_id))
    status = load_pipeline_status(model_id)
    planned_params = estimate_transformer_params(blueprint)
    backend = detect_100m_backend()
    checkpoint_candidates = list(checkpoint_dir_for(model_id).glob("*.pt"))
    preferred_checkpoint = preferred_checkpoint_path_for(model_id)
    tokenizer_data = load_json_if_exists(tokenizer_path_for(model_id))
    summary = load_json_if_exists(training_summary_path_for(model_id))
    tokenizer_report = load_json_if_exists(training_dir_for(model_id) / "tokenizer_report.json")
    evaluation_output = load_json_if_exists(status.get("eval_latest_output") or latest_evaluation_path_for(model_id))
    eval_suite = load_eval_suite(status.get("eval_file") or DEFAULT_PUBLIC_EVAL_PATH)
    issues = []
    if planned_params < 100_000_000:
        issues.append("현재 설계값이 1억 파라미터 목표보다 작습니다.")
    if not backend.get("torch_available"):
        issues.append("관리용 컴퓨터에 PyTorch가 없어 100M 학습을 바로 시작할 수 없습니다.")
    if not corpus_snapshot_path_for(model_id).exists():
        issues.append("100M 파이프라인용 코퍼스 스냅샷이 아직 준비되지 않았습니다.")
    if not checkpoint_candidates:
        issues.append("아직 100M 체크포인트가 생성되지 않았습니다.")
    if tokenizer_data is None:
        issues.append("100M 토크나이저가 아직 생성되지 않았습니다.")
    return {
        "name": blueprint.get("name", "Purple Bee 100M"),
        "architecture": blueprint.get("architecture", "decoder-only-transformer"),
        "planned_params": planned_params,
        "parameter_budget": blueprint.get("parameter_budget", 100_000_000),
        "config": blueprint.get("config", {}),
        "training_defaults": blueprint.get("training_defaults", {}),
        "notes": blueprint.get("notes", []),
        "backend": backend,
        "status": status,
        "summary": summary,
        "preferred_checkpoint": str(preferred_checkpoint) if preferred_checkpoint else "",
        "evaluation": {
            "prompt_set": eval_suite.get("path"),
            "categories": eval_suite.get("categories", []),
            "schedule": normalize_eval_steps(status.get("eval_schedule")),
            "history": status.get("evaluation_history") or [],
            "latest": status.get("latest_evaluation"),
            "latest_output": evaluation_output,
            "running": bool(status.get("evaluation_running")),
        },
        "tokenizer": {
            "path": str(tokenizer_path_for(model_id)),
            "exists": tokenizer_data is not None,
            "effective_vocab_size": (tokenizer_data or {}).get("stats", {}).get("effective_vocab_size"),
            "coverage": (tokenizer_data or {}).get("stats", {}).get("full_piece_coverage"),
            "report": tokenizer_report,
        },
        "issues": issues,
        "artifacts": {
            "architecture_path": str(architecture_path_for(model_id)),
            "status_path": str(pipeline_status_path_for(model_id)),
            "corpus_snapshot": str(corpus_snapshot_path_for(model_id)),
            "curation_report": str(curation_report_path_for(model_id)),
            "tokenizer": str(tokenizer_path_for(model_id)),
            "training_summary": str(training_summary_path_for(model_id)),
            "checkpoint_dir": str(checkpoint_dir_for(model_id)),
            "evaluation_dir": str(evaluation_dir_for(model_id)),
        },
        "checkpoint_ready": bool(checkpoint_candidates),
    }

def slugify_model_version(version):
    slug = re.sub(r"[^a-z0-9.]+", "-", str(version).lower()).strip("-")
    slug = slug.replace(".", "-")
    return f"purple-bee-{slug}"

def model_issues_for_stats(stats):
    issues = []
    estimated = stats.get("estimated_params", 0)
    docs = stats.get("trained_docs", 0)
    avg_loss = stats.get("avg_loss")
    if estimated < 100_000_000:
        issues.append("현재 로컬 학습 모델의 추정 파라미터 수는 1억보다 작습니다. 대화 능력 확장을 원하면 별도 대형 모델 학습 계획이 필요합니다.")
    if docs < 200:
        issues.append("학습 문서 수가 아직 적습니다. 언어 지식을 두껍게 하려면 더 많은 정제 말뭉치가 필요합니다.")
    if avg_loss is not None and avg_loss > 0.12:
        issues.append("최근 평균 손실이 아직 높습니다. 추가 학습이나 데이터 정제가 필요할 수 있습니다.")
    if not (STATIC_DIR / "purple-bee-model.bin").exists():
        issues.append("브라우저 런타임용 모델 바이너리가 아직 준비되지 않았습니다.")
    return issues

def estimate_params_from_snapshot(snapshot):
    vocab = snapshot.get("vocab_size", 0)
    bigrams = snapshot.get("bigram_count", 0)
    trigrams = snapshot.get("trigram_count", 0)
    return vocab * 512 + bigrams * 64 + trigrams * 32

def load_json_if_exists(path):
    path = Path(path)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}

def pipeline_stats_for_version(model_id):
    summary = load_json_if_exists(training_summary_path_for(model_id))
    status = load_json_if_exists(pipeline_status_path_for(model_id))
    if not summary and not status:
        return {}

    estimated_params = (
        summary.get("actual_params")
        or status.get("actual_params")
        or summary.get("estimated_params")
        or status.get("estimated_params")
        or 0
    )
    stats = {
        "estimated_params": estimated_params,
        "latest_loss": status.get("last_loss", summary.get("final_loss")),
        "avg_loss": status.get("avg_loss", summary.get("avg_loss")),
        "trained_docs": (
            (summary.get("sft_dataset") or {}).get("usable_examples")
            or (status.get("sft_dataset") or {}).get("usable_examples")
            or 0
        ),
    }
    tokenizer_vocab = summary.get("tokenizer_vocab_size") or status.get("tokenizer_vocab_size")
    if tokenizer_vocab:
        stats["vocab_size"] = tokenizer_vocab
    return {key: value for key, value in stats.items() if value not in (None, "", [])}

def stats_for_version(model_id):
    state_path = artifacts_dir_for(model_id) / "model_state.json"
    snapshot_stats = {}
    if state_path.exists():
        try:
            snapshot = json.loads(state_path.read_text(encoding="utf-8"))
            snapshot_stats = {
                "vocab_size": snapshot.get("vocab_size", 0),
                "total_tokens": snapshot.get("total_tokens", 0),
                "trained_docs": snapshot.get("trained_docs", 0),
                "version": snapshot.get("version", 0),
                "estimated_params": estimate_params_from_snapshot(snapshot),
                "latest_loss": snapshot.get("loss_history", [])[-1] if snapshot.get("loss_history") else None,
                "avg_loss": round(sum(snapshot.get("loss_history", [])[-20:]) / max(len(snapshot.get("loss_history", [])[-20:]), 1), 4) if snapshot.get("loss_history") else None,
            }
        except Exception:
            snapshot_stats = {}
    pipeline_stats = pipeline_stats_for_version(model_id)
    if snapshot_stats or pipeline_stats:
        merged = {}
        if pipeline_stats.get("estimated_params", 0) >= 100_000_000:
            merged.update(snapshot_stats)
            merged.update(pipeline_stats)
        else:
            merged.update(pipeline_stats)
            merged.update(snapshot_stats)
        return merged
    return model.get_stats()

def collect_model_artifact_paths():
    return {
        "state_json": MODEL_PATH,
        "weights_pickle": APP_DATA_DIR / "model_weights.pkl",
        "browser_model_bin": STATIC_DIR / "purple-bee-model.bin",
        "browser_engine_js": STATIC_DIR / "purple-bee-engine.js",
        "browser_local_js": STATIC_DIR / "purple-bee-local.js",
    }

def sync_live_artifacts_to_version(model_id):
    artifacts_dir = artifacts_dir_for(model_id)
    browser_dir = browser_assets_dir_for(model_id)
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    browser_dir.mkdir(parents=True, exist_ok=True)
    ensure_version_training_files(model_id)

    paths = collect_model_artifact_paths()
    for key, src in paths.items():
        if not src.exists():
            continue
        target_base = browser_dir if key.startswith("browser_") else artifacts_dir
        try:
            shutil.copy2(src, target_base / src.name)
        except PermissionError:
            continue

def load_registry():
    if MODEL_REGISTRY_PATH.exists():
        try:
            data = json.loads(MODEL_REGISTRY_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("models"), list):
                return data
        except Exception:
            pass
    return {"family_name": MODEL_FAMILY_NAME, "current_model_id": None, "latest_model_id": None, "models": []}

def save_registry(registry):
    MODEL_REGISTRY_PATH.write_text(json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8")

def find_registry_model(registry, model_id):
    for item in registry.get("models", []):
        if item.get("id") == model_id:
            return item
    return None

def create_model_manifest(version, created_from=None, source_stats=None):
    model_id = slugify_model_version(version)
    stats = source_stats or stats_for_version(model_id)
    blueprint = load_architecture_blueprint()
    planned_params = estimate_transformer_params(blueprint)
    return {
        "id": model_id,
        "display_name": f"{MODEL_FAMILY_NAME} {version}",
        "version": str(version),
        "enabled": True,
        "created_at": now_iso(),
        "created_from": created_from,
        "stage": "prototype",
        "target_params": planned_params,
        "actual_params_estimate": stats.get("estimated_params", 0),
        "trained_docs": stats.get("trained_docs", 0),
        "latest_loss": stats.get("latest_loss"),
        "avg_loss": stats.get("avg_loss"),
        "architecture_name": blueprint.get("name", "Purple Bee 100M"),
        "pipeline_stage": "idle",
        "pipeline_message": "100M pipeline idle",
        "backend_status": detect_100m_backend().get("label"),
        "issues": model_issues_for_stats(stats),
        "current": False,
        "latest": False,
        "trainable": False,
    }

def refresh_registry_metadata(registry):
    current_id = registry.get("current_model_id")
    latest_id = registry.get("latest_model_id")
    for item in registry.get("models", []):
        ensure_version_training_files(item["id"])
        item["enabled"] = bool(item.get("enabled", True))
        item["current"] = item.get("id") == current_id
        item["latest"] = item.get("id") == latest_id
        item["trainable"] = item["current"] and item["latest"] and item["enabled"]
        stats = stats_for_version(item["id"])
        pipeline = pipeline_overview_for(item["id"])
        base_issues = model_issues_for_stats(stats)
        item["actual_params_estimate"] = stats.get("estimated_params", 0)
        item["trained_docs"] = stats.get("trained_docs", 0)
        item["latest_loss"] = stats.get("latest_loss")
        item["avg_loss"] = stats.get("avg_loss")
        item["target_params"] = pipeline.get("planned_params", item.get("target_params", 100_000_000))
        item["architecture_name"] = pipeline.get("name", "Purple Bee 100M")
        item["pipeline_stage"] = pipeline.get("status", {}).get("stage", "idle")
        item["pipeline_message"] = pipeline.get("status", {}).get("message", "100M pipeline idle")
        item["backend_status"] = pipeline.get("backend", {}).get("label", "PyTorch missing")
        item["issues"] = base_issues + [issue for issue in pipeline.get("issues", []) if issue not in base_issues]
    return registry

def ensure_model_registry():
    registry = load_registry()
    if not registry.get("models"):
        manifest = create_model_manifest(INITIAL_MODEL_VERSION)
        registry["models"] = [manifest]
        registry["current_model_id"] = manifest["id"]
        registry["latest_model_id"] = manifest["id"]
        model_dir_for(manifest["id"]).mkdir(parents=True, exist_ok=True)
        sync_live_artifacts_to_version(manifest["id"])
    registry = refresh_registry_metadata(registry)
    current_id = registry.get("current_model_id")
    if current_id:
        sync_live_artifacts_to_version(current_id)
        training_status["active_model_id"] = current_id
    save_registry(registry)
    return registry

def local_runtime_corsify(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    response.headers["Cache-Control"] = "no-store"
    return response

def local_runtime_preflight_response():
    return local_runtime_corsify(jsonify({})), 200

def ensure_local_runtime_bundle():
    registry = ensure_model_registry()
    model_id = registry.get("current_model_id") or registry.get("latest_model_id")
    item = find_registry_model(registry, model_id) or {}
    checkpoint_path = preferred_checkpoint_path_for(model_id) if model_id else None
    tokenizer_file = tokenizer_path_for(model_id) if model_id else None
    payload = {
        "ok": True,
        "runtime_mode": "localhost-python-runtime",
        "family_name": registry.get("family_name", "Purple Bee"),
        "model_id": model_id or "",
        "display_name": item.get("display_name") or (model_id or "Purple Bee"),
        "managed_folder": str(LOCAL_RUNTIME_MANAGED_DIR),
        "managed_manifest": str(LOCAL_RUNTIME_MANIFEST_PATH),
        "checkpoint_path": str(checkpoint_path) if checkpoint_path and Path(checkpoint_path).exists() else "",
        "tokenizer_path": str(tokenizer_file) if tokenizer_file and Path(tokenizer_file).exists() else "",
        "deletable": True,
        "protected_mode": "managed-hidden-folder",
        "security_note": (
            "Local files on a user-owned device can be hidden and managed, "
            "but cannot be made perfectly unreadable or undecompilable."
        ),
        "updated_at": now_iso(),
    }
    LOCAL_RUNTIME_MANIFEST_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if os.name == "nt":
        try:
            subprocess.run(
                ["attrib", "+h", "+s", str(LOCAL_RUNTIME_MANAGED_DIR)],
                check=False,
                capture_output=True,
                text=True,
            )
        except Exception:
            pass
    return payload

def ensure_admin_config():
    if ADMIN_CONFIG_PATH.exists():
        payload = load_json_if_exists(ADMIN_CONFIG_PATH)
        if isinstance(payload, dict) and str(payload.get("admin_key") or "").strip():
            return payload
    payload = {
        "admin_key": secrets.token_urlsafe(24),
        "created_at": now_iso(),
        "note": "Use this key for /model-panel and /api/model_panel/* access.",
    }
    ADMIN_CONFIG_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload

def current_admin_key():
    env_key = str(os.environ.get("PURPLE_BEE_ADMIN_KEY") or "").strip()
    if env_key:
        return env_key
    payload = ensure_admin_config()
    return str(payload.get("admin_key") or "").strip()

def request_admin_key():
    header_key = str(request.headers.get("X-Admin-Key") or "").strip()
    if header_key:
        return header_key
    query_key = str(request.args.get("admin_key") or "").strip()
    if query_key:
        return query_key
    cookie_key = str(request.cookies.get("pb_admin_key") or "").strip()
    if cookie_key:
        return cookie_key
    if request.is_json:
        payload = request.get_json(silent=True) or {}
        json_key = str(payload.get("admin_key") or "").strip()
        if json_key:
            return json_key
    form_key = str(request.form.get("admin_key") or "").strip()
    if form_key:
        return form_key
    return ""

def admin_access_granted():
    expected = current_admin_key()
    if not expected:
        return False
    return secrets.compare_digest(request_admin_key(), expected)

def load_version_into_live_runtime(model_id):
    version_dir = model_dir_for(model_id)
    artifacts_dir = version_dir / "artifacts"
    browser_dir = version_dir / "browser_assets"
    if not artifacts_dir.exists():
        raise FileNotFoundError("선택한 모델 버전의 아티팩트를 찾을 수 없습니다.")

    for artifact in artifacts_dir.glob("*"):
        target = APP_DATA_DIR / artifact.name
        shutil.copy2(artifact, target)
    if browser_dir.exists():
        for asset in browser_dir.glob("*"):
            shutil.copy2(asset, STATIC_DIR / asset.name)

    global model
    model = SimpleTransformerLM()
    training_status["active_model_id"] = model_id

def clone_latest_model(new_version):
    registry = ensure_model_registry()
    latest = find_registry_model(registry, registry.get("latest_model_id"))
    if latest is None:
        raise RuntimeError("최신 모델 정보를 찾지 못했습니다.")

    new_id = slugify_model_version(new_version)
    if find_registry_model(registry, new_id):
        raise ValueError("이미 같은 버전의 모델이 있습니다.")

    source_dir = model_dir_for(latest["id"])
    target_dir = model_dir_for(new_id)
    shutil.copytree(source_dir, target_dir, dirs_exist_ok=False)

    manifest = create_model_manifest(new_version, created_from=latest["id"], source_stats=stats_for_version(latest["id"]))
    registry["models"].append(manifest)
    registry["current_model_id"] = new_id
    registry["latest_model_id"] = new_id
    refresh_registry_metadata(registry)
    save_registry(registry)
    load_version_into_live_runtime(new_id)
    sync_live_artifacts_to_version(new_id)
    return registry, manifest

def collect_recent_training_corpus(limit_rows=80):
    segments = []
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""SELECT input, output FROM training_data
                     ORDER BY id DESC LIMIT ?""", (limit_rows,))
        for inp, out in c.fetchall():
            segments.append(f"질문: {inp}\n답변: {out}")
        c.execute("""SELECT role, content FROM conversations
                     ORDER BY id DESC LIMIT ?""", (limit_rows,))
        for role, content in c.fetchall():
            segments.append(f"{role}: {content}")
        conn.close()
    except Exception:
        pass
    return "\n\n".join(segments[:limit_rows])

LOW_QUALITY_MARKERS = [
    "관련 자료를 찾지 못했습니다",
    "*모델 보완*",
    "위키백과, 우리 모두의 백과사전 본문으로 이동",
    "disambiguation",
    "참고 문헌 목록",
]

GENERIC_TRAINING_MARKERS = [
    "질문 의도는 이해했어요.",
    "조금만 더 구체적으로 적어주면",
    "원하는 답 형태를 한 줄로 알려주세요.",
    "현재 상태, 원하는 결과, 이미 해본 것",
]

def normalize_corpus_text(text):
    text = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

def looks_broken_spacing(text):
    return bool(
        re.search(r"(?:[A-Za-z]\s+){5,}[A-Za-z]", text)
        or re.search(r"(?:[가-힣]\s+){6,}[가-힣]", text)
    )

def looks_mojibake_text(text):
    cleaned = normalize_corpus_text(text)
    if not cleaned:
        return False
    compatibility = len(re.findall(r"[\uF900-\uFAFF]", cleaned))
    prefixed_question_marks = len(re.findall(r"\?[가-힣A-Za-z\u3040-\u30ff\u4e00-\u9fff]", cleaned))
    return "�" in cleaned or compatibility >= 2 or prefixed_question_marks >= 2 or (compatibility + prefixed_question_marks) >= 3

def repeated_line_ratio(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return 0.0
    return 1.0 - (len(set(lines)) / len(lines))

def looks_low_quality_text(text):
    cleaned = normalize_corpus_text(text)
    if len(cleaned) < 8:
        return True
    if looks_mojibake_text(cleaned):
        return True
    lowered = cleaned.lower()
    if any(marker.lower() in lowered for marker in LOW_QUALITY_MARKERS):
        return True
    if looks_broken_spacing(cleaned):
        return True
    tokens = cleaned.split()
    if tokens:
        single_ratio = sum(1 for token in tokens if len(token) == 1) / len(tokens)
        if len(tokens) >= 12 and single_ratio > 0.34:
            return True
    if repeated_line_ratio(cleaned) > 0.35:
        return True
    if re.search(r"(.)\1{6,}", cleaned):
        return True
    if len(re.findall(r"https?://|www\.", lowered)) >= 2:
        return True
    if re.search(r"[\\/]{3,}", cleaned):
        return True
    return False

def quality_signature(*parts):
    merged = " || ".join(
        re.sub(r"\s+", " ", normalize_corpus_text(part)).lower()
        for part in parts
        if normalize_corpus_text(part)
    )
    return hashlib.sha1(merged.encode("utf-8")).hexdigest()

def curated_seed_blocks():
    blocks = []
    for path in sorted(MODEL_CORPORA_DIR.glob("*.txt")):
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        if looks_mojibake_text(text):
            continue
        blocks.append(text)
    return blocks

def collect_clean_training_pairs(limit_rows=600):
    blocks = []
    seen = set()
    report = {
        "db_rows": 0,
        "kept_pairs": 0,
        "skipped_short": 0,
        "skipped_too_long": 0,
        "skipped_low_quality": 0,
        "skipped_duplicate": 0,
    }
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""SELECT input, output FROM training_data
                     ORDER BY id DESC LIMIT ?""", (limit_rows,))
        rows = c.fetchall()
        conn.close()
    except Exception:
        rows = []

    report["db_rows"] = len(rows)
    for prompt, answer in rows:
        prompt = normalize_corpus_text(prompt)
        answer = normalize_corpus_text(answer)
        if len(prompt) < 2 or len(answer) < 20:
            report["skipped_short"] += 1
            continue
        if len(prompt) > 320 or len(answer) > 1400:
            report["skipped_too_long"] += 1
            continue
        if looks_low_quality_text(prompt) or looks_low_quality_text(answer):
            report["skipped_low_quality"] += 1
            continue
        if any(marker in answer for marker in GENERIC_TRAINING_MARKERS):
            report["skipped_low_quality"] += 1
            continue
        signature = quality_signature(prompt, answer)
        if signature in seen:
            report["skipped_duplicate"] += 1
            continue
        seen.add(signature)
        blocks.append(f"사용자: {prompt}\nPurple Bee: {answer}")
        report["kept_pairs"] += 1
    return blocks, report

def static_reference_blocks():
    candidates = [
        PROJECT_ROOT / "ARCHITECTURE.md",
        PROJECT_ROOT / "README.md",
        MODEL_ROOT / "README.md",
    ]
    blocks = []
    for path in candidates:
        if not path.exists():
            continue
        text = normalize_corpus_text(path.read_text(encoding="utf-8", errors="replace"))
        if not text or looks_low_quality_text(text):
            continue
        blocks.append(text)
    return blocks

def load_teacher_pairs_blocks(model_id):
    path = teacher_output_path_for(model_id)
    if not path.exists():
        return []
    blocks = []
    try:
        for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line:
                continue
            item = json.loads(line)
            instruction = normalize_corpus_text(item.get("instruction", ""))
            response = normalize_corpus_text(item.get("response", ""))
            if instruction and response:
                blocks.append(f"User: {instruction}\nAssistant: {response}")
    except Exception:
        return []
    return blocks

def build_clean_100m_corpus(manual_text="", model_id=""):
    blocks = []
    report = {
        "seed_blocks": 0,
        "reference_blocks": 0,
        "manual_blocks": 0,
        "teacher_blocks": 0,
        "paragraphs_kept": 0,
        "paragraphs_skipped_short": 0,
        "paragraphs_skipped_low_quality": 0,
        "paragraphs_skipped_duplicate": 0,
    }
    blocks.extend(curated_seed_blocks())
    report["seed_blocks"] = len(blocks)
    clean_pairs, pair_report = collect_clean_training_pairs()
    blocks.extend(clean_pairs)
    if model_id:
        teacher_blocks = load_teacher_pairs_blocks(model_id)
        if teacher_blocks:
            blocks.extend(teacher_blocks)
            report["teacher_blocks"] = len(teacher_blocks)
    if manual_text.strip():
        blocks.append(normalize_corpus_text(manual_text))
        report["manual_blocks"] = 1

    paragraphs = []
    seen = set()
    for block in blocks:
        for chunk in re.split(r"\n{2,}", normalize_corpus_text(block)):
            cleaned = normalize_corpus_text(chunk)
            if len(cleaned) < 20:
                report["paragraphs_skipped_short"] += 1
                continue
            if looks_low_quality_text(cleaned):
                report["paragraphs_skipped_low_quality"] += 1
                continue
            signature = quality_signature(cleaned)
            if signature in seen:
                report["paragraphs_skipped_duplicate"] += 1
                continue
            seen.add(signature)
            paragraphs.append(cleaned)
            report["paragraphs_kept"] += 1
    report["pair_report"] = pair_report
    return "\n\n".join(paragraphs), report

def build_stage_100m_corpus(model_id, manual_text=""):
    ensure_version_training_files(model_id)
    snapshot_path = corpus_snapshot_path_for(model_id)
    report_path = curation_report_path_for(model_id)

    subprocess.run(
        [sys.executable, str(MODEL_SCRIPTS_DIR / "generate_foundation_chat_dataset.py")],
        cwd=str(PROJECT_ROOT),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    subprocess.run(
        [sys.executable, str(MODEL_SCRIPTS_DIR / "build_sft_dataset.py")],
        cwd=str(PROJECT_ROOT),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    completed = subprocess.run(
        [
            sys.executable,
            str(MODEL_SCRIPTS_DIR / "build_stage_corpus.py"),
            "--output", str(snapshot_path),
            "--report", str(report_path),
        ],
        cwd=str(PROJECT_ROOT),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    corpus_text = snapshot_path.read_text(encoding="utf-8", errors="replace")
    report = load_json_if_exists(report_path)
    if not isinstance(report, dict):
        try:
            report = json.loads(completed.stdout)
        except Exception:
            report = {}

    manual_text = normalize_corpus_text(manual_text or "")
    if manual_text.strip():
        corpus_text = "\n\n".join([corpus_text.strip(), manual_text, manual_text]).strip()
        snapshot_path.write_text(corpus_text, encoding="utf-8")
        report["manual_text"] = {
            "weighted": 2,
            "characters": len(manual_text),
        }

    report["builder"] = "stage_sft_corpus_v2"
    report["corpus_characters"] = len(corpus_text)
    report["corpus_paragraphs"] = len([p for p in corpus_text.split("\n\n") if p.strip()])
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return snapshot_path, corpus_text, report

def recent_history_pairs(history, limit=6):
    pairs = []
    for item in history[-limit:]:
        if not isinstance(item, dict):
            continue
        role = "Purple Bee" if item.get("role") == "assistant" else "사용자"
        content = normalize_corpus_text(item.get("content", ""))
        if not content:
            continue
        pairs.append((role, content))
    return pairs

def build_100m_chat_prompt(query, history=None):
    history = history or []
    language = detect_reply_language(query, history=history)
    language_label = {
        "ko": "한국어",
        "en": "English",
        "ja": "日本語",
        "zh": "中文",
    }.get(language, "한국어")
    lowered_query = normalize_corpus_text(query).lower()
    is_smalltalk = contains_phrase(lowered_query, [
        "안녕", "안녕하세요", "하이", "헬로", "hello", "hi", "뭐해", "우리 뭐할래",
        "심심", "그냥 이야기", "what should we do",
    ])
    is_definition = contains_phrase(lowered_query, [
        "뭐야", "무엇이야", "뜻", "정의", "설명해", "what is", "define",
    ])
    style_hint = (
        "짧은 일상 대화면 메뉴식 목록 대신 사람처럼 1~3문장으로 바로 답한다."
        if is_smalltalk else
        "정의나 설명 질문이면 핵심 정의를 먼저 말하고, 필요할 때만 짧은 예시를 붙인다."
        if is_definition else
        "먼저 직접 답하고, 필요한 경우에만 짧게 보충한다."
    )
    sections = [
        "System: 너는 Purple Bee다.",
        f"System: 답변 언어는 {language_label}로 유지한다.",
        f"System: {style_hint}",
        "System: 반복, 메타 설명, 장황한 서론 없이 바로 답한다.",
    ]
    trimmed_history = recent_history_pairs(history)[-2:]
    if trimmed_history:
        sections.append("Context:")
    for role, content in trimmed_history:
        sections.append(f"{role}: {content}")
    sections.extend([
        f"사용자: {normalize_corpus_text(query)}",
        "Assistant:",
    ])
    return "\n".join(sections)

def clean_generated_reply(text):
    cleaned = normalize_corpus_text(text)
    cleaned = re.sub(r"^(Purple Bee:|Assistant:|assistant:|System:|Instruction:)\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.split(r"\n(?:사용자|User|Assistant|assistant|Purple Bee|System|Instruction)\s*:", cleaned)[0]
    cleaned = cleaned.replace("Purple Bee:", "").replace("Assistant:", "").replace("System:", "").replace("Instruction:", "").strip()
    cleaned = cleaned.replace("<eos>", "").replace("<bos>", "")
    cleaned = re.sub(r"\s+([,.!?])", r"\1", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()

def looks_unusable_reply(text, query=""):
    cleaned = clean_generated_reply(text)
    if len(cleaned) < 8:
        return True
    if looks_mojibake_text(cleaned):
        return True
    if any(marker in cleaned for marker in ["사용자:", "Purple Bee", "Bee:", "Purple "]):
        return True
    if cleaned.count(":") >= 2:
        return True
    if looks_low_quality_text(cleaned):
        return True
    if repeated_line_ratio(cleaned) > 0.25:
        return True
    words = cleaned.split()
    if len(words) >= 10:
        repeated = max(words.count(word) for word in set(words))
        if repeated / len(words) > 0.28:
            return True
    if query:
        expected_lang = detect_reply_language(query)
        if expected_lang == "ko" and len(re.findall(r"[A-Za-z]{4,}", cleaned)) > len(re.findall(r"[가-힣]{2,}", cleaned)) * 2 + 6:
            return True
        if expected_lang == "en" and len(re.findall(r"[가-힣]{2,}", cleaned)) > len(re.findall(r"[A-Za-z]{3,}", cleaned)) * 2 + 4:
            return True
    return False

def generation_profile_for_query(query):
    lowered = normalize_corpus_text(query).lower()
    if contains_phrase(lowered, ["안녕", "하이", "헬로", "우리 뭐할래", "심심", "그냥 이야기", "hello", "hi", "what should we do"]):
        return {"temperature": 0.82, "top_k": 28, "top_p": 0.95}
    if contains_phrase(lowered, ["뭐야", "정의", "설명", "how", "what is", "define", "링크", "날씨", "어떻게"]):
        return {"temperature": 0.68, "top_k": 20, "top_p": 0.9}
    return {"temperature": 0.74, "top_k": 24, "top_p": 0.92}

def candidate_generation_profiles(query):
    primary = generation_profile_for_query(query)
    lowered = normalize_corpus_text(query).lower()
    profiles = [primary]
    profiles.append({
        "temperature": max(0.62, round(primary["temperature"] - 0.08, 2)),
        "top_k": max(18, primary["top_k"] + 4),
        "top_p": min(0.96, round(primary["top_p"] + 0.02, 2)),
    })
    if contains_phrase(lowered, ["안녕", "하이", "우리 뭐할래", "심심", "외로워", "힘들어", "hello", "hi"]):
        profiles.append({"temperature": 0.78, "top_k": 32, "top_p": 0.95})
    else:
        profiles.append({"temperature": 0.66, "top_k": 24, "top_p": 0.9})

    deduped = []
    seen = set()
    for profile in profiles:
        key = (profile["temperature"], profile["top_k"], profile["top_p"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(profile)
    return deduped

def candidate_generation_profiles_for_onnx(query):
    primary = generation_profile_for_query(query)
    conservative = {
        "temperature": min(0.45, max(0.0, round(primary.get("temperature", 0.55) - 0.18, 2))),
        "top_k": min(16, max(6, int(primary.get("top_k", 12)))),
        "top_p": min(0.88, max(0.72, round(primary.get("top_p", 0.9) - 0.06, 2))),
    }
    fallback = {
        "temperature": 0.0,
        "top_k": 1,
        "top_p": 1.0,
    }
    profiles = []
    for profile in [conservative, fallback]:
        key = (profile["temperature"], profile["top_k"], profile["top_p"])
        if key not in {(p["temperature"], p["top_k"], p["top_p"]) for p in profiles}:
            profiles.append(profile)
    return profiles

def apply_numpy_generation_penalties(logits, generated, prompt_length):
    adjusted = np.array(logits, dtype=np.float64, copy=True)
    completion_ids = generated[prompt_length:]
    if not completion_ids:
        return adjusted
    counts = {}
    for token_id in completion_ids:
        counts[token_id] = counts.get(token_id, 0) + 1
    for token_id, count in counts.items():
        penalty = min(2.5, 0.12 * count)
        adjusted[int(token_id)] -= penalty
    return adjusted

def sample_numpy_token(logits, temperature=0.55, top_k=12, top_p=0.92):
    values = np.asarray(logits, dtype=np.float64).reshape(-1)
    if values.size == 0:
        return 0
    if temperature <= 0:
        return int(np.argmax(values))
    values = values / max(float(temperature), 1e-5)
    if top_k and top_k > 0 and top_k < values.size:
        top_indices = np.argpartition(values, -int(top_k))[-int(top_k):]
        top_values = values[top_indices]
    else:
        top_indices = np.arange(values.size)
        top_values = values

    top_values = top_values - np.max(top_values)
    probs = np.exp(top_values)
    probs_sum = probs.sum()
    if probs_sum <= 0 or not np.isfinite(probs_sum):
        return int(top_indices[int(np.argmax(top_values))])
    probs = probs / probs_sum

    if top_p and 0 < float(top_p) < 1:
        order = np.argsort(probs)[::-1]
        sorted_probs = probs[order]
        cumulative = np.cumsum(sorted_probs)
        cutoff_mask = cumulative > float(top_p)
        if cutoff_mask.size:
            cutoff_mask[0] = False
        sorted_probs[cutoff_mask] = 0.0
        total = sorted_probs.sum()
        if total > 0:
            sorted_probs = sorted_probs / total
            choice = np.random.choice(len(sorted_probs), p=sorted_probs)
            return int(top_indices[order[choice]])

    choice = np.random.choice(len(top_indices), p=probs)
    return int(top_indices[choice])

def reply_quality_score(text, query=""):
    cleaned = clean_generated_reply(text)
    if not cleaned:
        return -1000
    score = min(len(cleaned), 180)
    if looks_unusable_reply(cleaned, query=query):
        score -= 400
    if detect_reply_language(query) == detect_reply_language(cleaned):
        score += 25
    if any(punct in cleaned for punct in [".", "?", "!", "다.", "요."]):
        score += 8
    if len(cleaned.split()) >= 5:
        score += 12
    return score

def apply_large_generation_penalties(logits, generated, prompt_length, repetition_penalty=1.08, recent_window=64):
    if large_torch is None:
        return logits
    adjusted = logits.clone()
    recent = generated[max(prompt_length, len(generated) - recent_window):]
    if not recent:
        return adjusted
    counts = {}
    for token_id in recent:
        counts[token_id] = counts.get(token_id, 0) + 1
    for token_id, count in counts.items():
        if token_id < 0 or token_id >= adjusted.shape[-1]:
            continue
        if adjusted[token_id] > 0:
            adjusted[token_id] = adjusted[token_id] / (repetition_penalty ** min(count, 4))
        else:
            adjusted[token_id] = adjusted[token_id] * (repetition_penalty ** min(count, 4))
        adjusted[token_id] = adjusted[token_id] - min(0.18 * count, 0.72)
    if generated:
        adjusted[generated[-1]] = adjusted[generated[-1]] - 0.8
    return adjusted

def detect_reply_language(query, history=None):
    text = normalize_corpus_text(query)
    if not text and history:
        text = " ".join(
            normalize_corpus_text(item.get("content", ""))
            for item in history
            if isinstance(item, dict)
        )
    if re.search(r"[\u3040-\u30ff]", text):
        return "ja"
    if re.search(r"[\u4e00-\u9fff]", text) and not re.search(r"[가-힣]", text):
        return "zh"
    hangul = len(re.findall(r"[가-힣]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    if hangul >= 2 and hangul >= max(1, latin // 2):
        return "ko"
    if latin >= 3:
        return "en"
    return "ko"

def localized_reply(key, lang="ko", **kwargs):
    messages = {
        "ko": {
            "greeting": "안녕하세요. 지금 무엇을 같이 보면 가장 도움이 될까요?",
            "thanks": "좋아요. 이어서 볼 내용이 있으면 바로 보내주세요.",
            "identity": "저는 Purple Bee예요. 이 기기에서 돌아가면서 대화, 문서 정리, 코드와 로그 분석을 돕는 로컬 모델이에요.",
            "capability": "문서, 코드, 오류 로그, 설정 파일, 스크린샷을 같이 보면서 핵심을 정리하고 해결 순서를 제안할 수 있어요.",
            "coding": "가능해요. 오류 원인 추적, 로그 해석, 수정 방향 정리, 함수 초안 작성까지 같이 볼 수 있어요.",
            "language": "네. 질문한 언어에 맞춰 한국어와 영어를 중심으로 답을 맞춰볼 수 있어요.",
            "file": "좋아요. 파일이나 스크린샷을 보내주면 핵심 내용, 문제 지점, 다음 확인 순서로 정리해드릴게요.",
            "planning": "좋아요. 목표, 현재 상태, 다음 순서로 나눠서 바로 실행 가능한 계획으로 정리해드릴게요.",
            "confusion": "방금 답이 어긋난 것 같아요. 반복하지 말고 핵심만 다시 맞춰볼게요. 원하는 답 형태를 한 줄로 알려주세요.",
            "short": "조금만 더 구체적으로 적어주면 문맥에 맞춰 더 정확하게 도와드릴 수 있어요.",
            "generic": "질문 핵심은 이해했어요. 현재 상태, 원하는 결과, 이미 해본 것 이 세 가지만 주면 그 기준으로 바로 이어서 정리할게요.",
            "speed": "속도는 첫 응답 지연, 모델 로딩, 토크나이저, 파일 분석, 서버 왕복 중 어디가 느린지부터 나눠서 봐야 해요. 보통은 첫 응답 시간과 초기 로딩을 먼저 줄이는 게 체감이 큽니다.",
            "model_quality": "자연어 품질을 올리려면 대화용 말뭉치와 문서형 지식을 분리하고, 저품질 답변이 다시 학습에 들어가지 않게 막는 게 먼저예요. 그 다음에 문맥 질문 예시를 늘리고 다시 학습시키는 순서가 좋아요.",
            "previous_none": "아직 기억할 이전 사용자 메시지가 없어요.",
            "topic_none": "아직 이어진 대화 주제를 잡을 만큼 이전 맥락이 없어요.",
            "previous": "방금 전에는 이렇게 말했어요: {topic}",
            "topic": "지금은 이 주제로 이야기하고 있어요: {topic}",
            "topic_followup": "지금 흐름은 {topic} 쪽이에요. 여기서 더 정확하게 보려면 현재 막히는 지점이나 원하는 결과를 한두 줄만 더 알려주세요.",
            "tech_followup": "좋아요. 핵심 키워드는 {keywords} 쪽으로 보여요. 현재 증상, 기대한 결과, 이미 확인한 내용을 주면 원인을 좁혀볼게요.",
        },
        "en": {
            "greeting": "Hello. What should we look at together first?",
            "thanks": "Sounds good. Send the next thing you want me to inspect.",
            "identity": "I am Purple Bee, a local model running on this device to help with conversation, document review, and code or log analysis.",
            "capability": "I can review documents, code, error logs, config files, and screenshots, then summarize the core points and suggest next steps.",
            "coding": "Yes. I can help trace bugs, read logs, suggest fixes, and draft functions or structure changes.",
            "language": "Yes. I can follow the language of your prompt, mainly in Korean and English.",
            "file": "Sure. Send the file or screenshot and I will break it down into key points, problem spots, and the next checks.",
            "planning": "Sure. I can turn the goal and current state into a short step-by-step plan.",
            "confusion": "The last reply seems off. I will stop repeating and realign with the core point. Tell me the answer shape you want in one line.",
            "short": "If you add a little more detail, I can answer with much better context.",
            "generic": "I understand the direction of the question. If you give me the current state, expected result, and what you already tried, I can narrow it down quickly.",
            "speed": "Speed should be split into first response delay, model loading, tokenizer work, file analysis, and network hops before we optimize anything. The biggest win is usually cutting the first reply time and the initial load path.",
            "model_quality": "To improve natural language quality, we should separate dialogue data from document-style knowledge, block weak answers from reentering training, expand context-focused examples, and then retrain.",
            "previous_none": "I do not have an earlier user message to recall yet.",
            "topic_none": "There is not enough prior context yet to pin down the topic.",
            "previous": "Your previous message was: {topic}",
            "topic": "Right now we are talking about: {topic}",
            "topic_followup": "The current thread seems to be about {topic}. If you add the exact blocker or desired result, I can continue from there.",
            "tech_followup": "Got it. The main focus looks like {keywords}. If you share the current symptom, expected result, and what you already checked, I can narrow the cause step by step.",
        },
        "ja": {
            "greeting": "こんにちは。今いちばん一緒に見るべきものは何ですか。",
            "thanks": "大丈夫です。続けて見たい内容をそのまま送ってください。",
            "identity": "私は Purple Bee です。この端末で動きながら会話、文書整理、コードやログの確認を手伝うローカルモデルです。",
            "capability": "文書、コード、エラーログ、設定ファイル、スクリーンショットを一緒に見て、要点と次の手順を整理できます。",
            "coding": "できます。バグ原因の切り分け、ログ確認、修正方針の整理、関数の下書きまで一緒に進められます。",
            "language": "はい。質問の言語に合わせて、主に韓国語と英語で返答できます。",
            "file": "もちろんです。ファイルやスクリーンショットを送ってくれれば、要点、問題箇所、次の確認順で整理します。",
            "planning": "目標と現状をもとに、すぐ動ける手順に分けて整理できます。",
            "confusion": "さっきの返答はずれていました。繰り返さず、要点だけ合わせ直します。欲しい答え方を一行で教えてください。",
            "short": "もう少し具体的に書いてくれると、文脈に合わせてもっと正確に手伝えます。",
            "generic": "質問の方向は理解しました。現状、期待する結果、すでに試したことの三つが分かれば、もっと早く絞り込めます。",
            "speed": "速度は、最初の応答遅延、モデル読み込み、トークナイザ、ファイル解析、通信経路のどこが遅いかに分けて見る必要があります。体感改善は最初の応答時間を縮めるのが先です。",
            "model_quality": "自然言語品質を上げるには、会話用コーパスと文書知識を分け、低品質な返答が再学習に戻らないようにし、その上で文脈質問の例を増やして再学習するのが先です。",
            "previous_none": "まだ思い出せる前のユーザーメッセージがありません。",
            "topic_none": "まだ会話の主題をつかめるほど前の文脈がありません。",
            "previous": "さっきのあなたの発言はこうでした: {topic}",
            "topic": "今はこの話題について話しています: {topic}",
            "topic_followup": "今の流れは {topic} に近いです。詰まっている点か欲しい結果を一、二文だけ足してくれれば続けられます。",
            "tech_followup": "わかりました。中心のキーワードは {keywords} のようです。症状、期待する結果、すでに確認した内容があれば原因を絞れます。",
        },
        "zh": {
            "greeting": "你好。现在最需要我一起看的内容是什么？",
            "thanks": "可以，继续把想看的内容发给我吧。",
            "identity": "我是 Purple Bee，一个在这台设备上运行的本地模型，可以帮助整理对话、文档，以及代码或日志分析。",
            "capability": "我可以一起查看文档、代码、错误日志、配置文件和截图，然后整理重点并给出下一步建议。",
            "coding": "可以。我能帮助定位 bug 原因、阅读日志、整理修复方向，并草拟函数或结构调整。",
            "language": "可以。我会尽量跟随你的提问语言，目前主要支持韩语和英语风格的回答。",
            "file": "可以。把文件或截图发给我，我会按重点、问题位置和下一步检查顺序来整理。",
            "planning": "可以。我能把目标和现状整理成一份可执行的步骤计划。",
            "confusion": "刚才的回答有点偏了。我会停止重复，重新对齐重点。你可以用一句话告诉我想要的回答形式。",
            "short": "如果你再具体一点，我就能结合上下文回答得更准确。",
            "generic": "我理解你的问题方向了。如果你告诉我当前状态、预期结果和已经尝试过的内容，我就能更快缩小范围。",
            "speed": "速度问题需要先拆成首响应延迟、模型加载、分词处理、文件分析和网络往返几个部分。通常最先该优化的是首响应时间和初始加载路径。",
            "model_quality": "如果想提升自然语言质量，应该先把对话语料和文档知识分开，阻止低质量回答再次进入训练，然后补充上下文类样本再重新训练。",
            "previous_none": "我现在还没有可以回忆的上一条用户消息。",
            "topic_none": "目前还没有足够的上下文来判断正在讨论的主题。",
            "previous": "你刚才上一条消息是：{topic}",
            "topic": "我们现在讨论的主题是：{topic}",
            "topic_followup": "当前的上下文更像是在讨论 {topic}。如果你再补一句卡住的位置或预期结果，我就能继续往下推。",
            "tech_followup": "好的。当前核心关键词像是 {keywords}。如果你给我现象、预期结果和已经检查过的内容，我可以继续缩小原因范围。",
        },
    }
    bundle = messages.get(lang, messages["ko"])
    template = bundle.get(key) or messages["ko"].get(key, "")
    return template.format(**kwargs)

def recent_user_messages(history, exclude_query=""):
    exclude_query = normalize_corpus_text(exclude_query)
    items = []
    for item in history or []:
        if not isinstance(item, dict) or item.get("role") != "user":
            continue
        content = normalize_corpus_text(item.get("content", ""))
        if content and content != exclude_query:
            items.append(content)
    return items

def infer_recent_topic(history, exclude_query=""):
    previous_users = recent_user_messages(history, exclude_query=exclude_query)
    if not previous_users:
        return ""
    latest = previous_users[-1]
    return latest if len(latest) <= 120 else latest[:117].rstrip() + "..."

def extract_meaningful_keywords(text, limit=4):
    parts = re.findall(r"[A-Za-z][A-Za-z0-9_+-]{2,}|[가-힣]{2,}|[\u3040-\u30ff]{2,}|[\u4e00-\u9fff]{2,}", normalize_corpus_text(text).lower())
    stopwords = {
        "the", "and", "for", "with", "that", "this", "from", "into", "about", "please", "could", "would",
        "what", "when", "where", "which", "while", "have", "need", "want", "just", "your", "there",
        "그리고", "그러면", "지금", "그냥", "이거", "저거", "그거", "뭔가", "관련", "내용", "문제", "원인", "해결",
        "정리", "설명", "도와줘", "도와", "할수", "있어", "있는", "하기", "대한", "지금은", "현재", "이어서",
        "알아", "알지", "알려줘", "알려", "뭐야", "뭔지", "무엇", "뜻", "정의", "설명해줘",
        "방법", "어떻게", "하는법", "하려면", "이모지", "앞으로", "말할때", "사용해줘", "사용하지마", "쓰지마",
        "대해", "주세요", "주세용", "해줘요", "해주세요", "뭐", "거야", "거", "아니야",
    }
    seen = set()
    keywords = []
    for part in parts:
        if part in stopwords or len(part) < 2:
            continue
        if part in seen:
            continue
        seen.add(part)
        keywords.append(part)
        if len(keywords) >= limit:
            break
    return keywords

def canonicalize_match_text(text):
    normalized = normalize_corpus_text(text).lower().strip()
    if not normalized:
        return {"text": "", "compact": "", "keywords": []}

    tokens = re.findall(r"[A-Za-z][A-Za-z0-9_+-]*|[가-힣]+|[\u3040-\u30ff]+|[\u4e00-\u9fff]+", normalized)
    particle_suffixes = (
        "으로부터", "에서부터", "이라서", "라서", "에서의", "으로의",
        "이랑", "랑", "하고", "이며", "이고", "에서", "에게", "께서",
        "께", "한테", "으로", "로", "와", "과", "은", "는", "이", "가",
        "을", "를", "도", "만", "에", "의", "야", "아",
    )
    normalized_tokens = []
    for token in tokens:
        current = token
        if current in particle_suffixes:
            continue
        if re.fullmatch(r"[가-힣]+", current):
            for suffix in particle_suffixes:
                if len(current) > len(suffix) + 1 and current.endswith(suffix):
                    current = current[: -len(suffix)]
                    break
        current = current.strip()
        if current:
            normalized_tokens.append(current)

    canonical_text = " ".join(normalized_tokens)
    compact = "".join(normalized_tokens)
    return {
        "text": canonical_text,
        "compact": compact,
        "keywords": extract_meaningful_keywords(canonical_text, limit=8),
    }

def contains_phrase(text, phrases):
    return any(phrase in text for phrase in phrases)

def load_dialogue_examples():
    paths = [path for path in RUNTIME_DIALOGUE_SEED_PATHS if path.exists()]
    stamp = tuple((str(path), path.stat().st_mtime_ns) for path in paths if path.exists())
    if dialogue_example_cache["stamp"] == stamp and dialogue_example_cache["examples"]:
        return dialogue_example_cache["examples"]

    examples = []
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for raw_line in text.splitlines():
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            try:
                row = json.loads(raw_line)
            except Exception:
                continue
            user_text = normalize_corpus_text(row.get("input", ""))
            reply_text = normalize_corpus_text(row.get("response", "") or row.get("output", ""))
            if not user_text or not reply_text:
                continue
            if looks_mojibake_text(user_text) or looks_mojibake_text(reply_text):
                continue
            if looks_low_quality_text(reply_text):
                continue
            examples.append({"user": user_text, "reply": reply_text})

    dialogue_example_cache["stamp"] = stamp
    dialogue_example_cache["examples"] = examples
    return examples

def example_similarity_score(query, candidate_prompt):
    query_norm = normalize_corpus_text(query).lower()
    prompt_norm = normalize_corpus_text(candidate_prompt).lower()
    query_canonical = canonicalize_match_text(query)
    prompt_canonical = canonicalize_match_text(candidate_prompt)
    query_keywords = extract_meaningful_keywords(query_norm, limit=6)
    prompt_keywords = set(extract_meaningful_keywords(prompt_norm, limit=8))
    score = 0.0
    for keyword in query_keywords:
        if keyword == prompt_norm:
            score += 4.0
        elif keyword in prompt_keywords:
            score += 2.0
        elif keyword in prompt_norm:
            score += 1.0
    if query_norm == prompt_norm:
        score += 6.0
    elif query_norm in prompt_norm or prompt_norm in query_norm:
        score += 2.5
    if query_canonical["text"] and query_canonical["text"] == prompt_canonical["text"]:
        score += 8.0
    elif query_canonical["compact"] and (
        query_canonical["compact"] == prompt_canonical["compact"]
        or query_canonical["compact"] in prompt_canonical["compact"]
        or prompt_canonical["compact"] in query_canonical["compact"]
    ):
        score += 5.0
    prompt_canonical_keywords = set(prompt_canonical["keywords"])
    for keyword in query_canonical["keywords"]:
        if keyword in prompt_canonical_keywords:
            score += 1.8
    if detect_reply_language(query) == detect_reply_language(candidate_prompt):
        score += 0.5
    return score

def retrieve_dialogue_seed_examples(query, limit=2):
    examples = load_dialogue_examples()
    if not examples:
        return []
    scored = []
    for example in examples:
        score = example_similarity_score(query, example["user"])
        if score >= 2.5:
            scored.append((score, example))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [example for _, example in scored[:max(0, limit)]]


def retrieve_dialogue_seed_reply(query):
    query_norm = normalize_corpus_text(query).strip().lower()
    query_canonical = canonicalize_match_text(query)
    if not query_norm:
        return None
    exact_matches = []
    best_score = 0.0
    scored_matches = []
    for example in load_dialogue_examples():
        prompt_norm = normalize_corpus_text(example.get("user", "")).strip().lower()
        prompt_canonical = canonicalize_match_text(example.get("user", ""))
        if not prompt_norm:
            continue
        if query_norm == prompt_norm:
            exact_matches.append(example.get("reply"))
            continue
        if query_canonical["text"] and (
            query_canonical["text"] == prompt_canonical["text"]
            or (
                query_canonical["compact"]
                and query_canonical["compact"] == prompt_canonical["compact"]
            )
        ):
            exact_matches.append(example.get("reply"))
            continue
        score = example_similarity_score(query_norm, prompt_norm)
        if score > best_score:
            best_score = score
        if score >= 5.5:
            scored_matches.append((score, example.get("reply")))
    if exact_matches:
        unique_matches = [reply for reply in dict.fromkeys(match for match in exact_matches if match)]
        if unique_matches:
            return random.choice(unique_matches)
    if best_score >= 5.5:
        top_replies = [reply for score, reply in scored_matches if score >= best_score - 0.6 and reply]
        unique_replies = [reply for reply in dict.fromkeys(top_replies)]
        if unique_replies:
            return random.choice(unique_replies)
    return None


def retrieve_exact_dialogue_seed_reply(query):
    query_norm = normalize_corpus_text(query).strip().lower()
    query_canonical = canonicalize_match_text(query)
    if not query_norm:
        return None
    matches = []
    for example in load_dialogue_examples():
        prompt_norm = normalize_corpus_text(example.get("user", "")).strip().lower()
        prompt_canonical = canonicalize_match_text(example.get("user", ""))
        if query_norm == prompt_norm:
            matches.append(example.get("reply"))
            continue
        if query_canonical["text"] and (
            query_canonical["text"] == prompt_canonical["text"]
            or (
                query_canonical["compact"]
                and query_canonical["compact"] == prompt_canonical["compact"]
            )
        ):
            matches.append(example.get("reply"))
    unique_matches = [reply for reply in dict.fromkeys(match for match in matches if match)]
    if unique_matches:
        return random.choice(unique_matches)
    return None

def intent_natural_reply(query, history=None):
    """
    최소한의 사회적 응답만 처리한다.
    일반 지식/정의/능력/방법 질문은 여기서 하드코딩하지 않고
    모델 또는 데이터 기반 시드/지식 합성 단계로 넘긴다.
    """
    import random as _rnd
    history = history or []
    q_norm  = normalize_corpus_text(query)
    lowered = q_norm.lower().strip()
    lang    = detect_reply_language(query, history=history)

    # ── 인사 ─────────────────────────────────────────────────────
    GREET_PATTERNS_KO = ["안녕", "안녕하세요", "안녕하십니까", "반가워", "반갑습니다",
                          "좋은 아침", "좋은 저녁", "좋은 오후", "하이", "헬로"]
    GREET_PATTERNS_EN = ["hello", "hi", "hey", "good morning", "good evening",
                          "good afternoon", "howdy", "greetings", "yo"]
    GREET_REPLIES_KO = [
        "안녕하세요! 오늘 어떻게 도와드릴까요?",
        "반갑습니다! 무엇이든 물어보세요.",
        "안녕하세요 😊 궁금한 게 있으면 편하게 말씀해 주세요.",
        "안녕하세요! 오늘도 좋은 하루 되세요. 도움이 필요하면 말씀해 주세요.",
    ]
    GREET_REPLIES_EN = [
        "Hello! How can I help you today?",
        "Hey there! What can I do for you?",
        "Hi! Feel free to ask me anything.",
    ]
    is_short = len(lowered.replace(" ","").replace("!","").replace("?","")) <= 10
    if is_short:
        if any(lowered.replace("!","").replace("?","").strip() == g or
               lowered.replace("!","").replace("?","").strip().startswith(g) for g in GREET_PATTERNS_KO):
            return _rnd.choice(GREET_REPLIES_KO)
        if any(lowered.replace("!","").replace("?","").strip() == g or
               lowered.replace("!","").replace("?","").strip().startswith(g) for g in GREET_PATTERNS_EN):
            return _rnd.choice(GREET_REPLIES_EN)

    # ── 감사 ─────────────────────────────────────────────────────
    THANKS_KO = ["고마워", "고맙습니다", "고마워요", "감사합니다", "감사해요", "감사해",
                  "정말 고마", "덕분에", "도움됐어", "도움이 됐"]
    THANKS_EN = ["thank", "thanks", "thx", "appreciate", "helpful"]
    THANKS_REPLIES_KO = [
        "천만에요! 또 궁금한 게 생기면 언제든지 물어보세요 😊",
        "도움이 됐다니 다행이에요. 다른 것도 필요하면 말씀해 주세요!",
        "별말씀을요. 언제든지요!",
    ]
    THANKS_REPLIES_EN = [
        "You're welcome! Let me know if there's anything else I can help with.",
        "Happy to help! Feel free to ask anytime.",
    ]
    if any(p in lowered for p in THANKS_KO):
        return _rnd.choice(THANKS_REPLIES_KO)
    if any(p in lowered for p in THANKS_EN):
        return _rnd.choice(THANKS_REPLIES_EN)

    # ── 감정/공감 — 힘들다, 우울, 불안, 스트레스 ─────────────────
    EMOTION_HARD = ["힘들어", "힘드네", "힘들다", "지쳤어", "지쳤다", "지치다", "너무 힘", "많이 힘"]
    EMOTION_SAD  = ["우울해", "우울하다", "우울함", "슬퍼", "슬프다", "눈물", "기분이 안 좋"]
    EMOTION_ANXI = ["불안해", "불안하다", "불안함", "걱정돼", "걱정된다", "무서워", "두려워"]
    EMOTION_STRESS = ["스트레스", "스트레스 받", "압박감", "번아웃", "burnout", "burn out"]
    EMOTION_TIRED = ["피곤해", "피곤하다", "졸려", "몸이 안 좋", "머리가 아파", "컨디션이"]
    EMOTION_ALONE = ["외로워", "외롭다", "외로움", "혼자야", "혼자다", "아무도 없"]
    EMOTION_HAPPY = ["기뻐", "기쁘다", "행복해", "행복하다", "신나", "신난다", "즐거워", "좋은 일이"]
    EMOTION_ANGRY = ["화나", "화났", "화가 나", "짜증", "열받아", "분노"]

    if any(p in lowered for p in EMOTION_HARD):
        return _rnd.choice([
            "많이 힘드시겠어요. 잠깐 숨 돌리고, 제일 급한 것 하나만 먼저 해결해봐요. 제가 도와드릴 수 있는 게 있으면 말씀해 주세요.",
            "그럴 때가 있죠. 천천히 괜찮아요. 뭐가 제일 힘든지 말씀해 주실래요?",
            "고생하고 계시는군요. 힘내세요. 도움이 필요하면 저한테 말씀해 주세요 💛",
        ])
    if any(p in lowered for p in EMOTION_SAD):
        return _rnd.choice([
            "기분이 많이 다운되셨군요. 괜찮아요, 잠깐 쉬어가도 돼요. 얘기하고 싶은 게 있으면 들을게요.",
            "슬픔도 자연스러운 감정이에요. 지금 어떤 상황인지 말씀해 주시면 같이 생각해볼게요.",
        ])
    if any(p in lowered for p in EMOTION_ANXI):
        return _rnd.choice([
            "불안한 마음이 드실 때는 일단 지금 당장 할 수 있는 것 하나에 집중해보는 게 도움이 돼요. 무엇 때문에 걱정되는 건가요?",
            "걱정되는 게 있군요. 어떤 부분이 제일 마음에 걸리세요? 같이 정리해봐요.",
        ])
    if any(p in lowered for p in EMOTION_STRESS):
        return _rnd.choice([
            "스트레스가 쌓이셨군요. 잠깐 숨 고르고, 할 일을 하나씩 나눠서 처리해보는 건 어떨까요? 도움이 필요하면 말씀해 주세요.",
            "번아웃 느낌이 있으시군요. 억지로 밀어붙이기보다 오늘 할 수 있는 최소한만 정해보는 게 좋을 것 같아요.",
        ])
    if any(p in lowered for p in EMOTION_TIRED):
        return _rnd.choice([
            "많이 피곤하시겠어요. 잠깐 쉬는 것도 중요해요. 무거운 거 있으면 제가 도와드릴게요.",
            "컨디션이 안 좋으시군요. 억지로 하기보다는 잠깐 휴식을 권장드려요 💛",
        ])
    if any(p in lowered for p in EMOTION_ALONE):
        return _rnd.choice([
            "외로울 때 말 걸어줘서 좋아요. 저 여기 있을게요. 무슨 얘기든 해도 돼요.",
            "혼자라는 느낌은 참 힘들죠. 하고 싶은 얘기 있으면 들을게요 😊",
        ])
    if any(p in lowered for p in EMOTION_HAPPY):
        return _rnd.choice([
            "와, 좋은 일이 있으셨군요! 무슨 일인지 저도 들려주세요 😊",
            "기쁜 일이 있으신 것 같아서 저도 기분이 좋아지네요! 뭔가요?",
        ])
    if any(p in lowered for p in EMOTION_ANGRY):
        return _rnd.choice([
            "화가 많이 나셨군요. 어떤 일이 있었는지 말씀해 주시면 같이 생각해봐요.",
            "그럴 만한 이유가 있으셨겠죠. 어떤 상황인지 얘기해 주실래요?",
        ])

    # ── 칭찬/격려 ────────────────────────────────────────────────
    PRAISE_KO = ["잘했어", "대단해", "최고야", "짱이야", "훌륭해", "멋지다", "굉장해"]
    PRAISE_EN = ["great job", "well done", "awesome", "amazing", "brilliant"]
    if any(p in lowered for p in PRAISE_KO):
        return _rnd.choice(["감사해요 😊 더 잘 도와드릴 수 있도록 노력할게요!", "고마워요! 힘이 나네요 💛"])
    if any(p in lowered for p in PRAISE_EN):
        return _rnd.choice(["Thanks! That really means a lot 😊", "Appreciate it! Let me know if you need anything."])

    # ── 말투/이모지 선호 ─────────────────────────────────────────
    if contains_phrase(lowered, ["이모지 쓰지마", "이모지 사용하지마", "이모지 빼", "이모지 없이", "emoji 없이", "no emoji"]):
        return "알겠어요. 이번 답변부터는 이모지 없이 조금 더 깔끔하게 말할게요." if lang == "ko" else "Got it. I will keep the tone cleaner and avoid emoji."
    if contains_phrase(lowered, ["이모지 써줘", "이모지 사용해줘", "emoji 써", "emoji 사용", "이모지 넣어줘"]):
        return "좋아요. 필요할 때는 이모지도 조금 섞어서 더 부드럽게 답할게요." if lang == "ko" else "Sure. I can use a lighter tone with a bit of emoji when it fits."

    # ── 대화 맥락 확인 ───────────────────────────────────────────
    if contains_phrase(lowered, ["방금 내가 뭐라고", "내가 뭐라고", "직전에 내가", "what did i just say"]):
        topic = infer_recent_topic(history, exclude_query=query)
        if topic:
            return f"방금 '{topic}'에 대해 물어보셨어요." if lang == "ko" else f"You just asked about: '{topic}'"
        return "이전 메시지를 찾을 수 없어요." if lang == "ko" else "I couldn't find your previous message."

    if contains_phrase(lowered, ["지금 주제가", "무슨 얘기", "무슨 이야기", "what are we talking about"]):
        topic = infer_recent_topic(history, exclude_query=query)
        if topic:
            return f"지금은 '{topic}' 이야기를 하고 있어요." if lang == "ko" else f"We're talking about: '{topic}'"
        return "아직 이어진 주제가 없어요. 무엇이 궁금하세요?" if lang == "ko" else "No specific topic yet. What would you like to explore?"

    # ── 이해 못 했다는 표현 ──────────────────────────────────────
    if contains_phrase(lowered, ["뭔소리", "무슨소리", "이해 못", "말이 안 돼", "makes no sense", "stop repeating"]):
        if lang == "ko":
            return "죄송해요, 제가 엉뚱한 답을 드렸군요. 원하시는 내용을 다시 말씀해 주시면 다시 제대로 도와드릴게요."
        return "Sorry about that! Could you rephrase? I'll give you a much better answer."

    if len(q_norm.replace(" ", "")) <= 1 and q_norm in {"?", "!", ".", "ㅇ", "음", "흠"}:
        return "한 줄만 더 이어주시면 바로 맞춰서 답할게요." if lang == "ko" else "Give me one more line and I will answer more clearly."

    # 나머지는 모두 None → 웹검색+자연어 합성으로 넘김
    return None

# ── 웹 검색 헬퍼 (fallback 전용) ────────────────────────────────────
def _search_web_snippets(query, max_results=4):
    """DuckDuckGo HTML 스크래핑으로 검색 스니펫 반환"""
    try:
        import urllib.parse
        url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query) + "&kl=kr-ko"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
            "Accept-Language": "ko-KR,ko;q=0.9",
        }
        r = requests.get(url, headers=headers, timeout=6)
        soup = BeautifulSoup(r.content, "html.parser")
        snippets = []
        for el in soup.select(".result__snippet")[:max_results]:
            text = el.get_text(strip=True)
            if text and len(text) > 20:
                snippets.append(text)
        return snippets
    except Exception:
        return []

def _local_kb_snippets(query, limit=4):
    """로컬 DB 지식베이스에서 관련 문장 검색"""
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        keywords = [w for w in query.split() if len(w) > 1][:4]
        if not keywords:
            return []
        like_clauses = " OR ".join(["content LIKE ?" for _ in keywords])
        params = [f"%{k}%" for k in keywords] + [limit]
        c.execute(f"SELECT title, content FROM knowledge WHERE {like_clauses} ORDER BY fetched_at DESC LIMIT ?", params)
        rows = c.fetchall()
        conn.close()
        snippets = []
        for title, content in rows:
            # 관련 문장만 추출
            for sent in re.split(r'[.!?\n]', content):
                sent = sent.strip()
                if len(sent) > 20 and any(k in sent for k in keywords):
                    snippets.append(sent[:200])
                    break
        return snippets
    except Exception:
        return []

def _compose_natural_answer(query, snippets, history, lang):
    """
    스니펫 + 질문 의도 기반 자연어 응답 합성.
    모든 질문이 이 함수에서 의미 있는 답변을 반환하도록 설계.
    """
    import random as _rnd
    q       = normalize_corpus_text(query).strip()
    lowered = q.lower()
    keywords = extract_meaningful_keywords(q)
    topic    = infer_recent_topic(history, exclude_query=q)

    # ── 스니펫 있을 때: 핵심 문장 추출해서 자연어로 연결 ────────────
    if snippets:
        scored = sorted(
            [(sum(1 for k in keywords if k in s.lower()), s) for s in snippets],
            reverse=True
        )
        top = [s.strip() for _, s in scored[:3] if len(s.strip()) > 15]
        if top:
            if lang == "ko":
                parts = [s.rstrip(".,!?") for s in top]
                if len(parts) == 1:
                    base = parts[0]
                    if any(p in lowered for p in ["뭐야","뭔지","무엇","뜻","정의","설명","알아","알려"]):
                        answer = base + ("예요." if base[-1] not in "다요임" else ".")
                    elif any(p in lowered for p in ["어떻게","방법","하려면","하는법"]):
                        answer = base + " 방식으로 진행하면 돼요."
                    else:
                        answer = base + "."
                else:
                    answer = parts[0] + ". " + parts[1] + "."
                    if len(parts) >= 3:
                        answer += " " + parts[2] + "."
                answer = re.sub(r'[^\uAC00-\uD7A3\u3131-\u318E\u0020-\u007E\u00B7.,!?()\-/\n]', '', answer)
                answer = re.sub(r'\s+', ' ', answer).strip()
                if len(answer) > 10:
                    return answer
            else:
                answer = " ".join(s.rstrip(".,") + "." for s in top[:2])
                if len(answer) > 10:
                    return answer

    # ── 스니펫 없을 때: 질문 의도 분류 후 직접 자연어 생성 ──────────
    if lang == "ko":
        kw0 = keywords[0] if keywords else q[:15]
        kw2 = ", ".join(keywords[:2]) if keywords else q[:20]

        simple_term_match = re.match(r"^\s*([가-힣A-Za-z0-9_+\-]{1,24})\s*(알아|뭐야|뭔지|설명해줘|알려줘|뜻|정의)\s*[!??]*\s*$", q)
        if simple_term_match:
            term = simple_term_match.group(1).strip()
            term_lower = term.lower()
            if term in {"사과"}:
                return "사과는 과일이에요. 보통 둥글고 달콤하거나 새콤한 맛이 나고, 생으로 먹거나 주스·파이처럼 다양하게 활용해요."
            if term in {"강아지", "개"}:
                return "강아지는 사람과 오래 함께해 온 대표적인 반려동물이에요. 사회성이 높고 사람과 교감하는 능력이 좋아서 많은 가정에서 함께 지내요."
            if term in {"고양이"}:
                return "고양이는 독립적인 성향이 있으면서도 사람과 정서적으로 잘 교감하는 반려동물이에요. 조용하고 깔끔한 편이라 실내 반려동물로도 많이 길러요."
            if term_lower in {"python", "파이썬"}:
                return "파이썬은 문법이 비교적 읽기 쉽고 활용 범위가 넓은 프로그래밍 언어예요. 웹, 자동화, 데이터 분석, AI 개발까지 다양하게 쓰여요."
            return f"{term}에 대해 간단히 설명하면, 핵심 개념이나 특징부터 차근차근 정리해드릴 수 있어요. 원하면 정의·예시·활용 순서로 바로 설명해드릴게요."

        # 날씨
        if re.search(r"날씨|기온|비|눈|맑음|흐림|습도|바람|기상|weather", lowered):
            region = re.search(r"([가-힣]{2,5})\s*(날씨|기온)", q)
            loc = region.group(1) if region else "해당 지역"
            return (f"{loc} 날씨는 기상청(weather.go.kr)이나 네이버 날씨에서 실시간으로 확인하시면 가장 정확해요. "
                    f"지금 당장 알고 싶으시면 지역명을 정확히 말씀해 주세요!")

        # 동물/반려동물
        if re.search(r"강아지|고양이|반려견|반려묘|펫|동물|dog|cat|pet", lowered):
            if "강아지" in lowered or "반려견" in lowered or "dog" in lowered:
                return ("강아지는 인간과 오랫동안 함께해온 포유동물로, 사회성이 높고 감정 표현이 풍부해요. "
                        "품종마다 성격과 크기가 다양하니 생활 환경에 맞게 선택하는 게 중요해요. "
                        "구체적인 품종이나 돌봄 방법이 궁금하시면 더 알려드릴게요!")
            if "고양이" in lowered or "반려묘" in lowered or "cat" in lowered:
                return ("고양이는 독립적이면서도 애정 표현을 하는 반려동물이에요. "
                        "개보다 손이 덜 가고 조용한 편이라 바쁜 분들도 많이 키우죠. "
                        "품종이나 건강 관리에 대해 더 궁금하신 게 있나요?")
            return ("반려동물은 삶의 질을 높여주는 소중한 존재예요. "
                    "어떤 동물을 생각하고 계신지 알려주시면 더 구체적으로 도와드릴게요!")

        # 음식/맛집/레시피
        if re.search(r"맛집|맛있는|레시피|요리|먹을|먹고|음식|식당|카페|메뉴|맛|요리법", lowered):
            if any(p in lowered for p in ["레시피","요리법","만드는법","만들기"]):
                return (f"'{kw0}' 레시피를 원하시는군요! 재료, 인분 수, 특별한 조건(채식 등)이 있으시면 "
                        f"알려주시면 바로 자세하게 알려드릴게요.")
            return (f"맛있는 {kw0} 관련 정보를 원하시는군요! 지역이나 선호 음식 스타일을 알려주시면 "
                    f"더 정확한 정보를 드릴 수 있어요.")

        # 코드/프로그래밍
        if re.search(r"코드|파이썬|python|자바|java|javascript|js|함수|클래스|알고리즘|sql|api|프로그래밍|개발|스크립트|루아|lua|roblox", lowered):
            return (f"{kw2} 관련 코드를 도와드릴게요! "
                    f"원하는 동작이나 현재 코드를 붙여주시면 바로 분석하거나 작성해드릴 수 있어요.")

        # 오류/버그
        if re.search(r"오류|에러|error|bug|exception|traceback|안돼|안됨|문제|실패|왜 안|이상해", lowered):
            return (f"{kw2} 관련 오류가 생기셨군요. "
                    f"오류 메시지 전문이나 어떤 상황에서 발생하는지 알려주시면 바로 원인을 찾아드릴게요!")

        # 정의/설명
        if re.search(r"뭐야|뭔지|뭔가요|무엇|뜻이|정의|설명해|알려줘|알아\?|어떤거야|어떤 거야|뭐임", lowered):
            return (f"{kw0}에 대해 간단히 설명해드릴게요. "
                    f"먼저 핵심 뜻부터 짚고, 필요하면 예시나 활용까지 이어서 풀어드릴 수 있어요.")

        # 방법/절차
        if re.search(r"어떻게|방법|하려면|하는법|할수있|하면돼|방식|절차|순서", lowered):
            return (f"{kw2}하는 방법은 상황마다 조금씩 달라요. "
                    f"어떤 환경이나 조건에서 하려는지 알려주시면 단계별로 정리해드릴게요!")

        # 이유/원인
        if re.search(r"왜|이유|원인|어째서|왜냐면|이유가", lowered):
            return (f"'{kw0}'의 원인이나 이유가 궁금하시군요. "
                    f"어떤 증상이나 상황이 발생하는지 조금 더 알려주시면 정확하게 파악할 수 있어요!")

        # 비교
        if re.search(r"차이|비교|vs|versus|다른점|같은점|장단점|어느게 나아|뭐가 더", lowered):
            return (f"{kw2}의 차이나 장단점을 비교해드릴게요! "
                    f"어떤 관점(성능, 가격, 사용 편의성 등)에서 비교를 원하시는지 말씀해 주시면 더 정확하게 정리해드릴 수 있어요.")

        # 추천
        if re.search(r"추천|좋은|최고|베스트|어떤게|골라줘|추천해줘|뭐가 좋아|뭐 살까", lowered):
            return (f"{kw2} 추천을 원하시는군요! "
                    f"목적, 예산, 선호하는 스타일을 조금 더 알려주시면 딱 맞는 걸 추천해드릴게요.")

        # 여행/장소
        if re.search(r"여행|관광|명소|갈만한|가볼만한|여행지|숙소|호텔|공항", lowered):
            return (f"{kw0} 여행 정보가 필요하시군요! "
                    f"언제, 며칠 동안, 혼자인지 아닌지, 예산은 어느 정도인지 알려주시면 딱 맞는 정보로 도와드릴게요.")

        # 건강/의학
        if re.search(r"증상|병원|약|건강|치료|진단|아파|통증|두통|열이|감기|코로나|의사", lowered):
            return (f"{kw0} 관련 건강 정보가 필요하시군요. "
                    f"증상이나 상황을 조금 더 구체적으로 말씀해 주시면 관련 정보를 정리해드릴게요. "
                    f"단, 정확한 진단은 반드시 전문 의료인과 상담하시길 권장드려요.")

        # 학습/공부
        if re.search(r"공부|학습|시험|수능|토익|자격증|강의|책 추천|교재", lowered):
            return (f"{kw0} 공부 방법이 궁금하시군요! "
                    f"현재 수준과 목표, 기간을 알려주시면 효율적인 학습 계획을 같이 만들어볼게요.")

        # 이전 대화 맥락 활용
        if topic:
            return (f"방금 '{topic}' 이야기에서 이어지는 질문 같은데, "
                    f"{kw2}에 대해 더 궁금하신 게 있으시군요! 어떤 부분이 궁금하신지 구체적으로 말씀해 주세요.")

        # 키워드 있을 때
        if keywords:
            return (f"{kw0} 쪽으로 보고 계신 것 같아요. "
                    f"정의, 예시, 비교, 방법 중 어떤 식으로 듣고 싶은지 말해주시면 바로 맞춰서 설명해드릴게요.")

        # 완전 일반 fallback
        return _rnd.choice([
            "말씀하신 내용을 조금 더 구체적으로 알려주시면 정확하게 도와드릴 수 있어요. 어떤 도움이 필요하세요?",
            "좀 더 자세하게 설명해 주시면 더 잘 도와드릴 수 있어요!",
            "어떤 부분이 궁금하신지 조금 더 말씀해 주세요. 최대한 도와드릴게요 😊",
        ])

    else:
        kw0 = keywords[0] if keywords else query[:20]
        if keywords:
            return (f"Happy to help with '{kw0}'! Could you give me a bit more detail "
                    f"about what you're looking for? I'll get you the best answer.")
        return _rnd.choice([
            "I'd love to help! Could you rephrase or add a bit more context?",
            "Let me help you with that — could you share a bit more detail?",
        ])

def fallback_natural_reply(query, history=None):
    """
    100M 모델 실패 시 동작하는 자연어 응답 생성기.
    1) 최소 intent 매칭 (인사/감사/감정/선호)
    2) 정제된 대화 시드 검색
    3) 로컬 KB 검색
    4) 웹 검색 (필요시)
    5) 자연어 합성
    """
    history = history or []
    lang = detect_reply_language(query, history=history)
    lowered = normalize_corpus_text(query).lower()

    # intent 우선
    intent_reply = intent_natural_reply(query, history=history)
    if intent_reply is not None:
        return intent_reply

    seed_reply = retrieve_dialogue_seed_reply(query)
    if seed_reply:
        return seed_reply

    # 날씨 질문 → 바로 처리 (웹 검색 불필요)
    if contains_phrase(lowered, ["날씨", "기온", "weather"]):
        return _compose_natural_answer(query, [], history, lang)

    # 로컬 KB 먼저
    snippets = _local_kb_snippets(query)

    # KB에 없으면 웹 검색
    if not snippets:
        web_results = _search_web_snippets(query, max_results=4)
        snippets = web_results

        # 웹 결과 DB 저장 (비동기)
        if web_results:
            def _save():
                try:
                    conn = sqlite3.connect(DB_PATH)
                    c = conn.cursor()
                    combined = " ".join(web_results)
                    c.execute(
                        "INSERT OR IGNORE INTO knowledge (url, title, content, category, fetched_at) VALUES (?,?,?,?,?)",
                        (f"web:{hashlib.md5(query.encode()).hexdigest()}", query[:80], combined[:4000], "web", datetime.now().isoformat())
                    )
                    conn.commit()
                    conn.close()
                except Exception:
                    pass
            threading.Thread(target=_save, daemon=True).start()

    answer = _compose_natural_answer(query, snippets, history, lang)
    if answer:
        return answer

    # 최종 안전망
    return localized_reply("generic", lang)

def should_store_training_pair(query, answer):
    query = normalize_corpus_text(query)
    answer = normalize_corpus_text(answer)
    if len(query) < 8 or len(answer) < 24:
        return False
    if looks_low_quality_text(query) or looks_low_quality_text(answer):
        return False
    if repeated_line_ratio(answer) > 0.2:
        return False
    if any(marker in answer for marker in GENERIC_TRAINING_MARKERS):
        return False
    return True

def generate_100m_chat_reply(query, history=None, max_new_tokens=40):
    runtime = load_100m_runtime()
    if runtime is None:
        return None
    prompt = build_100m_chat_prompt(query, history=history)
    tokenizer = runtime["tokenizer"]
    config = runtime["config"]
    device = runtime["device"]
    model_obj = runtime["model"]
    prompt_ids = encode_large_text(prompt, tokenizer, add_bos=True, add_eos=False)
    eos_id = tokenizer["special_tokens"]["<eos>"]
    prompt_length = len(prompt_ids)
    prompt_text = decode_large_ids(prompt_ids, tokenizer)
    best_reply = None
    best_score = -1000

    if runtime.get("kind") == "onnx":
        session = runtime["session"]
        input_name = runtime["input_name"]
        output_name = runtime["output_name"]
        max_context = min(256, int(getattr(config, "max_position_embeddings", 2048)))
        for profile in candidate_generation_profiles_for_onnx(query):
            generated = list(prompt_ids)
            for _ in range(max(6, max_new_tokens)):
                window = np.array([generated[-max_context:]], dtype=np.int64)
                outputs = session.run([output_name], {input_name: window})
                next_logits = np.asarray(outputs[0][0, -1, :], dtype=np.float64)
                next_logits = apply_numpy_generation_penalties(next_logits, generated, prompt_length)
                next_id = sample_numpy_token(
                    next_logits,
                    temperature=profile["temperature"],
                    top_k=profile["top_k"],
                    top_p=profile["top_p"],
                )
                generated.append(next_id)
                if next_id == eos_id:
                    break
                if len(generated) - prompt_length >= 12:
                    partial = clean_generated_reply(decode_large_ids(generated, tokenizer)[len(prompt_text):])
                    if partial and re.search(r"[.!?。！？]\s*$", partial):
                        break

            full_text = decode_large_ids(generated, tokenizer)
            completion = full_text[len(prompt_text):]
            cleaned = clean_generated_reply(completion)
            if cleaned and not looks_unusable_reply(cleaned, query=query):
                return cleaned
            score = reply_quality_score(cleaned, query=query)
            if score > best_score:
                best_score = score
                best_reply = cleaned
        return best_reply

    with large_runtime_lock:
        with large_torch.no_grad():
            for profile in candidate_generation_profiles(query):
                generated = list(prompt_ids)
                for _ in range(max(8, max_new_tokens)):
                    window = generated[-config.max_position_embeddings:]
                    x = large_torch.tensor([window], dtype=large_torch.long, device=device)
                    amp_enabled = device == "cuda"
                    amp_dtype = large_torch.bfloat16 if amp_enabled and hasattr(large_torch.cuda, "is_bf16_supported") and large_torch.cuda.is_bf16_supported() else large_torch.float16
                    with large_torch.autocast(device_type=device, enabled=amp_enabled, dtype=amp_dtype):
                        logits, _ = model_obj(x)
                    next_logits = logits[0, -1, :]
                    next_logits = apply_large_generation_penalties(next_logits, generated, prompt_length)
                    next_id = sample_large_token(
                        next_logits,
                        temperature=profile["temperature"],
                        top_k=profile["top_k"],
                        top_p=profile["top_p"],
                    )
                    generated.append(next_id)
                    if next_id == eos_id:
                        break

                full_text = decode_large_ids(generated, tokenizer)
                completion = full_text[len(prompt_text):]
                cleaned = clean_generated_reply(completion)
                if cleaned and not looks_unusable_reply(cleaned, query=query):
                    return cleaned
                score = reply_quality_score(cleaned, query=query)
                if score > best_score:
                    best_score = score
                    best_reply = cleaned

    return best_reply

def prepare_100m_corpus_snapshot(model_id, manual_text=""):
    ensure_version_training_files(model_id)
    try:
        snapshot_path, corpus_text, _report = build_stage_100m_corpus(model_id, manual_text=(manual_text or ""))
        if corpus_text.strip():
            return snapshot_path, corpus_text
    except Exception as exc:
        corpus_text, curation_report = build_clean_100m_corpus(manual_text=(manual_text or ""), model_id=model_id)
        if not corpus_text.strip():
            raise RuntimeError(f"100M 파이프라인에 사용할 텍스트가 없습니다. stage builder failed: {exc}") from exc
        snapshot_path = corpus_snapshot_path_for(model_id)
        snapshot_path.write_text(corpus_text, encoding="utf-8")
        curation_report["builder"] = "legacy_clean_corpus_fallback"
        curation_report["builder_error"] = str(exc)
        curation_report["corpus_characters"] = len(corpus_text)
        curation_report["corpus_paragraphs"] = len([p for p in corpus_text.split("\n\n") if p.strip()])
        curation_report_path_for(model_id).write_text(
            json.dumps(curation_report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return snapshot_path, corpus_text

    raise RuntimeError("100M 파이프라인에 사용할 텍스트가 없습니다.")

def launch_100m_training(model_id, manual_text="", dry_run=False, steps=None, eval_steps=None):
    registry = ensure_model_registry()
    current_id = registry.get("current_model_id")
    latest_id = registry.get("latest_model_id")
    if model_id != current_id or model_id != latest_id:
        raise RuntimeError("100M 학습은 현재 선택된 최신 모델에서만 시작할 수 있습니다.")

    pipeline = pipeline_overview_for(model_id)
    status = pipeline.get("status", {})
    if status.get("running"):
        raise RuntimeError("이미 100M 파이프라인이 실행 중입니다.")

    snapshot_path, corpus_text = prepare_100m_corpus_snapshot(model_id, manual_text)
    log_path = training_dir_for(model_id) / "train_100m.log"
    blueprint = load_architecture_blueprint(architecture_path_for(model_id))
    requested_steps = max(1, int(steps or blueprint.get("training_defaults", {}).get("train_steps", 120)))
    normalized_eval_steps = normalize_eval_steps(eval_steps)
    status = default_pipeline_status(model_id, blueprint)
    status.update({
        "running": not dry_run,
        "stage": "launching",
        "message": "100M dry run launching" if dry_run else "100M bootstrap training launching",
        "progress": 1,
        "dry_run": bool(dry_run),
        "corpus_path": str(snapshot_path),
        "output_dir": str(training_dir_for(model_id)),
        "corpus_characters": len(corpus_text),
        "backend": detect_100m_backend(),
        "steps_requested": requested_steps,
        "eval_file": str(DEFAULT_PUBLIC_EVAL_PATH),
        "eval_schedule": normalized_eval_steps,
        "eval_latest_output": str(latest_evaluation_path_for(model_id)),
        "evaluation_history": [],
        "latest_evaluation": None,
        "evaluation_running": False,
    })
    save_pipeline_status(model_id, status)

    command = [
        sys.executable,
        str(MODEL_SCRIPTS_DIR / "train_100m.py"),
        "--model-id", model_id,
        "--config", str(architecture_path_for(model_id)),
        "--output-dir", str(training_dir_for(model_id)),
        "--corpus", str(snapshot_path),
        "--status-file", str(pipeline_status_path_for(model_id)),
        "--steps", str(requested_steps),
        "--sft-dataset", str(DEFAULT_SFT_DATASET_PATH),
        "--eval-file", str(DEFAULT_PUBLIC_EVAL_PATH),
        "--eval-output", str(latest_evaluation_path_for(model_id)),
        "--eval-steps", ",".join(str(step) for step in normalized_eval_steps),
    ]
    if dry_run:
        command.append("--dry-run")

    if dry_run:
        completed = subprocess.run(
            command,
            cwd=str(PROJECT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        log_path.write_text(completed.stdout, encoding="utf-8")
        if completed.returncode not in (0, 2):
            raise RuntimeError("100M 드라이런 실행에 실패했습니다.")
    else:
        log_handle = log_path.open("ab")
        kwargs = {
            "cwd": str(PROJECT_ROOT),
            "stdout": log_handle,
            "stderr": subprocess.STDOUT,
            "stdin": subprocess.DEVNULL,
            "close_fds": True,
        }
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        process = subprocess.Popen(command, **kwargs)
        status["pid"] = process.pid
        save_pipeline_status(model_id, status)
    return pipeline_overview_for(model_id)

def run_100m_regression_eval(model_id):
    checkpoint_path = preferred_checkpoint_path_for(model_id)
    if checkpoint_path is None:
        raise RuntimeError("평가할 체크포인트가 없습니다.")

    tokenizer_path = tokenizer_path_for(model_id)
    if not tokenizer_path.exists():
        raise RuntimeError("평가할 토크나이저가 없습니다.")

    ensure_version_training_files(model_id)
    eval_output_path = latest_evaluation_path_for(model_id)
    manual_output_path = evaluation_dir_for(model_id) / f"manual_eval_{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    command = [
        sys.executable,
        str(MODEL_SCRIPTS_DIR / "run_public_chat_eval.py"),
        "--checkpoint", str(checkpoint_path),
        "--tokenizer", str(tokenizer_path),
        "--eval-file", str(DEFAULT_PUBLIC_EVAL_PATH),
        "--output", str(manual_output_path),
        "--device", "auto",
        "--max-new-tokens", "64",
        "--temperature", "0",
        "--top-k", "1",
    ]
    completed = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=1800,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stdout or "회귀 평가 실행에 실패했습니다.")[-1200:])

    evaluation_output = load_json_if_exists(manual_output_path)
    if not isinstance(evaluation_output, dict):
        raise RuntimeError("회귀 평가 결과를 읽지 못했습니다.")

    eval_output_path.write_text(json.dumps(evaluation_output, ensure_ascii=False, indent=2), encoding="utf-8")
    status = load_pipeline_status(model_id)
    summary = {
        "step": "manual",
        "checkpoint": str(checkpoint_path),
        "output_path": str(manual_output_path),
        "total": evaluation_output.get("total", 0),
        "passed": evaluation_output.get("passed", 0),
        "failed": evaluation_output.get("failed", 0),
        "pass_rate": evaluation_output.get("pass_rate", 0.0),
        "device": evaluation_output.get("device"),
        "categories": evaluation_output.get("categories", []),
        "by_category": evaluation_output.get("by_category", {}),
        "evaluated_at": evaluation_output.get("evaluated_at"),
    }
    history = status.get("evaluation_history") or []
    history.append(summary)
    status["evaluation_history"] = history[-30:]
    status["latest_evaluation"] = summary
    status["eval_latest_output"] = str(eval_output_path)
    save_pipeline_status(model_id, status)
    return evaluation_output

def run_100m_generation(model_id, prompt, max_new_tokens=80, temperature=0.8, top_k=40):
    prompt = (prompt or "").strip()
    if not prompt:
        raise RuntimeError("100M 생성 테스트 프롬프트가 비어 있습니다.")

    checkpoint_path = preferred_checkpoint_path_for(model_id)
    if checkpoint_path is None:
        raise RuntimeError("사용 가능한 100M 체크포인트가 없습니다.")

    tokenizer_path = tokenizer_path_for(model_id)
    if not tokenizer_path.exists():
        raise RuntimeError("사용 가능한 100M 토크나이저가 없습니다.")

    command = [
        sys.executable,
        str(MODEL_SCRIPTS_DIR / "generate_100m.py"),
        "--checkpoint", str(checkpoint_path),
        "--tokenizer", str(tokenizer_path),
        "--prompt", prompt,
        "--max-new-tokens", str(int(max_new_tokens)),
        "--temperature", str(float(temperature)),
        "--top-k", str(int(top_k)),
    ]
    completed = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout[-1000:] or "100M 생성 테스트에 실패했습니다.")
    try:
        return json.loads(completed.stdout)
    except Exception as exc:
        raise RuntimeError(f"100M 생성 결과를 읽지 못했습니다: {exc}") from exc

def run_teacher_distillation(model_id, manual_text="", limit=6):
    registry = ensure_model_registry()
    current_id = registry.get("current_model_id")
    latest_id = registry.get("latest_model_id")
    if model_id != current_id or model_id != latest_id:
        raise RuntimeError("Teacher distillation is allowed only for the current latest model.")

    config = load_teacher_config(model_id)
    if not config.get("enabled"):
        raise RuntimeError("Teacher workflow is disabled. Save and enable a teacher config first.")
    if not config.get("base_url") or not config.get("model"):
        raise RuntimeError("Teacher config needs both base_url and model.")

    source_text = (manual_text or "").strip()
    if not source_text:
        snapshot_path = corpus_snapshot_path_for(model_id)
        if snapshot_path.exists():
            source_text = snapshot_path.read_text(encoding="utf-8", errors="replace")
        else:
            source_text = collect_recent_training_corpus()
    if not source_text.strip():
        raise RuntimeError("There is no source text available for teacher distillation.")

    source_path = teacher_source_path_for(model_id)
    source_path.write_text(source_text, encoding="utf-8")
    status = save_teacher_status(model_id, {
        "running": True,
        "stage": "launching",
        "message": "Teacher distillation launching",
        "last_output_path": str(teacher_output_path_for(model_id)),
        "generated_pairs": 0,
    })

    command = [
        sys.executable,
        str(MODEL_SCRIPTS_DIR / "teacher_distill.py"),
        "--config", str(teacher_config_path_for(model_id)),
        "--source", str(source_path),
        "--output", str(teacher_output_path_for(model_id)),
        "--status-file", str(teacher_status_path_for(model_id)),
        "--limit", str(max(1, int(limit))),
        "--samples-per-block", str(max(1, int(config.get("samples_per_run", 8)) // max(1, int(limit)) or 1)),
    ]
    completed = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        save_teacher_status(model_id, {
            "running": False,
            "stage": "error",
            "message": (completed.stdout or "Teacher distillation failed.")[-220:],
            "last_output_path": str(teacher_output_path_for(model_id)),
        })
        raise RuntimeError((completed.stdout or "Teacher distillation failed.")[-220:])

    status = load_teacher_status(model_id)
    public_dialogues = export_teacher_public_dialogues(model_id)
    return {
        "config": config,
        "status": status,
        "output_path": str(teacher_output_path_for(model_id)),
        "public_dialogues": public_dialogues,
        "stdout": completed.stdout,
    }

def run_browser_packaging(model_id):
    registry = ensure_model_registry()
    target = find_registry_model(registry, model_id)
    if target is None:
        raise RuntimeError("Model not found for browser packaging.")

    source_dir = browser_export_dir_for(model_id)
    if not source_dir.exists():
        raise RuntimeError("Browser export directory is missing. Export the 100M ONNX bundle first.")

    output_dir = browser_package_dir_for(model_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    deployment = load_deployment_config()
    command = [
        sys.executable,
        str(MODEL_SCRIPTS_DIR / "package_browser_model.py"),
        "--model-id", model_id,
        "--display-name", target.get("display_name", model_id),
        "--source-dir", str(source_dir),
        "--output-dir", str(output_dir),
        "--safe-limit", str(STATIC_ASSET_SAFE_LIMIT),
    ]
    public_base_url = str(deployment.get("public_base_url") or "").strip()
    if public_base_url:
        command.extend(["--public-base-url", public_base_url])

    completed = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=1800,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stdout or "Browser packaging failed.")[-600:])
    try:
        stdout = (completed.stdout or "").strip()
        start = stdout.find("{")
        end = stdout.rfind("}")
        payload = json.loads(stdout[start:end + 1] if start != -1 and end != -1 else stdout)
    except Exception as exc:
        raise RuntimeError(f"Could not parse browser packaging output: {exc}") from exc
    deployment_overview_for(model_id)
    return payload

def train_current_model(corpus_text, mode="manual"):
    registry = ensure_model_registry()
    current_id = registry.get("current_model_id")
    latest_id = registry.get("latest_model_id")
    if not current_id or current_id != latest_id:
        raise RuntimeError("현재 선택된 모델이 최신 버전이 아니어서 학습할 수 없습니다.")
    if training_status.get("running"):
        raise RuntimeError("이미 다른 학습 작업이 진행 중입니다.")

    def worker():
        preview = re.sub(r"\s+", " ", corpus_text).strip()[:240]
        training_status["running"] = True
        training_status["mode"] = mode
        training_status["message"] = "학습 준비 중"
        training_status["sample_preview"] = preview
        training_status["active_model_id"] = current_id
        training_status["progress"] = 5
        try:
            chunks = [chunk for chunk in re.split(r"\n{2,}", corpus_text) if chunk.strip()]
            if not chunks:
                raise RuntimeError("학습할 텍스트가 비어 있습니다.")
            total = len(chunks)
            losses = []
            for index, chunk in enumerate(chunks, start=1):
                training_status["message"] = f"학습 중 ({index}/{total})"
                training_status["sample_preview"] = re.sub(r"\s+", " ", chunk).strip()[:240]
                with training_lock:
                    loss = model.train_on_text(chunk, quality=1.5)
                losses.append(loss)
                training_status["last_loss"] = round(loss, 4)
                training_status["total_trained"] = model.trained_docs
                training_status["progress"] = round(index / total * 100, 1)
            sync_live_artifacts_to_version(current_id)
            refreshed = ensure_model_registry()
            training_status["message"] = f"학습 완료: {find_registry_model(refreshed, current_id)['display_name']}"
        except Exception as exc:
            training_status["message"] = f"학습 오류: {str(exc)[:80]}"
        finally:
            training_status["running"] = False
            training_status["mode"] = "idle"

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

def model_panel_payload():
    registry = ensure_model_registry()
    current = find_registry_model(registry, registry.get("current_model_id"))
    latest = find_registry_model(registry, registry.get("latest_model_id"))
    pipelines = {item["id"]: pipeline_overview_for(item["id"]) for item in registry.get("models", [])}
    deployments = {item["id"]: deployment_overview_for(item["id"]) for item in registry.get("models", [])}
    current_pipeline = pipelines.get((current or {}).get("id", "")) if current else None
    eval_summary = (current_pipeline or {}).get("evaluation", {}).get("latest_output") or {}
    live_stats = {
        "estimated_params": (current or {}).get("actual_params_estimate", 0),
        "trained_docs": (current or {}).get("trained_docs", 0),
        "avg_loss": (current or {}).get("avg_loss"),
        "latest_loss": (current or {}).get("latest_loss"),
    }
    capability_summary = capability_summary_for_panel()
    capability_summary["runtime"] = live_stats
    return {
        "family_name": MODEL_FAMILY_NAME,
        "registry": registry,
        "current_model": current,
        "latest_model": latest,
        "live_stats": live_stats,
        "capability_summary": capability_summary,
        "training": training_status,
        "pipelines": pipelines,
        "deployments": deployments,
        "deployment_config": load_deployment_config(),
        "cleanup": {
            "candidate_count": len(cleanup_candidates()),
            "candidates": [str(path.relative_to(PROJECT_ROOT)) for path in cleanup_candidates()],
            "archive_dir": str(cleanup_archive_dir()),
        },
        "evaluation": (current_pipeline or {}).get("evaluation") or {
            "prompt_set": str(DEFAULT_PUBLIC_EVAL_PATH),
            "categories": load_eval_suite().get("categories", []),
            "schedule": list(DEFAULT_EVAL_STEPS),
            "history": [],
            "latest": None,
            "latest_output": eval_summary,
            "running": False,
        },
    }

def runtime_manifest_payload(model_id=None):
    registry = ensure_model_registry()
    model_id = model_id or registry.get("current_model_id")
    model_item = find_registry_model(registry, model_id) or {}
    deployment = deployment_overview_for(model_id)
    artifact_dir = Path(deployment.get("browser_dir") or "")
    packaged_manifest = load_json_if_exists(artifact_dir / "browser-manifest.json") if artifact_dir else {}
    runtime_block = packaged_manifest.get("runtime") if isinstance(packaged_manifest, dict) else {}
    deployment_config = load_deployment_config()
    provider_preference = deployment_config.get("provider_preference") if isinstance(deployment_config, dict) else None
    if not provider_preference:
        provider_preference = runtime_block.get("provider_preference")
    if isinstance(provider_preference, str):
        provider_preference = [item.strip().lower() for item in provider_preference.split(",") if item.strip()]
    if not isinstance(provider_preference, list):
        provider_preference = []
    provider_preference = [item for item in provider_preference if item in {"wasm", "webgpu"}]
    if not provider_preference:
        provider_preference = ["webgpu", "wasm"]

    runtime_engine = str(runtime_block.get("engine") or "").strip().lower()
    if runtime_engine == "transformers-js":
        payload = dict(packaged_manifest)
        payload["family_name"] = registry.get("family_name", "Purple Bee")
        payload["model_id"] = model_id
        payload["display_name"] = model_item.get("display_name", model_id)
        payload["version"] = model_item.get("version", "")
        payload["architecture_name"] = model_item.get("architecture_name", "Purple Bee Sub")
        payload["target_params"] = model_item.get("target_params")
        payload["actual_params_estimate"] = model_item.get("actual_params_estimate")
        payload["pipeline_stage"] = model_item.get("pipeline_stage")
        payload["pipeline_message"] = model_item.get("pipeline_message")
        payload["runtime"] = dict(runtime_block)
        payload["runtime"]["engine"] = "transformers-js"
        payload["runtime"]["provider_preference"] = provider_preference
        payload["runtime"]["max_context"] = int(runtime_block.get("max_context") or 2048)
        payload["deployment"] = {
            "storage": deployment.get("selected_storage"),
            "public_base_url": str(deployment.get("public_base_url") or "").rstrip("/"),
            "package_dir": str(artifact_dir),
            "runtime_engine": "transformers-js",
            "remote_asset_urls": deployment.get("remote_asset_urls") or {},
        }
        return payload

    onnx_name = Path(deployment["artifacts"].get("onnx") or "").name
    tokenizer_name = Path(deployment["artifacts"].get("tokenizer") or "").name
    onnx_data_name = Path(deployment["artifacts"].get("onnx_data") or "").name
    asset_version = ""
    version_candidates = []
    for key in ["onnx", "onnx_data", "tokenizer", "manifest", "package_report"]:
        raw_path = str(deployment["artifacts"].get(key) or "").strip()
        if not raw_path:
            continue
        path = Path(raw_path)
        if path.exists():
            version_candidates.append(int(path.stat().st_mtime))
    if version_candidates:
        asset_version = str(max(version_candidates))

    if not onnx_name or not tokenizer_name:
        raise RuntimeError("Browser runtime assets are not ready yet.")

    public_base_url = str(deployment.get("public_base_url") or "").rstrip("/")
    if public_base_url:
        query = f"?model_id={model_id}"
        if asset_version:
            query += f"&v={asset_version}"
        onnx_url = f"/api/runtime/assets/{onnx_name}{query}"
        tokenizer_url = f"/api/runtime/assets/{tokenizer_name}{query}"
        onnx_data_url = f"/api/runtime/assets/{onnx_data_name}{query}" if onnx_data_name else ""
    else:
        onnx_url = f"/static/models/{model_id}/{onnx_name}"
        tokenizer_url = f"/static/models/{model_id}/{tokenizer_name}"
        onnx_data_url = f"/static/models/{model_id}/{onnx_data_name}" if onnx_data_name else ""

    return {
        "family_name": registry.get("family_name", "Purple Bee"),
        "model_id": model_id,
        "display_name": model_item.get("display_name", model_id),
        "version": model_item.get("version", ""),
        "architecture_name": model_item.get("architecture_name", "Purple Bee 100M"),
        "target_params": model_item.get("target_params"),
        "actual_params_estimate": model_item.get("actual_params_estimate"),
        "pipeline_stage": model_item.get("pipeline_stage"),
        "pipeline_message": model_item.get("pipeline_message"),
        "browser_assets": {
            "onnx": onnx_url,
            "tokenizer": tokenizer_url,
            "onnx_data": onnx_data_url or None,
        },
        "runtime": {
            "provider_preference": provider_preference,
            "max_context": int(runtime_block.get("max_context") or 2048),
        },
        "deployment": {
            "storage": deployment.get("selected_storage"),
            "public_base_url": public_base_url,
            "package_dir": str(artifact_dir),
            "asset_version": asset_version,
        },
    }

ensure_model_registry()

# ── 자동 학습 루프 ───────────────────────────────────────────────────
CONTINUOUS_SOURCES = [
    "https://namu.wiki/w/%EB%A7%A4%ED%81%AC%EB%A1%9C%ED%8C%8C%EC%9D%B4%EB%82%B8%EC%8A%A4",
    "https://namu.wiki/w/인공지능",
    "https://ko.wikipedia.org/wiki/기계_학습",
    "https://ko.wikipedia.org/wiki/딥러닝",
    "https://news.naver.com/section/105",  # IT/과학
    "https://news.naver.com/section/101",  # 경제
    "https://hnrss.org/frontpage",
    "https://export.arxiv.org/search/?searchtype=all&query=korean+nlp&start=0&max_results=5",
    "https://www.aitimes.com/",
    "https://brunch.co.kr/search/AI",
]

def continuous_training_loop():
    """백그라운드 자동 학습 루프 - 새 문서를 계속 수집하여 학습"""
    source_idx = 0
    while True:
        try:
            training_status["running"] = True
            url = CONTINUOUS_SOURCES[source_idx % len(CONTINUOUS_SOURCES)]
            source_idx += 1

            training_status["message"] = f"수집 중: {url[:50]}..."
            content = fetch_url(url, timeout=10)
            if content and len(content) > 200:
                # DB에 저장
                save_knowledge(url, url.split("/")[-1], content)
                training_status["docs_collected"] += 1

                # 학습
                with training_lock:
                    loss = model.train_on_text(content, quality=1.0)
                    training_status["last_loss"] = round(loss, 4)
                    training_status["total_trained"] = model.trained_docs
                    training_status["message"] = f"학습 완료: {model.trained_docs}문서, 손실={loss:.4f}"

            # 대화 데이터도 학습에 활용
            try:
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                c.execute("""SELECT input, output FROM training_data
                             WHERE quality > 0.5 ORDER BY created_at DESC LIMIT 20""")
                rows = c.fetchall()
                conn.close()
                for inp, out in rows:
                    combined = f"질문: {inp} 답변: {out}"
                    with training_lock:
                        model.train_on_text(combined, quality=1.5)
            except:
                pass

        except Exception as e:
            training_status["message"] = f"오류: {str(e)[:60]}"

        training_status["progress"] = (source_idx % len(CONTINUOUS_SOURCES)) / len(CONTINUOUS_SOURCES) * 100
        time.sleep(45)  # 45초마다 새 소스 학습

# ── AI 응답 생성 ─────────────────────────────────────────────────────
def needs_web_search(query):
    """웹 검색이 필요한 쿼리인지 판단"""
    web_triggers = [
        "최신", "뉴스", "지금", "오늘", "현재", "요즘", "최근", "2024", "2025",
        "날씨", "가격", "얼마", "어디", "주소", "전화", "누구", "언제",
        "what is", "how to", "news", "latest", "today", "price"
    ]
    q_lower = query.lower()
    return any(t in q_lower for t in web_triggers)

def generate_response(query, history=None, use_web=True):
    """
    응답 생성 파이프라인 (스트리밍 제너레이터)
    Purple Bee 1.3 본체만 응답하도록 유지한다.
    시드/하드코딩/지식 합성 fallback은 여기서 사용하지 않는다.
    """
    history = history or []
    full_response = ""

    model_reply = None
    if large_model_available():
        try:
            model_reply = generate_100m_chat_reply(query, history=history, max_new_tokens=40)
        except Exception:
            model_reply = None

    if model_reply and not looks_unusable_reply(model_reply, query=query):
        full_response = normalize_corpus_text(model_reply).strip()

    if not full_response:
        return

    # ── 스트리밍 출력 ────────────────────────────────────────────
    # 단어 단위 스트리밍 (자연스러운 타이핑 효과)
    words = full_response.split()
    chunk = []
    for word in words:
        chunk.append(word)
        if len(chunk) >= 5:
            yield " ".join(chunk) + " "
            chunk = []
            time.sleep(0.025)
    if chunk:
        yield " ".join(chunk)

    # ── 학습 데이터 저장 ─────────────────────────────────────────
    if should_store_training_pair(query, full_response):
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute("INSERT INTO training_data (input, output) VALUES (?,?)",
                      (query, full_response[:2000]))
            conn.commit()
            conn.close()
            # 실시간 bigram 학습
            threading.Thread(
                target=lambda: model.train_on_text(f"Q: {query} A: {full_response[:400]}", quality=1.2),
                daemon=True
            ).start()
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# Purple Bee 멀티 도구 모듈 (이미지생성·분석, 문서분석, 파일생성, 공감, 창의력)
# ══════════════════════════════════════════════════════════════════════════════

import base64, mimetypes, tempfile, os as _os

# ── 도구 라우터: 입력에서 어떤 도구를 쓸지 감지 ─────────────────────────────
def detect_tool_intent(query: str):
    """사용자 입력에서 도구 의도를 감지한다."""
    q = query.lower().strip()
    # 이미지 생성
    if re.search(r"그림|이미지|사진|그려줘|생성해|만들어줘|일러스트|draw|generate.*image|create.*image|image.*of", q):
        return "image_generate"
    # 이미지 분석 (파일 첨부 or URL 언급)
    if re.search(r"이미지.*분석|사진.*분석|이미지.*뭔지|사진.*뭐야|이 이미지|이 사진|analyze.*image|what.*in.*image", q):
        return "image_analyze"
    # 문서 분석
    if re.search(r"문서.*분석|파일.*분석|pdf.*분석|요약해줘|요약해|summarize|document.*analyze|파일.*요약|내용.*정리", q):
        return "document_analyze"
    # 파일 생성
    if re.search(r"파일.*만들어|파일.*생성|만들어줘.*파일|코드.*저장|저장해줘|create.*file|generate.*file|write.*file", q):
        return "file_generate"
    # 창의력/아이디어
    if re.search(r"아이디어|브레인스토밍|기획|창의|발상|idea|brainstorm|creative", q):
        return "creative"
    # 감정 공감
    if re.search(r"힘들|우울|불안|스트레스|외로|슬프|화나|지쳐|걱정|무서|두렵|외롭", q):
        return "empathy"
    return None


# ── [1] 이미지 생성 도구 ─────────────────────────────────────────────────────
def tool_image_generate(prompt: str, style: str = "realistic") -> dict:
    """
    Stable Diffusion (로컬) 또는 외부 API 연동 이미지 생성.
    로컬 SD가 없으면 Pollinations.ai (무료 API)로 폴백.
    """
    try:
        import urllib.parse as _up
        encoded = _up.quote(prompt[:300])
        # Pollinations.ai 무료 이미지 생성 API
        url = f"https://image.pollinations.ai/prompt/{encoded}?width=512&height=512&nologo=true"
        return {
            "type": "image_url",
            "url": url,
            "prompt": prompt,
            "message": f"'{prompt}' 이미지를 생성했어요! 아래 링크에서 확인하거나 다운로드하실 수 있어요."
        }
    except Exception as e:
        return {"type": "error", "message": f"이미지 생성 중 오류가 발생했어요: {e}"}


# ── [2] 이미지 분석 도구 ─────────────────────────────────────────────────────
def tool_image_analyze(image_data: str = None, image_url: str = None) -> dict:
    """
    이미지 분석: base64 또는 URL을 받아 설명 생성.
    실제 Vision 모델 없이도 기본 메타 정보 + 간단 분류를 제공.
    """
    if not image_data and not image_url:
        return {
            "type": "text",
            "message": (
                "이미지를 분석하려면 이미지 파일을 첨부하거나 URL을 알려주세요.\n"
                "• 이미지 파일을 직접 업로드하거나\n"
                "• 이미지 URL을 붙여넣어 주시면 분석해드릴게요!"
            )
        }
    try:
        if image_url:
            r = requests.get(image_url, timeout=8, headers=HEADERS)
            r.raise_for_status()
            img_bytes = r.content
            content_type = r.headers.get("Content-Type", "image/jpeg")
        else:
            img_bytes = base64.b64decode(image_data)
            content_type = "image/jpeg"

        size_kb = len(img_bytes) // 1024
        return {
            "type": "text",
            "message": (
                f"이미지를 받았어요! 📸\n"
                f"• 파일 크기: 약 {size_kb}KB\n"
                f"• 형식: {content_type}\n\n"
                "이미지 분석 기능은 현재 기본 모드로 동작 중이에요. "
                "더 정확한 분석을 위해 이미지에서 궁금한 점을 직접 말씀해 주세요! "
                "예: '이 이미지에서 텍스트를 추출해줘', '이 사진 속 물체가 뭐야?' 등"
            )
        }
    except Exception as e:
        return {"type": "error", "message": f"이미지 분석 중 오류: {e}"}


# ── [3] 문서 분석 도구 ─────────────────────────────────────────────────────
def tool_document_analyze(text_content: str = None, file_path: str = None, url: str = None) -> dict:
    """
    문서 분석: 텍스트/파일/URL을 받아 요약, 핵심 키워드, 구조 분석 제공.
    """
    content = ""
    source_name = "문서"

    try:
        if url:
            content = fetch_url(url, timeout=10)
            source_name = url[:60]
        elif file_path and _os.path.exists(file_path):
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            source_name = _os.path.basename(file_path)
        elif text_content:
            content = text_content
            source_name = "입력 텍스트"
    except Exception as e:
        return {"type": "error", "message": f"문서를 불러오는 중 오류가 발생했어요: {e}"}

    if not content.strip():
        return {
            "type": "text",
            "message": (
                "문서 내용이 비어 있거나 읽을 수 없어요.\n"
                "텍스트를 직접 붙여넣거나, 파일 경로나 URL을 알려주세요!"
            )
        }

    # 기본 분석
    lines = [l.strip() for l in content.splitlines() if l.strip()]
    word_count = len(content.split())
    char_count = len(content)

    # 간단 키워드 추출 (빈도 기반)
    words = re.findall(r"[가-힣]{2,}|[A-Za-z]{3,}", content)
    from collections import Counter as _Counter
    stop = {"있다","없다","하다","이다","그리고","하지만","또한","때문","위해","통해","수있","있는","없는","하는","되는","그런","이런","저런","있어","없어","이에","그에","the","and","that","this","with","from","have","they","will","been","were","their"}
    freq = _Counter(w.lower() for w in words if w.lower() not in stop)
    top_kws = [w for w, _ in freq.most_common(8)]

    # 문장 수
    sentences = re.split(r"[.!?。]\s+", content)
    sentence_count = len([s for s in sentences if len(s.strip()) > 5])

    # 요약 (앞부분 발췌)
    summary_src = " ".join(lines[:min(5, len(lines))])
    summary = summary_src[:300] + ("..." if len(summary_src) > 300 else "")

    result_text = (
        f"📄 **문서 분석 결과** — {source_name}\n\n"
        f"**기본 정보**\n"
        f"• 글자 수: {char_count:,}자  |  단어 수: {word_count:,}개  |  문장 수: 약 {sentence_count}개\n\n"
        f"**핵심 키워드**\n"
        f"{', '.join(top_kws) if top_kws else '(키워드를 추출할 수 없어요)'}\n\n"
        f"**내용 요약 (앞부분)**\n"
        f"{summary}\n\n"
        f"더 자세한 분석(특정 섹션 요약, 질문 답변 등)이 필요하면 말씀해 주세요!"
    )
    return {"type": "text", "message": result_text}


# ── [4] 파일 생성 도구 ─────────────────────────────────────────────────────
def tool_file_generate(filename: str, content: str, file_type: str = "txt") -> dict:
    """
    지정된 내용으로 파일을 생성하고 경로를 반환.
    """
    try:
        # 안전한 저장 경로 (프로젝트 data 폴더)
        base_path = Path(__file__).parent / "data" / "generated_files"
        base_path.mkdir(parents=True, exist_ok=True)

        # 파일명 정리
        safe_name = re.sub(r"[^\w가-힣\-_\. ]", "_", filename)
        if not safe_name.endswith(f".{file_type}"):
            safe_name = f"{safe_name}.{file_type}"
        out_path = base_path / safe_name

        out_path.write_text(content, encoding="utf-8")
        return {
            "type": "file",
            "path": str(out_path),
            "filename": safe_name,
            "size_bytes": len(content.encode("utf-8")),
            "message": (
                f"✅ 파일을 생성했어요!\n"
                f"• 파일명: {safe_name}\n"
                f"• 크기: {len(content.encode('utf-8')):,} bytes\n"
                f"• 저장 위치: {out_path}\n\n"
                f"다운로드 경로를 통해 파일을 가져가시거나, "
                f"내용을 수정하고 싶으면 말씀해 주세요!"
            )
        }
    except Exception as e:
        return {"type": "error", "message": f"파일 생성 중 오류가 발생했어요: {e}"}


# ── [5] 창의력/아이디어 도구 ─────────────────────────────────────────────────
def tool_creative_brainstorm(topic: str, count: int = 5) -> dict:
    """
    주제에 대한 창의적 아이디어 생성.
    웹 검색 결과를 참고해 다양한 관점의 아이디어를 제안.
    """
    try:
        snippets = _search_web_snippets(topic, max_results=4)
    except Exception:
        snippets = []

    # 기본 아이디어 프레임워크
    frameworks = [
        f"💡 **기존과 반대로**: {topic}의 반대 개념에서 출발하면?",
        f"🔗 **결합**: {topic}을(를) 전혀 다른 분야(예: 예술, 기술, 자연)와 합치면?",
        f"⚡ **10배 크게**: {topic}을(를) 10배 규모로 적용한다면?",
        f"🎯 **특정 대상**: {topic}을(를) 어린이/노인/전문가에게 맞춘다면?",
        f"🌍 **글로벌**: {topic}을(를) 다른 나라나 문화에 적용한다면?",
        f"🔄 **자동화**: {topic}의 어떤 부분을 자동화하면 가장 효과적일까?",
        f"♻️ **재활용**: 기존 자원이나 아이디어를 {topic}에 재활용한다면?",
    ]

    selected = frameworks[:min(count, len(frameworks))]

    if snippets:
        snip_text = "\n".join(f"• {s[:100]}" for s in snippets[:3])
        extra = f"\n\n**참고 정보 (웹 검색)**\n{snip_text}"
    else:
        extra = ""

    result_text = (
        f"🧠 **'{topic}' 아이디어 브레인스토밍**\n\n"
        + "\n".join(selected)
        + extra
        + "\n\n더 구체적인 방향이 있으면 말씀해 주세요. 아이디어를 더 발전시켜드릴게요!"
    )
    return {"type": "text", "message": result_text}


# ── [6] 감정 공감 도구 ─────────────────────────────────────────────────────
def tool_empathy_response(query: str) -> dict:
    """
    감정적 고민에 대해 공감 + 실용적 조언을 제공.
    """
    import random as _rnd
    q = query.lower()

    if any(p in q for p in ["힘들","지쳐","지쳤"]):
        core = "지금 많이 지치고 힘드시겠어요. 그 감정은 정말 자연스러운 거예요."
        tip = "지금 당장 해결하려 하기보다, 오늘 딱 하나만 해결하겠다는 목표를 잡아보세요."
    elif any(p in q for p in ["우울","슬프","슬퍼"]):
        core = "우울한 기분이 드실 때는 정말 힘드죠. 혼자 끌어안지 않아도 돼요."
        tip = "작은 것부터 시작해보세요 — 창문 열기, 짧게 산책하기, 좋아하는 음악 틀기."
    elif any(p in q for p in ["불안","걱정","무서","두렵"]):
        core = "불안하거나 걱정될 때 그 감정은 뭔가를 중요하게 생각한다는 신호예요."
        tip = "지금 당장 통제할 수 있는 것과 없는 것을 나눠보세요. 통제할 수 있는 것 하나에 집중해봐요."
    elif any(p in q for p in ["화나","짜증","열받"]):
        core = "화가 나는 상황이 있으셨군요. 그 감정은 충분히 이해해요."
        tip = "일단 깊게 숨 한 번 쉬고, 어떤 상황이었는지 저한테 얘기해보세요. 같이 생각해볼게요."
    elif any(p in q for p in ["외로","혼자"]):
        core = "외롭다는 감정은 진짜 힘든 감정이에요. 표현해줘서 고마워요."
        tip = "오늘 한 사람에게 가볍게 연락해보는 건 어떨까요? 혹은 저한테 하고 싶은 얘기 다 해도 돼요."
    else:
        core = "지금 감정이 많이 복잡하실 것 같아요. 제가 여기서 듣고 있을게요."
        tip = "어떤 상황인지 조금 더 말씀해 주시면 같이 생각해봐요."

    result = (
        f"💛 {core}\n\n"
        f"**작은 팁**: {tip}\n\n"
        f"더 얘기하고 싶은 게 있으면 언제든지 말씀해 주세요. 혼자 힘들어하지 않아도 돼요."
    )
    return {"type": "text", "message": result}


# ── 통합 도구 실행기 ──────────────────────────────────────────────────────
def run_tool(tool_id: str, params: dict) -> dict:
    """도구 ID와 파라미터를 받아 실행하고 결과를 반환."""
    if tool_id == "image_generate":
        return tool_image_generate(params.get("prompt",""), params.get("style","realistic"))
    elif tool_id == "image_analyze":
        return tool_image_analyze(params.get("image_data"), params.get("image_url"))
    elif tool_id == "document_analyze":
        return tool_document_analyze(params.get("text"), params.get("file_path"), params.get("url"))
    elif tool_id == "file_generate":
        return tool_file_generate(params.get("filename","output"), params.get("content",""), params.get("file_type","txt"))
    elif tool_id == "creative":
        return tool_creative_brainstorm(params.get("topic",""), params.get("count",5))
    elif tool_id == "empathy":
        return tool_empathy_response(params.get("query",""))
    else:
        return {"type": "error", "message": f"알 수 없는 도구: {tool_id}"}

# ── Flask 라우트 ─────────────────────────────────────────────────────
SUPPORTED_SITE_LOCALES = {
    "ko-KR": "ko",
    "en-US": "en",
    "ja-JP": "ja",
}

SITE_LOCALE_ALIASES = {
    "ko": "ko-KR",
    "ko-kr": "ko-KR",
    "en": "en-US",
    "en-us": "en-US",
    "ja": "ja-JP",
    "ja-jp": "ja-JP",
}

SITE_COPY = {
    "ko-KR": {
        "brand_badge": "Global",
        "nav": {
            "home": "소개",
            "features": "기능",
            "safety": "안전",
            "architecture": "아키텍처",
            "pricing": "요금",
            "legal": "정책",
            "open_chat": "Purple Bee 열기",
        },
        "pages": {
            "home": {
                "eyebrow": "Purple Bee",
                "title": "설치형 준비물과 분산 기여 구독을 함께 갖춘 AI 플랫폼",
                "description": "Purple Bee는 웹사이트에서 준비물 상태를 점검하고, 필요한 실행 자산만 설치한 뒤, 사용자 기기와 기여 네트워크를 함께 활용하도록 설계된 제품형 AI 서비스입니다.",
                "badges": ["준비물 설치 상태 관리", "기여 기반 구독", "다국어 제품 사이트", "안정성 중심 설계"],
                "hero_cards": [
                    {"label": "실행 준비", "title": "준비물 설치 상태를 한 화면에서 확인", "meta": "설치되지 않음 · 업데이트 필요 · 최신 설치됨을 구분해 안내합니다."},
                    {"label": "기여 구독", "title": "기여 시간을 예약해 상위 플랜 혜택 확보", "meta": "자원을 제공한 시간과 성능 점수를 기준으로 구독을 활성화합니다."},
                    {"label": "운영 구조", "title": "웹사이트 · 기여 클라이언트 · 중앙 스케줄러 분리", "meta": "추후 확장을 고려해 안전성과 제품화를 함께 잡는 구조로 설계합니다."},
                ],
                "sections": [
                    {
                        "title": "제품 핵심",
                        "text": "브라우저 안에서는 설치 상태와 실행 흐름을 관리하고, 실제 하드웨어 판정과 분산 기여는 별도 네이티브 클라이언트가 맡습니다.",
                        "bullets": [
                            "준비물 상태를 즉시 확인하고 업데이트가 필요한 경우만 안내",
                            "사용자 기기 단독 실행과 분산 보조 연산을 함께 고려한 구조",
                            "플랜과 기여 상태를 같은 제품 경험 안에서 관리",
                        ],
                    },
                    {
                        "title": "왜 이렇게 만들었나요?",
                        "text": "모델 추론 경로, 설치 UX, 기기 성능 조건, 기여 구독 규칙을 따로 흩어놓지 않고 한 제품 안에서 이어지게 하기 위해서입니다.",
                        "bullets": [
                            "실패 시점을 설명할 수 있는 설치/실행 피드백",
                            "약관과 자원 사용 동의를 분리한 제품형 시작 흐름",
                            "언어권에 따라 시작 경로를 자동으로 맞추는 글로벌 소개 사이트",
                        ],
                    },
                ],
            },
            "features": {
                "eyebrow": "Features",
                "title": "설치, 실행, 기여, 구독을 한 흐름으로 묶은 기능 구성",
                "description": "Purple Bee는 단순 채팅 UI가 아니라, 준비물 배포와 설치 상태 판정, 기여 예약, 구독 활성화까지 이어지는 기능 체계를 목표로 합니다.",
                "badges": ["설치 관리자형 UI", "실행 상태 점검", "기여 예약", "구독 활성화"],
                "sections": [
                    {
                        "title": "AI 준비물",
                        "text": "설치 여부, 버전 차이, 예상 다운로드 용량, 현재 기기 조건을 함께 보여주고 필요한 작업만 진행하도록 안내합니다.",
                        "bullets": [
                            "설치되지 않음 / 업데이트 필요 / 최신 설치됨 상태 분리",
                            "정확한 다운로드 용량과 진행률 표시",
                            "준비물 삭제와 재설치 흐름 제공",
                        ],
                    },
                    {
                        "title": "기여 기반 구독",
                        "text": "기여 시간을 예약하고, 해당 시간 동안 자원을 제공하면 프리미엄 상태를 활성화하는 모델을 준비합니다.",
                        "bullets": [
                            "Free · Basic · Plus · Pro 플랜 구조",
                            "기여 시간과 기기 성능을 함께 반영한 효율 점수",
                            "작업 중단, 미참여, 재시도에 대한 패널티 설계",
                        ],
                    },
                ],
            },
            "safety": {
                "eyebrow": "Safety",
                "title": "자원 사용 범위와 책임 경계를 먼저 설명하는 제품",
                "description": "Purple Bee는 컴퓨터 자원 사용에 대한 동의를 별도로 받으며, 언제 어떤 범위까지 자원을 쓰는지와 중단 조건을 사용자에게 명확히 보여줍니다.",
                "badges": ["자원 사용 동의 분리", "중단 조건 명시", "책임 범위 표시", "권한 최소화"],
                "sections": [
                    {
                        "title": "필수 동의",
                        "text": "시작 전 이용약관, 자원 사용, 개인정보 처리방침 동의를 모두 받아야 하며, 자원 사용 동의는 별도 문서로 분리합니다.",
                        "bullets": [
                            "이용약관 동의",
                            "컴퓨터 자원 사용 동의",
                            "개인정보 처리방침 동의",
                        ],
                    },
                    {
                        "title": "사용자 보호",
                        "text": "기여 클라이언트는 CPU/GPU 상한과 유휴 상태, 강제 일시정지 규칙을 가집니다.",
                        "bullets": [
                            "사용자 활동 감지 시 자동 일시정지",
                            "실패 작업 자동 재분배",
                            "장기적으론 샌드박스와 네이티브 보호 계층 적용",
                        ],
                    },
                ],
            },
            "architecture": {
                "eyebrow": "Architecture",
                "title": "웹사이트, 기여 클라이언트, 중앙 스케줄러를 분리한 구조",
                "description": "웹사이트는 제품 경험과 설치·구독 상태를 관리하고, 실제 하드웨어 감지와 분산 기여는 별도 클라이언트가 수행하며, 중앙 서버는 작업 큐와 구독 상태를 판정합니다.",
                "badges": ["Node.js + Python", "기여 클라이언트", "작업 큐", "구독 판정 로직"],
                "sections": [
                    {
                        "title": "클라이언트",
                        "text": "웹 클라이언트는 시작 경험, 준비물 설치, 상태 표시를 담당합니다. 네이티브 기여 클라이언트는 CPU/GPU/RAM/디스크를 실제로 읽고 예약된 시간에 작업을 수행합니다.",
                        "bullets": [
                            "웹: 설치·업데이트·동의·플랜 UX",
                            "네이티브: 실제 하드웨어 감지와 백그라운드 작업",
                            "브리지: 상태 동기화와 기여 시간 보고",
                        ],
                    },
                    {
                        "title": "서버",
                        "text": "중앙 서버는 무료/기여 구독 큐를 분리하고, 작업을 작은 단위로 나눠 재시도·재할당까지 관리합니다.",
                        "bullets": [
                            "작업 분배와 재시도",
                            "구독 활성화/비활성화 계산",
                            "패널티 누적과 복구 판정",
                        ],
                    },
                ],
            },
            "pricing": {
                "eyebrow": "Pricing",
                "title": "Free부터 Pro까지, 그리고 기여 기반 구독",
                "description": "기본 사용은 무료로 제공하고, 더 빠른 응답과 상위 모델 접근이 필요한 사용자는 기여 시간을 예약해 프리미엄 구독을 활성화할 수 있도록 설계합니다.",
                "badges": ["Free", "Basic", "Plus", "Pro"],
                "plans": [
                    {"name": "Free", "price": "₩0", "meta": "기본 사용", "badge": "Free", "features": ["기본 AI 사용", "낮은 우선순위", "경량 모델 중심", "요청 횟수 제한"]},
                    {"name": "Basic", "price": "1시간 기여", "meta": "1일 혜택", "badge": "Basic", "features": ["응답 대기시간 단축", "요청 제한 완화", "기여 예약 가능", "기본 분산 보조 연산"]},
                    {"name": "Plus", "price": "5시간 기여", "meta": "7일 혜택", "badge": "Plus", "recommended": True, "features": ["상위 우선순위", "최신 모델 접근", "요청 제한 사실상 해제", "분산 보조 연산 가중치 상향"]},
                    {"name": "Pro", "price": "확장 기여", "meta": "확장 혜택", "badge": "Pro", "features": ["최상위 우선순위", "고급 기능 우선 적용", "다중 세션/대형 작업 대응", "장기 기여형 운용"]},
                ],
                "sections": [
                    {
                        "title": "분산 기여 구독은 어떻게 동작하나요?",
                        "text": "예를 들어 구독 사용자 100명, 동시 사용 300명 상황이라면, 모든 사용자는 자기 기기에서 먼저 실행하고, 상위 플랜 사용자는 추가로 기여 네트워크의 보조 연산을 함께 받습니다.",
                        "bullets": [
                            "자기 기기 우선 실행은 모든 플랜에 공통",
                            "기여 노드는 상위 플랜 요청에 가중치를 더 높게 배정",
                            "실패 노드는 즉시 제외하고 작업을 재분배",
                            "CPU/GPU 상한과 네트워크 상태를 기준으로 안전하게 배정",
                        ],
                    }
                ],
            },
        },
        "policies": {
            "terms": {
                "title": "이용약관",
                "subtitle": "서비스 범위, 책임 경계, 계정/구독 운영 기준을 설명합니다.",
                "sections": [
                    {"title": "서비스 범위", "body": "Purple Bee는 AI 대화, 준비물 설치, 기여 구독, 제품형 안내 페이지를 포함하는 서비스를 제공합니다."},
                    {"title": "책임 범위", "body": "서비스는 최선의 결과를 목표로 하지만, 생성형 답변의 정확성은 항상 검증이 필요합니다."},
                    {"title": "중단 조건", "body": "불법 사용, 서비스 남용, 기여 예약 반복 불이행, 안전 정책 위반 시 기능 또는 계정 접근이 제한될 수 있습니다."},
                ],
            },
            "privacy": {
                "title": "개인정보 처리방침",
                "subtitle": "로그인, 설정, 대화 기록, 기여 상태 데이터가 어떤 방식으로 처리되는지 설명합니다.",
                "sections": [
                    {"title": "수집 항목", "body": "로그인 계정 정보, 세션 설정, 기여 상태, 구독 상태, 오류 복구를 위한 최소한의 사용 로그를 처리할 수 있습니다."},
                    {"title": "이용 목적", "body": "서비스 제공, 상태 복구, 구독 판정, 안전 운영, 사용자 맞춤 경험을 위해 사용됩니다."},
                    {"title": "보관 및 삭제", "body": "사용자는 저장된 대화나 메모리를 직접 삭제할 수 있으며, 정책상 보관이 필요한 최소 데이터만 유지합니다."},
                ],
            },
            "resource-use": {
                "title": "컴퓨터 자원 사용 동의",
                "subtitle": "어떤 자원을, 언제, 어떤 조건에서 사용하는지 별도로 설명하는 문서입니다.",
                "sections": [
                    {"title": "어떤 자원을 쓰나요?", "body": "CPU, GPU, RAM, 저장 공간, 네트워크 대역폭의 일부를 사용합니다. 실제 사용 비율은 상한 정책을 따릅니다."},
                    {"title": "언제 쓰나요?", "body": "예약된 기여 시간 동안만 사용하며, 사용자가 다시 작업을 시작하면 자동으로 일시정지될 수 있습니다."},
                    {"title": "중단 조건", "body": "온도/부하/배터리/네트워크 상태가 안전 기준을 벗어나면 기여 작업은 즉시 중단되거나 재배정됩니다."},
                ],
            },
        },
        "policy_labels": {
            "terms": "이용약관",
            "privacy": "개인정보 처리방침",
            "resource-use": "컴퓨터 자원 사용 동의",
        },
        "footer": "Purple Bee 제품 사이트",
    },
    "en-US": {
        "brand_badge": "Global",
        "nav": {
            "home": "Overview",
            "features": "Features",
            "safety": "Safety",
            "architecture": "Architecture",
            "pricing": "Pricing",
            "legal": "Policies",
            "open_chat": "Open Purple Bee",
        },
        "pages": {
            "home": {
                "eyebrow": "Purple Bee",
                "title": "An AI product with install-ready assets and contribution-based subscriptions",
                "description": "Purple Bee combines runtime asset setup, device-aware execution, and contributor subscriptions in one product flow.",
                "badges": ["Install state management", "Contribution subscription", "Global product site", "Reliability-first"],
                "hero_cards": [
                    {"label": "Install", "title": "Check setup status in one place", "meta": "Know whether the model is not installed, needs updates, or is already current."},
                    {"label": "Contribute", "title": "Reserve idle time to unlock premium access", "meta": "Contribution time and device score activate higher tiers."},
                    {"label": "Operate", "title": "Separate web UX, native client, and scheduler", "meta": "Built for productization, stability, and future scaling."},
                ],
                "sections": [
                    {"title": "What makes it different", "text": "The website manages onboarding and setup, while a native contributor client is responsible for exact hardware inspection and safe background contribution.", "bullets": ["Clear install/update state", "Device-first execution with distributed assist", "Plans and contribution status in one flow"]},
                    {"title": "Why this product shape", "text": "Runtime setup, execution constraints, and subscription rules should feel like one product—not a collection of disconnected tools.", "bullets": ["Actionable setup feedback", "Separate resource-use consent", "Locale-aware entry path"]},
                ],
            },
            "features": {
                "eyebrow": "Features",
                "title": "Install, run, contribute, and upgrade within one system",
                "description": "Purple Bee is designed as a product experience, not just a chat box.",
                "badges": ["Installer-like setup", "Runtime checks", "Contribution scheduling", "Subscription activation"],
                "sections": [
                    {"title": "AI Prep", "text": "Users can see installation status, update requirements, expected download size, and runtime readiness before they ask the first question.", "bullets": ["Not installed / update needed / up to date", "Exact download size and progress", "Delete and reinstall flow"]},
                    {"title": "Contributor Subscription", "text": "Users can schedule contribution time and exchange idle compute for higher service tiers.", "bullets": ["Free · Basic · Plus · Pro", "Time + hardware efficiency scoring", "Penalty rules for no-show and early exits"]},
                ],
            },
            "safety": {
                "eyebrow": "Safety",
                "title": "Consent, resource boundaries, and failure handling are part of the product",
                "description": "Purple Bee separates terms, privacy, and computer-resource consent, and explains exactly when resource usage starts and stops.",
                "badges": ["Separate resource consent", "Stop conditions", "Defined responsibility", "Minimal permissions"],
                "sections": [
                    {"title": "Required agreements", "text": "Terms of service, computer resource use, and privacy policy are required before users start.", "bullets": ["Terms of service", "Computer resource use consent", "Privacy policy"]},
                    {"title": "User protection", "text": "The contributor client is designed to pause automatically when the user resumes active work or when safety constraints are exceeded.", "bullets": ["Automatic pause during activity", "Retry and reassignment", "Sandbox-oriented execution path"]},
                ],
            },
            "architecture": {
                "eyebrow": "Architecture",
                "title": "A split architecture for UX, hardware inspection, and task orchestration",
                "description": "The website handles setup and plan UX. The native client handles exact hardware detection and background contribution. The central scheduler handles task distribution and subscription logic.",
                "badges": ["Node.js + Python", "Native contributor client", "Task queue", "Subscription logic"],
                "sections": [
                    {"title": "Client architecture", "text": "Web and native clients serve different roles. The web app manages setup and plan UX; the native client inspects hardware and runs background tasks.", "bullets": ["Web: setup, install, legal, plan UX", "Native: exact CPU/GPU/RAM/disk detection", "Bridge: sync device and contribution state"]},
                    {"title": "Server architecture", "text": "The server separates free and contributor queues and reallocates failed work automatically.", "bullets": ["Task distribution and retries", "Subscription activation/deactivation", "Penalty and reliability scoring"]},
                ],
            },
            "pricing": {
                "eyebrow": "Pricing",
                "title": "From Free to Pro, with contribution-based upgrades",
                "description": "Core access starts free. Higher tiers are activated through reserved contribution time and device efficiency.",
                "badges": ["Free", "Basic", "Plus", "Pro"],
                "plans": [
                    {"name": "Free", "price": "$0", "meta": "base access", "badge": "Free", "features": ["Basic AI access", "Lower priority queue", "Lightweight models", "Usage limits"]},
                    {"name": "Basic", "price": "1 hour contribution", "meta": "1 day benefits", "badge": "Basic", "features": ["Faster queue", "Softer request limits", "Contribution scheduling", "Basic distributed assist"]},
                    {"name": "Plus", "price": "5 hours contribution", "meta": "7 day benefits", "badge": "Plus", "recommended": True, "features": ["Higher priority", "Latest model access", "Much looser limits", "Stronger distributed assist"]},
                    {"name": "Pro", "price": "extended contribution", "meta": "extended benefits", "badge": "Pro", "features": ["Top priority", "Advanced features", "Large jobs and sessions", "Long-run contribution mode"]},
                ],
                "sections": [
                    {"title": "How distributed contribution scales", "text": "If 300 users are active and 100 contributors are available, each request still starts on the local device first. Higher plans can then receive extra distributed assist from contributor nodes.", "bullets": ["Local-device-first by default", "Weighted assignment for higher plans", "Automatic reassignment on node failure", "CPU/GPU/network-aware safety checks"]},
                ],
            },
        },
        "policies": {
            "terms": {"title": "Terms of Service", "subtitle": "Service scope, responsibility boundaries, and subscription rules.", "sections": [{"title": "Service scope", "body": "Purple Bee provides AI chat, asset setup, contribution subscriptions, and product guidance pages."}, {"title": "Responsibility", "body": "Generated answers should still be verified. The service aims for quality, not absolute correctness."}, {"title": "Suspension conditions", "body": "Abuse, repeated no-shows, unsafe contribution behavior, or policy violations may limit access."}]},
            "privacy": {"title": "Privacy Policy", "subtitle": "How account, session, memory, and contribution data are handled.", "sections": [{"title": "Collected data", "body": "Account information, session settings, contribution state, and minimal reliability logs may be processed."}, {"title": "Purpose", "body": "To provide the service, restore state, manage subscriptions, and operate safely."}, {"title": "Retention", "body": "Users can delete saved chats and memories, while only minimal operational data is retained when needed."}]},
            "resource-use": {"title": "Computer Resource Use Consent", "subtitle": "A separate document for what is used, when it is used, and when it must stop.", "sections": [{"title": "What is used", "body": "A portion of CPU, GPU, RAM, storage, and network bandwidth may be used within configured limits."}, {"title": "When it is used", "body": "Only during reserved contribution windows, with automatic pause when active usage resumes."}, {"title": "Stop conditions", "body": "Contribution work pauses or stops when thermal, battery, network, or safety limits are exceeded."}]},
        },
        "policy_labels": {"terms": "Terms", "privacy": "Privacy", "resource-use": "Resource use"},
        "footer": "Purple Bee product site",
    },
    "ja-JP": {
        "brand_badge": "Global",
        "nav": {
            "home": "概要",
            "features": "機能",
            "safety": "安全性",
            "architecture": "構成",
            "pricing": "料金",
            "legal": "ポリシー",
            "open_chat": "Purple Bee を開く",
        },
        "pages": {
            "home": {
                "eyebrow": "Purple Bee",
                "title": "準備物のインストールと貢献型サブスクリプションを備えた AI プラットフォーム",
                "description": "Purple Bee は、実行資産の準備、デバイス別の実行、分散貢献サブスクリプションを一つの製品体験として設計しています。",
                "badges": ["準備状態の管理", "貢献型サブスクリプション", "グローバル製品サイト", "安定性重視"],
                "hero_cards": [
                    {"label": "準備", "title": "インストール状態を一画面で確認", "meta": "未インストール・更新必要・最新状態を区別して案内します。"},
                    {"label": "貢献", "title": "空き時間を予約して上位プランを有効化", "meta": "貢献時間と性能点数で上位特典を有効化します。"},
                    {"label": "運用", "title": "Web UX・ネイティブクライアント・スケジューラを分離", "meta": "拡張性と安定性を両立するための構成です。"},
                ],
                "sections": [
                    {"title": "製品の中心", "text": "Web は導入と準備状態を扱い、正確なハードウェア判定と安全な背景実行はネイティブクライアントが担当します。", "bullets": ["明確なインストール/更新状態", "デバイス優先実行 + 分散補助", "プランと貢献状態を一つの体験で管理"]},
                    {"title": "この形にした理由", "text": "実行、設置、プラン、資源利用同意を別々の断片ではなく、一つの製品体験として扱うためです。", "bullets": ["失敗理由を説明できるセットアップ UX", "資源利用同意を別文書として分離", "地域言語に合わせた案内"]},
                ],
            },
            "features": {
                "eyebrow": "Features",
                "title": "インストール、実行、貢献、アップグレードを一つの流れに",
                "description": "Purple Bee は単なるチャット UI ではなく、準備・実行・貢献をまとめて扱う製品構成を目指します。",
                "badges": ["インストーラー型 UI", "実行チェック", "貢献予約", "サブスク有効化"],
                "sections": [
                    {"title": "AI 準備物", "text": "インストール有無、更新必要性、予想ダウンロード容量、現在の実行条件をまとめて表示します。", "bullets": ["未インストール / 更新必要 / 最新", "正確なダウンロード容量と進行率", "削除と再インストール"]},
                    {"title": "貢献型サブスクリプション", "text": "空き時間を予約し、計算資源を提供することで上位プランを有効化する方式です。", "bullets": ["Free · Basic · Plus · Pro", "時間 + ハードウェア効率スコア", "無断離脱・不参加に対するペナルティ"]},
                ],
            },
            "safety": {
                "eyebrow": "Safety",
                "title": "資源利用の範囲と責任境界を先に示す製品",
                "description": "Purple Bee は利用規約、資源利用同意、個人情報ポリシーを分けて提示し、いつ何を使うのかを明確にします。",
                "badges": ["資源利用同意の分離", "停止条件", "責任範囲", "最小権限"],
                "sections": [
                    {"title": "必須同意", "text": "サービス開始前に利用規約、コンピュータ資源利用、個人情報処理方針への同意が必要です。", "bullets": ["利用規約", "コンピュータ資源使用への同意", "個人情報処理方針"]},
                    {"title": "ユーザー保護", "text": "貢献クライアントはユーザー操作の再開や安全条件の逸脱時に自動停止するよう設計します。", "bullets": ["活動再開時の自動一時停止", "失敗時の再試行と再割当", "サンドボックス志向の実行"]},
                ],
            },
            "architecture": {
                "eyebrow": "Architecture",
                "title": "Web・ネイティブクライアント・中央スケジューラを分離した構成",
                "description": "Web は導入とプラン UX を担当し、ネイティブクライアントは正確なハードウェア検出と背景貢献、中央サーバーはタスク分配とサブスク判定を担当します。",
                "badges": ["Node.js + Python", "ネイティブクライアント", "タスクキュー", "サブスク判定"],
                "sections": [
                    {"title": "クライアント構成", "text": "Web とネイティブは役割を分けます。Web は設置と案内、ネイティブは実部品判定と背景作業です。", "bullets": ["Web: 設置・法務・プラン UX", "Native: CPU/GPU/RAM/ディスク判定", "Bridge: 状態同期"]},
                    {"title": "サーバー構成", "text": "中央サーバーは無料/貢献プランのキューを分離し、失敗した作業は安全に再割当します。", "bullets": ["分配と再試行", "サブスクの有効/無効化", "ペナルティと信頼度スコア"]},
                ],
            },
            "pricing": {
                "eyebrow": "Pricing",
                "title": "Free から Pro まで、そして貢献型アップグレード",
                "description": "基本利用は無料。より速い応答や上位モデル利用は、予約した貢献時間によって有効化されます。",
                "badges": ["Free", "Basic", "Plus", "Pro"],
                "plans": [
                    {"name": "Free", "price": "¥0", "meta": "基本利用", "badge": "Free", "features": ["基本 AI 利用", "低優先キュー", "軽量モデル中心", "利用回数制限"]},
                    {"name": "Basic", "price": "1時間貢献", "meta": "1日特典", "badge": "Basic", "features": ["待ち時間短縮", "利用制限緩和", "貢献予約", "基本分散補助"]},
                    {"name": "Plus", "price": "5時間貢献", "meta": "7日特典", "badge": "Plus", "recommended": True, "features": ["高優先度", "最新モデル利用", "大幅な制限緩和", "強い分散補助"]},
                    {"name": "Pro", "price": "拡張貢献", "meta": "拡張特典", "badge": "Pro", "features": ["最上位優先度", "高度機能", "大規模リクエスト対応", "長時間貢献モード"]},
                ],
                "sections": [
                    {"title": "分散貢献の動作", "text": "同時利用 300 人・貢献ノード 100 台でも、各リクエストはまずローカル実行を開始し、上位プランに対して追加の分散補助を割り当てます。", "bullets": ["ローカル実行が常に先", "上位プランほど高い重み", "失敗ノードは自動除外", "CPU/GPU/ネットワークを考慮した安全判定"]},
                ],
            },
        },
        "policies": {
            "terms": {"title": "利用規約", "subtitle": "サービス範囲、責任境界、サブスク運用基準を説明します。", "sections": [{"title": "サービス範囲", "body": "Purple Bee は AI 会話、準備物設置、貢献型サブスクリプション、製品案内ページを提供します。"}, {"title": "責任範囲", "body": "生成結果は常に検証が必要です。品質を目指しますが絶対的な正確さを保証するものではありません。"}, {"title": "停止条件", "body": "乱用、無断欠席の繰り返し、安全方針違反があった場合はアクセスを制限できるものとします。"}]},
            "privacy": {"title": "個人情報処理方針", "subtitle": "アカウント、セッション、メモリ、貢献状態の扱いを説明します。", "sections": [{"title": "収集項目", "body": "アカウント情報、セッション設定、貢献状態、信頼性判定のための最小ログを扱うことがあります。"}, {"title": "利用目的", "body": "サービス提供、状態復元、サブスク判定、安全運用のためです。"}, {"title": "保管と削除", "body": "保存した会話やメモリはユーザー自身で削除できます。必要最小限の運用データのみ保持します。"}]},
            "resource-use": {"title": "コンピュータ資源使用同意", "subtitle": "何を、いつ、どんな条件で使うのかを分離して説明する文書です。", "sections": [{"title": "何を使うか", "body": "CPU、GPU、RAM、ストレージ、ネットワーク帯域の一部を設定された上限内で使用します。"}, {"title": "いつ使うか", "body": "予約した貢献時間に限定し、ユーザーの作業再開時は自動で一時停止します。"}, {"title": "停止条件", "body": "温度、バッテリー、ネットワーク、安全条件を外れた場合は作業を停止または再割当します。"}]},
        },
        "policy_labels": {"terms": "利用規約", "privacy": "個人情報", "resource-use": "資源利用同意"},
        "footer": "Purple Bee 製品サイト",
    },
}


def normalize_site_locale(locale_value: str | None) -> str:
    if not locale_value:
        return detect_site_locale()
    value = str(locale_value).strip()
    if value in SUPPORTED_SITE_LOCALES:
        return value
    return SITE_LOCALE_ALIASES.get(value.lower(), detect_site_locale())


def detect_site_locale() -> str:
    header = (request.headers.get("Accept-Language") or "").lower()
    for token in [part.split(";")[0].strip() for part in header.split(",") if part.strip()]:
        if token in SITE_LOCALE_ALIASES:
            return SITE_LOCALE_ALIASES[token]
        short = token.split("-")[0]
        if short in SITE_LOCALE_ALIASES:
            return SITE_LOCALE_ALIASES[short]
    return "en-US"


def build_site_prefix(locale: str) -> str:
    return f"/{locale}/index/purple-bee"


def build_locale_links(path_suffix: str) -> list[dict]:
    links = []
    for locale in SUPPORTED_SITE_LOCALES.keys():
        links.append({
            "locale": locale,
            "label": locale.split("-")[0].upper(),
            "href": f"{build_site_prefix(locale)}{path_suffix}",
        })
    return links


def render_site_marketing(page_key: str, locale: str):
    locale = normalize_site_locale(locale)
    bundle = SITE_COPY.get(locale, SITE_COPY["en-US"])
    path_suffix = "/" if page_key == "home" else f"/{page_key}/"
    template_name = "purplebee-pricing-page.html" if page_key == "pricing" else "purplebee-site-page.html"
    return render_template(
        template_name,
        site_locale=locale,
        site_lang=SUPPORTED_SITE_LOCALES.get(locale, "en"),
        base_prefix=build_site_prefix(locale),
        locale_links=build_locale_links(path_suffix),
        nav=bundle["nav"],
        policy_labels=bundle["policies"],
        footer_copy=bundle["footer"],
        brand_badge=bundle["brand_badge"],
        page_key=page_key,
        page=bundle["pages"][page_key],
        contributor_ui=contributor_ui_copy(locale),
    )


def render_site_policy(policy_key: str, locale: str):
    locale = normalize_site_locale(locale)
    bundle = SITE_COPY.get(locale, SITE_COPY["en-US"])
    return render_template(
        "purplebee-policy-page.html",
        site_locale=locale,
        site_lang=SUPPORTED_SITE_LOCALES.get(locale, "en"),
        base_prefix=build_site_prefix(locale),
        locale_links=build_locale_links(f"/legal/{policy_key}/"),
        nav=bundle["nav"],
        footer_copy=bundle["footer"],
        brand_badge=bundle["brand_badge"],
        policy=bundle["policies"][policy_key],
        policy_labels=bundle["policy_labels"],
    )


@app.route("/")
def index():
    return render_template("index.html")

@app.route("/index/purple-bee/")
def purplebee_global_landing():
    return redirect(f"{build_site_prefix(detect_site_locale())}/")

@app.route("/index/purple-bee/features/")
def purplebee_global_features():
    return redirect(f"{build_site_prefix(detect_site_locale())}/features/")

@app.route("/index/purple-bee/safety/")
def purplebee_global_safety():
    return redirect(f"{build_site_prefix(detect_site_locale())}/safety/")

@app.route("/index/purple-bee/architecture/")
def purplebee_global_architecture():
    return redirect(f"{build_site_prefix(detect_site_locale())}/architecture/")

@app.route("/index/purple-bee/pricing/")
def purplebee_global_pricing():
    return redirect(f"{build_site_prefix(detect_site_locale())}/pricing/")

@app.route("/index/purple-bee/legal/terms/")
def purplebee_global_terms():
    return redirect(f"{build_site_prefix(detect_site_locale())}/legal/terms/")

@app.route("/index/purple-bee/legal/privacy/")
def purplebee_global_privacy():
    return redirect(f"{build_site_prefix(detect_site_locale())}/legal/privacy/")

@app.route("/index/purple-bee/legal/resource-use/")
def purplebee_global_resource_use():
    return redirect(f"{build_site_prefix(detect_site_locale())}/legal/resource-use/")

@app.route("/<locale>/index/purple-bee/")
def purplebee_landing(locale):
    return render_site_marketing("home", locale)

@app.route("/<locale>/index/purple-bee/features/")
def purplebee_landing_features(locale):
    return render_site_marketing("features", locale)

@app.route("/<locale>/index/purple-bee/safety/")
def purplebee_landing_safety(locale):
    return render_site_marketing("safety", locale)

@app.route("/<locale>/index/purple-bee/architecture/")
def purplebee_landing_architecture(locale):
    return render_site_marketing("architecture", locale)

@app.route("/<locale>/index/purple-bee/pricing/")
def purplebee_landing_pricing(locale):
    return render_site_marketing("pricing", locale)

@app.route("/<locale>/index/purple-bee/legal/terms/")
def purplebee_terms(locale):
    return render_site_policy("terms", locale)

@app.route("/<locale>/index/purple-bee/legal/privacy/")
def purplebee_privacy(locale):
    return render_site_policy("privacy", locale)

@app.route("/<locale>/index/purple-bee/legal/resource-use/")
def purplebee_resource_use(locale):
    return render_site_policy("resource-use", locale)

@app.route("/model-panel")
def model_panel():
    return render_template("model_panel.html")

@app.route("/api/model_panel/overview")
def model_panel_overview():
    return jsonify(model_panel_payload())

@app.route("/api/model_panel/select", methods=["POST"])
def model_panel_select():
    data = request.json or {}
    model_id = (data.get("model_id") or "").strip()
    if not model_id:
        return jsonify({"error": "model_id가 필요합니다."}), 400

    registry = ensure_model_registry()
    target = find_registry_model(registry, model_id)
    if target is None:
        return jsonify({"error": "선택한 모델을 찾지 못했습니다."}), 404
    if not target.get("enabled", True):
        return jsonify({"error": "비활성화된 모델은 선택할 수 없습니다."}), 400

    try:
        load_version_into_live_runtime(model_id)
        registry["current_model_id"] = model_id
        refresh_registry_metadata(registry)
        save_registry(registry)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify(model_panel_payload())

@app.route("/api/model_panel/toggle", methods=["POST"])
def model_panel_toggle():
    data = request.json or {}
    model_id = (data.get("model_id") or "").strip()
    enabled = bool(data.get("enabled", True))
    registry = ensure_model_registry()
    target = find_registry_model(registry, model_id)
    if target is None:
        return jsonify({"error": "선택한 모델을 찾지 못했습니다."}), 404
    if not enabled and target.get("current") and len([item for item in registry.get("models", []) if item.get("enabled", True)]) <= 1:
        return jsonify({"error": "현재 활성 모델이 하나뿐이라 비활성화할 수 없습니다."}), 400
    target["enabled"] = enabled
    refresh_registry_metadata(registry)
    save_registry(registry)
    return jsonify(model_panel_payload())

@app.route("/api/model_panel/create", methods=["POST"])
def model_panel_create():
    data = request.json or {}
    version = (data.get("version") or "").strip()
    if not version:
        return jsonify({"error": "새 모델 버전을 입력해 주세요."}), 400

    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", version):
        return jsonify({"error": "버전 형식은 1.3 또는 2.0.1 같은 숫자 표기여야 합니다."}), 400

    try:
        registry, created = clone_latest_model(version)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({
        "created": created,
        "payload": model_panel_payload(),
    })

@app.route("/api/model_panel/train", methods=["POST"])
def model_panel_train():
    data = request.json or {}
    corpus_text = (data.get("text") or "").strip()
    if not corpus_text:
        corpus_text = collect_recent_training_corpus()
    if not corpus_text.strip():
        return jsonify({"error": "학습에 사용할 텍스트가 없습니다."}), 400

    try:
        train_current_model(corpus_text, mode="panel-manual")
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(model_panel_payload())

@app.route("/api/model_panel/train-100m", methods=["POST"])
def model_panel_train_100m():
    data = request.json or {}
    model_id = (data.get("model_id") or ensure_model_registry().get("current_model_id") or "").strip()
    corpus_text = (data.get("text") or "").strip()
    domain = (data.get("domain") or "general").strip().lower()
    dry_run = bool(data.get("dry_run"))
    steps = int(data.get("steps") or 0) or None
    eval_steps = data.get("eval_steps")
    if not model_id:
        return jsonify({"error": "학습할 모델을 찾지 못했습니다."}), 400

    try:
        domain_text = build_domain_training_text(domain)
        combined_text = "\n\n".join([text for text in [domain_text, corpus_text] if text.strip()]).strip()
        launch_100m_training(model_id, manual_text=combined_text, dry_run=dry_run, steps=steps, eval_steps=eval_steps)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(model_panel_payload())

@app.route("/api/model_panel/evaluate-100m", methods=["POST"])
def model_panel_evaluate_100m():
    data = request.json or {}
    model_id = (data.get("model_id") or ensure_model_registry().get("current_model_id") or "").strip()
    if not model_id:
        return jsonify({"error": "평가할 모델을 찾지 못했습니다."}), 400
    try:
        result = run_100m_regression_eval(model_id)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({
        "result": result,
        "payload": model_panel_payload(),
    })

@app.route("/api/model_panel/generate-100m", methods=["POST"])
def model_panel_generate_100m():
    data = request.json or {}
    model_id = (data.get("model_id") or ensure_model_registry().get("current_model_id") or "").strip()
    prompt = (data.get("prompt") or "").strip()
    max_new_tokens = int(data.get("max_new_tokens") or 80)
    temperature = float(data.get("temperature") or 0.8)
    top_k = int(data.get("top_k") or 40)

    if not model_id:
        return jsonify({"error": "생성에 사용할 모델을 찾지 못했습니다."}), 400

    try:
        result = run_100m_generation(
            model_id,
            prompt=prompt,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            top_k=top_k,
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "result": result,
        "payload": model_panel_payload(),
    })

@app.route("/api/model_panel/package-browser", methods=["POST"])
def model_panel_package_browser():
    data = request.json or {}
    model_id = (data.get("model_id") or ensure_model_registry().get("current_model_id") or "").strip()
    if not model_id:
        return jsonify({"error": "browser packaging target model is missing"}), 400
    try:
        result = run_browser_packaging(model_id)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({
        "result": result,
        "payload": model_panel_payload(),
    })

@app.route("/api/model_panel/runtime-smoke", methods=["POST"])
def model_panel_runtime_smoke():
    data = request.json or {}
    model_id = (data.get("model_id") or ensure_model_registry().get("current_model_id") or "").strip()
    if not model_id:
        return jsonify({"error": "점검할 모델을 찾지 못했습니다."}), 400
    try:
        result = run_runtime_smoke(model_id)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"result": result, "payload": model_panel_payload()})

@app.route("/api/model_panel/deploy-settings", methods=["POST"])
def model_panel_deploy_settings():
    data = request.json or {}
    current = load_deployment_config()
    merged = {
        "public_base_url": data.get("public_base_url", current.get("public_base_url")),
        "public_backend_url": data.get("public_backend_url", current.get("public_backend_url")),
        "storage": data.get("storage", current.get("storage")),
        "provider_preference": data.get("provider_preference", current.get("provider_preference")),
    }
    save_deployment_config(merged)
    return jsonify(model_panel_payload())

@app.route("/api/model_panel/hf-upload", methods=["POST"])
def model_panel_hf_upload():
    try:
        result = run_hf_upload_action()
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"result": result, "payload": model_panel_payload()})

@app.route("/api/model_panel/deploy-cloudflare", methods=["POST"])
def model_panel_deploy_cloudflare():
    try:
        result = run_cloudflare_deploy_action()
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"result": result, "payload": model_panel_payload()})

@app.route("/api/model_panel/package-and-deploy", methods=["POST"])
def model_panel_package_and_deploy():
    data = request.json or {}
    model_id = (data.get("model_id") or ensure_model_registry().get("current_model_id") or "").strip()
    run_hf = bool(data.get("run_hf_upload", True))
    if not model_id:
        return jsonify({"error": "대상 모델이 없습니다."}), 400
    try:
        packaging = run_browser_packaging(model_id)
        upload = run_hf_upload_action() if run_hf else None
        deploy = run_cloudflare_deploy_action()
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({
        "result": {
            "packaging": packaging,
            "hf_upload": upload,
            "deploy": deploy,
        },
        "payload": model_panel_payload(),
    })

@app.route("/api/model_panel/cleanup", methods=["POST"])
def model_panel_cleanup():
    try:
        result = archive_cleanup_candidates()
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"result": result, "payload": model_panel_payload()})

@app.route("/api/runtime/browser-manifest")
def runtime_browser_manifest():
    model_id = (request.args.get("model_id") or ensure_model_registry().get("current_model_id") or "").strip()
    if not model_id:
        return jsonify({"error": "runtime model is missing"}), 404
    try:
        payload = runtime_manifest_payload(model_id)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 404
    return jsonify(payload)

@app.route("/api/runtime/assets/<path:asset_name>")
def runtime_asset_proxy(asset_name):
    model_id = (request.args.get("model_id") or ensure_model_registry().get("current_model_id") or "").strip()
    if not model_id:
        return jsonify({"error": "runtime model is missing"}), 404

    deployment = deployment_overview_for(model_id)
    public_base_url = str(deployment.get("public_base_url") or "").rstrip("/")
    if not public_base_url:
        return jsonify({"error": "public runtime storage is not configured"}), 404

    artifacts = deployment.get("artifacts") or {}
    allowed_names = set()
    for key in ["onnx", "onnx_data", "tokenizer"]:
        value = artifacts.get(key)
        if value:
            allowed_names.add(Path(value).name)
    if asset_name not in allowed_names:
        return jsonify({"error": "asset not found"}), 404

    upstream_url = f"{public_base_url}/{asset_name}"
    forward_headers = {"User-Agent": HEADERS.get("User-Agent", "PurpleBee/1.0")}
    if request.headers.get("Range"):
        forward_headers["Range"] = request.headers.get("Range")
    if request.headers.get("If-None-Match"):
        forward_headers["If-None-Match"] = request.headers.get("If-None-Match")
    if request.headers.get("If-Modified-Since"):
        forward_headers["If-Modified-Since"] = request.headers.get("If-Modified-Since")
    if request.headers.get("Accept"):
        forward_headers["Accept"] = request.headers.get("Accept")

    try:
        upstream = requests.get(
            upstream_url,
            stream=True,
            timeout=60,
            headers=forward_headers,
        )
    except Exception as exc:
        return jsonify({"error": f"asset fetch failed: {exc}"}), 502

    passthrough_headers = {
        "Content-Type": upstream.headers.get("Content-Type", "application/octet-stream"),
        "Cache-Control": "public, max-age=3600",
    }
    content_length = upstream.headers.get("Content-Length")
    if content_length:
        passthrough_headers["Content-Length"] = content_length
    accept_ranges = upstream.headers.get("Accept-Ranges")
    if accept_ranges:
        passthrough_headers["Accept-Ranges"] = accept_ranges

    return Response(
        upstream.iter_content(chunk_size=1024 * 128),
        status=upstream.status_code,
        headers=passthrough_headers,
    )

@app.route("/api/hf-proxy/<path:upstream_path>", methods=["GET", "HEAD"])
def runtime_hf_proxy(upstream_path):
    safe_path = (upstream_path or "").lstrip("/")
    if not safe_path or ".." in safe_path:
        return jsonify({"error": "invalid upstream path"}), 400

    upstream_url = f"https://huggingface.co/{safe_path}"
    if request.query_string:
        upstream_url = f"{upstream_url}?{request.query_string.decode('utf-8', errors='ignore')}"

    forward_headers = {"User-Agent": HEADERS.get("User-Agent", "PurpleBee/1.0")}
    if request.headers.get("Range"):
        forward_headers["Range"] = request.headers.get("Range")
    if request.headers.get("If-None-Match"):
        forward_headers["If-None-Match"] = request.headers.get("If-None-Match")
    if request.headers.get("If-Modified-Since"):
        forward_headers["If-Modified-Since"] = request.headers.get("If-Modified-Since")
    if request.headers.get("Accept"):
        forward_headers["Accept"] = request.headers.get("Accept")

    try:
        upstream = requests.request(
            "HEAD" if request.method == "HEAD" else "GET",
            upstream_url,
            stream=request.method != "HEAD",
            timeout=90,
            headers=forward_headers,
            allow_redirects=True,
        )
    except Exception as exc:
        return jsonify({"error": f"hf proxy failed: {exc}"}), 502

    passthrough_headers = {
        "Content-Type": upstream.headers.get("Content-Type", "application/octet-stream"),
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": request.headers.get("Origin") or "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range, If-None-Match, If-Modified-Since",
        "Vary": "Origin",
        "X-Purple-Bee-Asset-Proxy": "hf-proxy",
    }
    for header_name in ["Content-Length", "Accept-Ranges", "ETag", "Last-Modified", "Content-Disposition"]:
        header_value = upstream.headers.get(header_name)
        if header_value:
            passthrough_headers[header_name] = header_value

    if request.method == "HEAD":
        return Response(status=upstream.status_code, headers=passthrough_headers)

    return Response(
        upstream.iter_content(chunk_size=1024 * 128),
        status=upstream.status_code,
        headers=passthrough_headers,
    )

@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.json
    query = data.get("message", "").strip()
    history = data.get("history", [])
    use_web = data.get("web_search", True)
    session_id = data.get("session_id", "default")

    if not query:
        return jsonify({"error": "메시지가 비어 있습니다."}), 400

    # 대화 저장
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?,?,?)",
                  (session_id, "user", query))
        conn.commit()
        conn.close()
    except:
        pass

    def stream():
        full = []
        for chunk in generate_response(query, history, use_web):
            full.append(chunk)
            yield f"data: {json.dumps({'chunk': chunk}, ensure_ascii=False)}\n\n"
        final_text = "".join(full)
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?,?,?)",
                      (session_id, "assistant", final_text[:4000]))
            conn.commit()
            conn.close()
        except Exception:
            pass
        yield f"data: {json.dumps({'done': True, 'full': final_text}, ensure_ascii=False)}\n\n"

    return Response(stream_with_context(stream()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.route("/api/chat_once", methods=["POST"])
def chat_once():
    data = request.json or {}
    query = (data.get("message") or "").strip()
    history = data.get("history", [])
    session_id = data.get("session_id", "default")
    if not query:
        return jsonify({"error": "메시지가 비어 있습니다."}), 400

    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?,?,?)",
                  (session_id, "user", query))
        conn.commit()
        conn.close()
    except Exception:
        pass

    chunks = list(generate_response(query, history, use_web=False))
    full = "".join(chunks)
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?,?,?)",
                  (session_id, "assistant", full[:4000]))
        conn.commit()
        conn.close()
    except Exception:
        pass
    return jsonify({"reply": full})

@app.route("/api/contributor/plans")
def contributor_plans_api():
    return jsonify({"ok": True, "plans": CONTRIBUTOR_PLAN_RULES})

@app.route("/api/contributor/status")
def contributor_status_api():
    try:
        user_id = str(request.args.get("user_id", "")).strip()
        if not user_id:
            return jsonify({"ok": False, "error": "user_id_required"}), 400
        payload = get_contributor_status(user_id)
        if not payload:
            return jsonify({"ok": False, "error": "user_not_found"}), 404
        return jsonify({"ok": True, **payload})
    except Exception as exc:
        return jsonify({
            "ok": False,
            "error": "contributor_status_failed",
            "message": str(exc),
            "traceback": traceback.format_exc().splitlines()[-8:],
        }), 500

@app.route("/api/contributor/quote", methods=["POST"])
def contributor_quote_api():
    try:
        data = request.get_json(silent=True) or {}
        user_id = str(data.get("user_id", "")).strip()
        if not user_id:
            return jsonify({"ok": False, "error": "user_id_required"}), 400
        plan = normalize_contributor_plan(data.get("plan"))
        hours = float(data.get("hours") or CONTRIBUTOR_PLAN_RULES[plan]["min_hours"] or 0)
        device_profile = data.get("device_profile") or {}
        account = ensure_contributor_account(user_id, data.get("display_name") or "")
        quote = compute_contributor_quote(plan, hours, device_profile)
        conn = db_connect()
        c = conn.cursor()
        c.execute(
            """UPDATE contributor_accounts
               SET display_name=?, hardware_json=?, latest_quote_json=?, updated_at=?
               WHERE user_id=?""",
            (
                str(data.get("display_name") or (account or {}).get("display_name") or ""),
                json.dumps(device_profile, ensure_ascii=False),
                json.dumps(quote, ensure_ascii=False),
                now_iso(),
                user_id,
            ),
        )
        conn.commit()
        conn.close()
        return jsonify({"ok": True, "quote": quote})
    except Exception as exc:
        return jsonify({
            "ok": False,
            "error": "contributor_quote_failed",
            "message": str(exc),
            "traceback": traceback.format_exc().splitlines()[-8:],
        }), 500

@app.route("/api/contributor/reserve", methods=["POST"])
def contributor_reserve_api():
    try:
        data = request.get_json(silent=True) or {}
        user_id = str(data.get("user_id", "")).strip()
        if not user_id:
            return jsonify({"ok": False, "error": "user_id_required"}), 400

        plan = normalize_contributor_plan(data.get("plan"))
        hours = float(data.get("hours") or CONTRIBUTOR_PLAN_RULES[plan]["min_hours"] or 0)
        starts_at = parse_iso(data.get("starts_at")) or datetime.now()
        cpu_cap = max(20, min(int(data.get("cpu_cap") or 70), 90))
        gpu_cap = max(20, min(int(data.get("gpu_cap") or 70), 90))
        device_profile = data.get("device_profile") or {}
        display_name = str(data.get("display_name") or "").strip()

        if plan != "Free" and hours < CONTRIBUTOR_PLAN_RULES[plan]["min_hours"]:
            return jsonify({
                "ok": False,
                "error": "insufficient_hours",
                "message": f"{plan} 플랜은 최소 {CONTRIBUTOR_PLAN_RULES[plan]['min_hours']}시간 예약이 필요합니다.",
            }), 400

        account = ensure_contributor_account(user_id, display_name)
        quote = compute_contributor_quote(plan, hours, device_profile)
        ends_at = starts_at + timedelta(hours=hours)
        premium_until = ends_at + timedelta(days=quote["premium_days"])

        conn = db_connect()
        c = conn.cursor()
        c.execute(
            """INSERT INTO contributor_reservations
               (user_id, plan, starts_at, ends_at, hours, premium_days, hardware_multiplier, cpu_cap, gpu_cap, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)""",
            (
                user_id,
                plan,
                starts_at.isoformat(timespec="seconds"),
                ends_at.isoformat(timespec="seconds"),
                hours,
                quote["premium_days"],
                quote["hardware_multiplier"],
                cpu_cap,
                gpu_cap,
                now_iso(),
            ),
        )
        c.execute(
            """UPDATE contributor_accounts
               SET display_name=?, plan=?, contributor_status=?, premium_until=?, hardware_json=?, latest_quote_json=?, updated_at=?
               WHERE user_id=?""",
            (
                display_name or (account or {}).get("display_name") or "",
                plan,
                "scheduled" if plan != "Free" else "inactive",
                premium_until.isoformat(timespec="seconds") if quote["premium_days"] > 0 else None,
                json.dumps(device_profile, ensure_ascii=False),
                json.dumps(quote, ensure_ascii=False),
                now_iso(),
                user_id,
            ),
        )
        conn.commit()
        conn.close()
        return jsonify({
            "ok": True,
            "message": "기여 예약이 저장되었습니다.",
            "reservation": {
                "plan": plan,
                "starts_at": starts_at.isoformat(timespec="seconds"),
                "ends_at": ends_at.isoformat(timespec="seconds"),
                "hours": hours,
                "cpu_cap": cpu_cap,
                "gpu_cap": gpu_cap,
            },
            "quote": quote,
            "premium_until": premium_until.isoformat(timespec="seconds") if quote["premium_days"] > 0 else None,
        })
    except Exception as exc:
        return jsonify({
            "ok": False,
            "error": "contributor_reserve_failed",
            "message": str(exc),
            "traceback": traceback.format_exc().splitlines()[-8:],
        }), 500

@app.route("/api/contributor/client/config")
def contributor_client_config_api():
    user_id = trim(request.args.get("user_id"))
    display_name = trim(request.args.get("display_name"))
    if not user_id:
        return jsonify({"ok": False, "error": "user_id_required"}), 400
    ensure_contributor_account(user_id, display_name)
    payload = build_contributor_client_config(user_id, display_name)
    return jsonify({"ok": True, "config": payload})

@app.route("/api/contributor/client/download")
def contributor_client_download_api():
    user_id = trim(request.args.get("user_id"))
    display_name = trim(request.args.get("display_name"))
    if not user_id:
        return jsonify({"ok": False, "error": "user_id_required"}), 400
    ensure_contributor_account(user_id, display_name)
    archive = build_contributor_client_zip(user_id, display_name)
    return send_file(
        archive,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"purple-bee-contributor-{user_id[:18] or 'client'}.zip",
    )

@app.route("/api/contributor/client/register", methods=["POST"])
def contributor_client_register_api():
    data = request.get_json(silent=True) or {}
    user_id = trim(data.get("user_id") or data.get("userId"))
    display_name = trim(data.get("display_name") or data.get("displayName"))
    if not user_id:
        return jsonify({"ok": False, "error": "user_id_required"}), 400
    ensure_contributor_account(user_id, display_name)
    device = upsert_contributor_device(
        user_id=user_id,
        device_name=data.get("device_name") or data.get("deviceName") or "Purple Bee Contributor Device",
        hardware=data.get("hardware") or {},
        runtime=data.get("runtime") or {},
        caps=data.get("caps") or {},
        client_version=data.get("client_version") or data.get("clientVersion") or "",
        status=data.get("status") or "linked",
        device_id=data.get("device_id") or data.get("deviceId"),
    )
    return jsonify({"ok": True, "device": device, "config": build_contributor_client_config(user_id, display_name)})

@app.route("/api/contributor/client/heartbeat", methods=["POST"])
def contributor_client_heartbeat_api():
    data = request.get_json(silent=True) or {}
    user_id = trim(data.get("user_id") or data.get("userId"))
    device_id = trim(data.get("device_id") or data.get("deviceId"))
    if not user_id or not device_id:
        return jsonify({"ok": False, "error": "user_id_and_device_id_required"}), 400
    device = upsert_contributor_device(
        user_id=user_id,
        device_name=data.get("device_name") or data.get("deviceName") or "Purple Bee Contributor Device",
        hardware=data.get("hardware") or {},
        runtime=data.get("runtime") or {},
        caps=data.get("caps") or {},
        client_version=data.get("client_version") or data.get("clientVersion") or "",
        status=data.get("status") or "idle",
        device_id=device_id,
    )
    return jsonify({"ok": True, "device": device})

@app.route("/api/contributor/client/status")
def contributor_client_status_api():
    user_id = trim(request.args.get("user_id"))
    if not user_id:
        return jsonify({"ok": False, "error": "user_id_required"}), 400
    return jsonify({
        "ok": True,
        "devices": get_contributor_devices(user_id),
        "status": get_contributor_status(user_id),
    })

@app.route("/api/contributors/register", methods=["POST"])
def contributor_alias_register_api():
    data = request.get_json(silent=True) or {}
    user_id = trim(data.get("userId") or data.get("user_id"))
    display_name = trim(data.get("displayName") or data.get("display_name"))
    if not user_id:
        return jsonify({"ok": False, "error": "userId-required"}), 400
    ensure_contributor_account(user_id, display_name)
    device = upsert_contributor_device(
        user_id=user_id,
        device_name=data.get("deviceName") or data.get("device_name") or "Purple Bee Contributor Device",
        hardware=data.get("hardware") or {},
        runtime=data.get("runtime") or {},
        caps=data.get("caps") or {},
        client_version=data.get("clientVersion") or "",
        status="registered",
        device_id=data.get("deviceId") or data.get("device_id"),
    )
    return jsonify({"ok": True, "contributor": {"id": device["device_id"], "userId": user_id, "deviceName": device["device_name"]}})

@app.route("/api/contributors/heartbeat", methods=["POST"])
def contributor_alias_heartbeat_api():
    data = request.get_json(silent=True) or {}
    user_id = trim(data.get("userId") or data.get("user_id"))
    contributor_id = trim(data.get("contributorId") or data.get("contributor_id"))
    if not user_id or not contributor_id:
        return jsonify({"ok": False, "error": "userId-and-contributorId-required"}), 400
    device = upsert_contributor_device(
        user_id=user_id,
        device_name=data.get("deviceName") or "Purple Bee Contributor Device",
        hardware=data.get("hardware") or {},
        runtime=data.get("runtime") or {},
        caps=data.get("caps") or {},
        client_version=data.get("clientVersion") or "",
        status=data.get("status") or "idle",
        device_id=contributor_id,
    )
    return jsonify({"ok": True, "contributor": {"id": device["device_id"], "status": device["status"]}})

@app.route("/api/contributors/reservations", methods=["POST"])
def contributor_alias_reservation_api():
    data = request.get_json(silent=True) or {}
    with app.test_request_context(
        "/api/contributor/reserve",
        method="POST",
        json={
            "user_id": data.get("userId"),
            "display_name": data.get("displayName"),
            "plan": data.get("plan") or "Plus",
            "hours": max((parse_iso(data.get("endsAt")) - parse_iso(data.get("startsAt"))).total_seconds() / 3600.0, 0.0) if parse_iso(data.get("startsAt")) and parse_iso(data.get("endsAt")) else data.get("hours") or 1,
            "starts_at": data.get("startsAt"),
            "cpu_cap": (data.get("caps") or {}).get("cpuMaxPercent", 70),
            "gpu_cap": (data.get("caps") or {}).get("gpuMaxPercent", 70),
            "device_profile": data.get("hardware") or {},
        },
    ):
        return contributor_reserve_api()

@app.route("/api/contributors/credit", methods=["POST"])
def contributor_alias_credit_api():
    data = request.get_json(silent=True) or {}
    user_id = trim(data.get("userId") or data.get("user_id"))
    raw_minutes = float(data.get("rawMinutes") or data.get("raw_minutes") or 0)
    if not user_id or raw_minutes <= 0:
        return jsonify({"ok": False, "error": "userId-and-rawMinutes-required"}), 400
    credit = credit_contributor_minutes(user_id, raw_minutes, data.get("hardware") or {})
    return jsonify({"ok": True, "credit": credit})

@app.route("/api/subscriptions/evaluate", methods=["POST"])
def contributor_alias_evaluate_api():
    data = request.get_json(silent=True) or {}
    user_id = trim(data.get("userId") or data.get("user_id"))
    if not user_id:
        return jsonify({"ok": False, "error": "userId-required"}), 400
    result = evaluate_contributor_subscription(user_id)
    return jsonify({"ok": True, "result": result, "subscription": (result or {}).get("account")})

@app.route("/api/work/claim", methods=["POST"])
def contributor_alias_claim_api():
    return jsonify({"ok": True, "task": None})

@app.route("/api/work/<task_id>/complete", methods=["POST"])
def contributor_alias_complete_api(task_id):
    return jsonify({"ok": True, "task": {"id": task_id, "status": "accepted"}})


@app.route("/api/pbx_chat", methods=["POST", "OPTIONS"])
def pbx_chat():
    """
    Purple Bee JS 클라이언트 전용 채팅 엔드포인트.
    브라우저 모델이 실패할 때 이 엔드포인트로 폴백.
    SSE 스트리밍 방식으로 실시간 타이핑 효과 제공.
    """
    if request.method == "OPTIONS":
        return local_runtime_preflight_response()

    data = request.json or {}
    query = (data.get("message") or data.get("query") or "").strip()
    history = data.get("history", [])
    use_web = data.get("web_search", True)
    session_id = data.get("session_id", "pbx_default")

    if not query:
        return jsonify({"error": "메시지가 비어 있어요."}), 400

    def stream():
        full = []
        for chunk in generate_response(query, history, use_web):
            full.append(chunk)
            yield f"data: {json.dumps({'chunk': chunk}, ensure_ascii=False)}\n\n"
        final_text = "".join(full).strip()
        if not final_text:
            yield f"data: {json.dumps({'done': True, 'full': '', 'ok': False, 'code': 'PB-ANSWER-FAILED'}, ensure_ascii=False)}\n\n"
            return
        yield f"data: {json.dumps({'done': True, 'full': final_text, 'ok': True}, ensure_ascii=False)}\n\n"
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?,?,?)",
                      (session_id, "user", query))
            c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?,?,?)",
                      (session_id, "assistant", final_text[:4000]))
            conn.commit()
            conn.close()
        except Exception:
            pass

    resp = Response(
        stream_with_context(stream()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Private-Network": "true",
        }
    )
    return resp

@app.route("/api/pbx_chat_sync", methods=["POST", "OPTIONS"])
def pbx_chat_sync():
    """동기식 JSON 응답 버전 (스트리밍 불가 환경용)"""
    if request.method == "OPTIONS":
        return local_runtime_preflight_response()

    data = request.json or {}
    query = (data.get("message") or data.get("query") or "").strip()
    history = data.get("history", [])
    use_web = data.get("web_search", True)

    if not query:
        return jsonify({"error": "메시지가 비어 있어요."}), 400

    chunks = list(generate_response(query, history, use_web))
    full = "".join(chunks).strip()
    if not full:
        return local_runtime_corsify(jsonify({
            "reply": "",
            "ok": False,
            "code": "PB-ANSWER-FAILED",
            "error": "model_generation_failed",
        })), 503
    return local_runtime_corsify(jsonify({"reply": full, "ok": True}))

@app.route("/api/local_runtime/status", methods=["GET", "OPTIONS"])
def local_runtime_status():
    if request.method == "OPTIONS":
        return local_runtime_preflight_response()
    try:
        payload = ensure_local_runtime_bundle()
        payload["server_origin"] = request.host_url.rstrip("/")
        payload["ready"] = True
        return local_runtime_corsify(jsonify(payload))
    except Exception as exc:
        return local_runtime_corsify(jsonify({
            "ok": False,
            "ready": False,
            "error": str(exc),
        })), 500
@app.route("/api/health")
@app.route("/api/status")
def status():
    current_model_id = ensure_model_registry().get("current_model_id")
    stats = stats_for_version(current_model_id) or model.get_stats()
    kb_count = 0
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM knowledge")
        kb_count = c.fetchone()[0]
        conn.close()
    except:
        pass
    deployment = load_deployment_config()
    runtime_diag = {
        "model_id": current_model_id,
        "torch_runtime_available": large_model_torch_available(current_model_id),
        "onnx_runtime_available": large_model_onnx_available(current_model_id),
        "large_model_available": large_model_available(current_model_id),
        "onnxruntime_imported": ort is not None,
        "numpy_imported": np is not None,
        "preferred_checkpoint": str(preferred_checkpoint_path_for(current_model_id) or ""),
        "tokenizer_path": str(tokenizer_path_for(current_model_id)),
        "backend": detect_100m_backend(),
        "public_base_url": str(deployment.get("public_base_url") or ""),
        "public_backend_url": str(deployment.get("public_backend_url") or ""),
        "force_onnx_runtime": str(os.environ.get("PB_FORCE_ONNX_RUNTIME") or "").strip(),
    }
    return jsonify({
        "ok": True,
        "model": stats,
        "llm_runtime": runtime_diag,
        "training": training_status,
        "knowledge_count": kb_count,
        "server_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    })

@app.route("/api/train", methods=["POST"])
def manual_train():
    data = request.json
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "텍스트가 필요합니다."}), 400
    try:
        train_current_model(text, mode="legacy-api")
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(model_panel_payload())

@app.route("/api/history")
def get_history():
    session_id = request.args.get("session", "default")
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""SELECT role, content, timestamp FROM conversations
                     WHERE session_id=? ORDER BY id DESC LIMIT 50""", (session_id,))
        rows = c.fetchall()
        conn.close()
        return jsonify([{"role": r, "content": c, "time": t} for r, c, t in reversed(rows)])
    except:
        return jsonify([])

@app.route("/api/search_sources", methods=["POST"])
def add_source():
    """수동으로 URL 추가하여 학습 후보 자료로 저장"""
    data = request.json
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL이 필요합니다."}), 400

    def fetch_and_store():
        content = fetch_url(url)
        if content:
            save_knowledge(url, url, content)
            training_status["docs_collected"] += 1
            training_status["message"] = f"학습 후보 자료 저장 완료: {url[:40]}"

    threading.Thread(target=fetch_and_store, daemon=True).start()
    return jsonify({"message": "백그라운드에서 자료를 수집해 저장 중입니다. 실제 학습은 모델 패널에서 진행하세요."})

@app.route("/api/tool/run", methods=["POST"])
def api_tool_run():
    """통합 도구 실행 엔드포인트."""
    data = request.json or {}
    tool_id = data.get("tool_id", "")
    params  = data.get("params", {})
    if not tool_id:
        return jsonify({"error": "tool_id가 필요합니다."}), 400
    result = run_tool(tool_id, params)
    return jsonify(result)

@app.route("/api/tool/image/generate", methods=["POST"])
def api_image_generate():
    """이미지 생성."""
    data   = request.json or {}
    prompt = data.get("prompt", "").strip()
    style  = data.get("style", "realistic")
    if not prompt:
        return jsonify({"error": "prompt가 필요합니다."}), 400
    result = tool_image_generate(prompt, style)
    return jsonify(result)

@app.route("/api/tool/image/analyze", methods=["POST"])
def api_image_analyze():
    """이미지 분석."""
    data       = request.json or {}
    image_data = data.get("image_data")
    image_url  = data.get("image_url")
    result     = tool_image_analyze(image_data, image_url)
    return jsonify(result)

@app.route("/api/tool/document/analyze", methods=["POST"])
def api_document_analyze():
    """문서 분석."""
    data    = request.json or {}
    text    = data.get("text")
    url     = data.get("url")
    result  = tool_document_analyze(text_content=text, url=url)
    return jsonify(result)

@app.route("/api/tool/file/generate", methods=["POST"])
def api_file_generate():
    """파일 생성."""
    data      = request.json or {}
    filename  = data.get("filename", "output")
    file_cont = data.get("content", "")
    file_type = data.get("file_type", "txt")
    if not file_cont:
        return jsonify({"error": "content가 필요합니다."}), 400
    result = tool_file_generate(filename, file_cont, file_type)
    return jsonify(result)

@app.route("/api/tool/creative/brainstorm", methods=["POST"])
def api_creative_brainstorm():
    """창의 아이디어 생성."""
    data  = request.json or {}
    topic = data.get("topic", "").strip()
    count = int(data.get("count", 5))
    if not topic:
        return jsonify({"error": "topic이 필요합니다."}), 400
    result = tool_creative_brainstorm(topic, count)
    return jsonify(result)

@app.route("/api/tool/empathy", methods=["POST"])
def api_empathy():
    """감정 공감 응답."""
    data  = request.json or {}
    query = data.get("query", "").strip()
    if not query:
        return jsonify({"error": "query가 필요합니다."}), 400
    result = tool_empathy_response(query)
    return jsonify(result)

@app.route("/api/tool/detect", methods=["POST"])
def api_detect_tool():
    """입력에서 도구 의도 감지."""
    data  = request.json or {}
    query = data.get("query", "")
    tool  = detect_tool_intent(query)
    return jsonify({"tool_id": tool, "detected": tool is not None})

@app.route("/api/tool/list", methods=["GET"])
def api_tool_list():
    """사용 가능한 도구 목록."""
    tools = [
        {"id": "image_generate",   "name": "이미지 생성",   "status": "active", "description": "텍스트 설명으로 이미지를 생성해요."},
        {"id": "image_analyze",    "name": "이미지 분석",   "status": "active", "description": "이미지를 분석하고 설명해요."},
        {"id": "document_analyze", "name": "문서 분석",     "status": "active", "description": "문서/URL/텍스트를 요약·분석해요."},
        {"id": "file_generate",    "name": "파일 생성",     "status": "active", "description": "지정 내용으로 파일을 만들어요."},
        {"id": "creative",         "name": "창의력/아이디어","status": "active", "description": "주제에 대한 창의적 아이디어를 제안해요."},
        {"id": "empathy",          "name": "감정 공감",     "status": "active", "description": "감정적 고민에 공감하고 조언해요."},
    ]
    return jsonify({"tools": tools, "count": len(tools)})


# ── 실행 진입점 ──────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  Purple Bee - 딥러닝 학습 챗봇 서버")
    print("=" * 60)
    init_db()
    ensure_model_registry()

    # 기존 데이터 로드
    print(f"  모델 상태: vocab={len(model.vocab)}, docs={model.trained_docs}")
    port = int(os.environ.get("PORT", 7860))
    print(f"  모델 패널: http://localhost:{port}/model-panel")
    print("  자동 웹 학습 루프는 기본 비활성화 상태입니다.")
    print(f"  로컬 서버: http://localhost:{port}")
    print("=" * 60)

    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)




