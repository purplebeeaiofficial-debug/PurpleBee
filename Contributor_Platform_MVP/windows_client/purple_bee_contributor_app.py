import json
import os
import platform
import subprocess
import threading
import time
import uuid
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk

try:
    import psutil
except Exception:
    psutil = None

try:
    import requests
except Exception:
    requests = None

APP_NAME = "Purple Bee Contributor"
APP_VERSION = "3.0.0"
DEFAULT_SERVER = "https://purple-bee-cloudflare.purplebeeai.workers.dev"
CONFIG_DIR = Path(os.getenv("APPDATA", Path.home() / ".purplebee")) / "PurpleBeeContributor"
CONFIG_PATH = CONFIG_DIR / "config.json"
POLL_SECONDS = 5
HEARTBEAT_SECONDS = 30

COLORS = {
    "bg": "#0b0a12",
    "panel": "#151424",
    "panel_alt": "#1d1b31",
    "surface": "#25213a",
    "surface_2": "#2f2a49",
    "border": "#3b355b",
    "text": "#f5f0ff",
    "muted": "#b8afdd",
    "accent": "#9b5cff",
    "accent_2": "#e255c6",
    "success": "#37c997",
    "warning": "#f5c451",
    "danger": "#ff6b6b",
}

LEGAL_TEXT = """Purple Bee Contributor 사용 전 안내

이 앱은 사용자가 승인한 범위 안에서 CPU, GPU, RAM, 저장 공간, 네트워크 자원의 일부를 활용합니다.
사용자는 언제든 기여를 중단할 수 있으며, 사용 중인 프로그램이 감지되거나 리소스 상한을 초과하면 자동으로 일시정지될 수 있습니다.

중요 안내
- Purple Bee는 기기 환경 차이로 발생할 수 있는 성능 저하, 발열, 배터리 소모, 네트워크 사용량 증가를 보장하거나 보상하지 않습니다.
- 회사는 예기치 않은 종료, 작업 실패, 네트워크 중단, 성능 변동, 드라이버 충돌, 호환성 문제에 대해 직접적인 책임을 지지 않습니다.
- 업무용 또는 중요한 작업 중에는 기여를 중단하거나 상한을 낮추는 것을 권장합니다.
- 기여 시간은 서버 검증과 동기화 상태를 기준으로 계산되며, 비정상 종료 또는 중도 이탈 시 일부 시간이 인정되지 않을 수 있습니다.
"""


def load_config():
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {
            "server_base_url": DEFAULT_SERVER,
            "device_id": f"pbxdev_{uuid.uuid4().hex[:12]}",
            "device_name": platform.node() or "Purple Bee Contributor",
            "linked": False,
            "link_code": "",
            "user_id": "",
            "display_name": "",
            "cpu_cap": 70,
            "gpu_cap": 70,
            "contributing": False,
            "last_linked_payload": {},
            "last_error": "",
        }


def save_config(config):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def detect_gpu_name():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if result.returncode == 0:
            rows = [line.strip() for line in result.stdout.splitlines() if line.strip()]
            if rows:
                return rows[0]
    except Exception:
        pass
    return "미확인"


def get_hardware_snapshot():
    cpu_threads = os.cpu_count() or 0
    memory_gb = 0.0
    disk_free_gb = 0.0
    cpu_percent = 0.0
    ram_percent = 0.0
    if psutil:
        try:
            vm = psutil.virtual_memory()
            memory_gb = round(vm.total / (1024 ** 3), 1)
            ram_percent = round(vm.percent, 1)
        except Exception:
            pass
        try:
            disk = psutil.disk_usage(str(Path.home().anchor or "C:\\"))
            disk_free_gb = round(disk.free / (1024 ** 3), 1)
        except Exception:
            pass
        try:
            cpu_percent = round(psutil.cpu_percent(interval=0.15), 1)
        except Exception:
            pass
    return {
        "platform": platform.platform(),
        "cpu_threads": cpu_threads,
        "memory_gb": memory_gb,
        "disk_free_gb": disk_free_gb,
        "gpu_name": detect_gpu_name(),
        "cpu_percent": cpu_percent,
        "ram_percent": ram_percent,
    }


class ContributorApp:
    def __init__(self):
        self.config = load_config()
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.geometry("1040x720")
        self.root.minsize(900, 620)
        self.root.configure(bg=COLORS["bg"])
        self.root.option_add("*Font", ("Segoe UI", 10))
        self.style = ttk.Style()
        try:
            self.style.theme_use("clam")
        except Exception:
            pass
        self.style.configure(
            "Accent.TButton",
            font=("Segoe UI", 11, "bold"),
            padding=11,
            foreground="white",
            background=COLORS["accent"],
            borderwidth=0,
        )
        self.style.map("Accent.TButton", background=[("active", COLORS["accent_2"])])
        self.style.configure(
            "Soft.TButton",
            font=("Segoe UI", 10),
            padding=10,
            foreground=COLORS["text"],
            background=COLORS["surface"],
            bordercolor=COLORS["border"],
            borderwidth=1,
        )
        self.style.map("Soft.TButton", background=[("active", COLORS["surface_2"])])
        self.link_code_var = tk.StringVar(value=self.config.get("link_code", ""))
        self.accept_var = tk.BooleanVar(value=False)
        self.contributing_var = tk.BooleanVar(value=bool(self.config.get("contributing")))
        self.status_vars = {}
        self.after_job = None
        self.last_heartbeat = 0.0
        self.build_shell()
        self.show_entry_screen()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def build_shell(self):
        top = tk.Frame(self.root, bg=COLORS["bg"], padx=22, pady=18)
        top.pack(fill="x")
        badge = tk.Frame(top, bg=COLORS["panel"], highlightthickness=1, highlightbackground=COLORS["border"])
        badge.pack(fill="x")
        inner = tk.Frame(badge, bg=COLORS["panel"], padx=18, pady=16)
        inner.pack(fill="x")

        logo = tk.Canvas(inner, width=54, height=54, bg=COLORS["panel"], highlightthickness=0)
        logo.pack(side="left")
        logo.create_oval(4, 4, 50, 50, fill="#b139d8", outline="")
        logo.create_oval(15, 17, 39, 41, fill="#f5d76e", outline="")
        logo.create_rectangle(20, 22, 34, 26, fill="#5323a8", outline="")
        logo.create_rectangle(20, 29, 34, 33, fill="#5323a8", outline="")
        logo.create_oval(16, 10, 28, 20, fill="#d5ddff", outline="")
        logo.create_oval(26, 10, 38, 20, fill="#d5ddff", outline="")

        text = tk.Frame(inner, bg=COLORS["panel"])
        text.pack(side="left", padx=14)
        tk.Label(text, text=APP_NAME, fg=COLORS["text"], bg=COLORS["panel"], font=("Segoe UI", 19, "bold")).pack(anchor="w")
        tk.Label(
            text,
            text="기여 구독용 설치 앱 · 앱 설치 후 연동 코드를 붙여넣으면 바로 연결됩니다.",
            fg=COLORS["muted"],
            bg=COLORS["panel"],
            font=("Segoe UI", 10),
        ).pack(anchor="w", pady=(3, 0))

        self.body = tk.Frame(self.root, bg=COLORS["bg"], padx=22, pady=0)
        self.body.pack(fill="both", expand=True)

    def clear_body(self):
        for child in self.body.winfo_children():
            child.destroy()

    def build_card(self):
        card = tk.Frame(self.body, bg=COLORS["panel"], highlightthickness=1, highlightbackground=COLORS["border"])
        card.pack(fill="both", expand=True)
        return tk.Frame(card, bg=COLORS["panel"], padx=22, pady=22)

    def section_title(self, parent, title, subtitle):
        tk.Label(parent, text=title, fg=COLORS["text"], bg=COLORS["panel"], font=("Segoe UI", 24, "bold")).pack(anchor="w")
        tk.Label(parent, text=subtitle, fg=COLORS["muted"], bg=COLORS["panel"], font=("Segoe UI", 10)).pack(anchor="w", pady=(6, 18))

    def build_step_strip(self, parent, current):
        labels = ["약관", "앱 설치", "연동", "상태 확인"]
        row = tk.Frame(parent, bg=COLORS["panel"])
        row.pack(fill="x", pady=(0, 18))
        for index, label in enumerate(labels):
            item = tk.Frame(row, bg=COLORS["surface"] if index != current else COLORS["surface_2"], highlightthickness=1, highlightbackground=COLORS["border"])
            item.pack(side="left", fill="x", expand=True, padx=(0 if index == 0 else 8, 0))
            inner = tk.Frame(item, bg=item["bg"], padx=12, pady=10)
            inner.pack(fill="x")
            chip = tk.Label(inner, text=str(index + 1), fg="white", bg=COLORS["accent"] if index <= current else COLORS["border"], font=("Segoe UI", 9, "bold"), width=2)
            chip.pack(anchor="w")
            tk.Label(inner, text=label, fg=COLORS["text"], bg=item["bg"], font=("Segoe UI", 11, "bold")).pack(anchor="w", pady=(8, 0))

    def build_info_banner(self, parent, title, body, tone="accent"):
        color = COLORS["accent"] if tone == "accent" else COLORS["danger"] if tone == "danger" else COLORS["success"]
        bg = COLORS["surface_2"] if tone == "accent" else "#351a26" if tone == "danger" else "#16342f"
        frame = tk.Frame(parent, bg=bg, highlightthickness=1, highlightbackground=color)
        frame.pack(fill="x", pady=(0, 16))
        inner = tk.Frame(frame, bg=bg, padx=14, pady=14)
        inner.pack(fill="x")
        tk.Label(inner, text=title, fg=COLORS["text"], bg=bg, font=("Segoe UI", 11, "bold")).pack(anchor="w")
        tk.Label(inner, text=body, fg=COLORS["muted"], bg=bg, font=("Segoe UI", 10), justify="left", wraplength=820).pack(anchor="w", pady=(6, 0))

    def show_entry_screen(self):
        if self.config.get("linked"):
            self.show_dashboard()
        else:
            self.show_wizard()

    def show_wizard(self):
        self.clear_body()
        inner = self.build_card()
        inner.pack(fill="both", expand=True)
        self.section_title(inner, "기여 앱 설치 마법사", "설치 → 연동 → 상태 확인 순서로 진행합니다.")
        self.build_step_strip(inner, 0)
        self.build_info_banner(
            inner,
            "약관 및 책임 안내",
            "기여 앱은 사용자가 승인한 범위 안에서만 자원을 사용합니다. 성능 저하, 발열, 배터리 소모, 드라이버 충돌, 네트워크 품질 저하 등에 대해 Purple Bee는 직접적인 책임을 지지 않습니다.",
        )

        content = tk.Frame(inner, bg=COLORS["panel"])
        content.pack(fill="both", expand=True)
        left = tk.Frame(content, bg=COLORS["panel"])
        left.pack(side="left", fill="both", expand=True)
        right = tk.Frame(content, bg=COLORS["surface"], highlightthickness=1, highlightbackground=COLORS["border"])
        right.pack(side="left", fill="both", padx=(18, 0))

        text_box = tk.Text(
            left,
            height=14,
            wrap="word",
            bg=COLORS["surface"],
            fg=COLORS["text"],
            insertbackground=COLORS["text"],
            relief="flat",
            padx=14,
            pady=14,
        )
        text_box.pack(fill="both", expand=True)
        text_box.insert("1.0", LEGAL_TEXT)
        text_box.configure(state="disabled")

        right_inner = tk.Frame(right, bg=COLORS["surface"], padx=18, pady=18)
        right_inner.pack(fill="both", expand=True)
        tk.Label(right_inner, text="연동 준비", fg=COLORS["text"], bg=COLORS["surface"], font=("Segoe UI", 16, "bold")).pack(anchor="w")
        tk.Label(
            right_inner,
            text="웹사이트에서 발급한 연동 코드를 입력하면 앱 설치 후 바로 계정과 연결됩니다.",
            fg=COLORS["muted"],
            bg=COLORS["surface"],
            font=("Segoe UI", 10),
            justify="left",
            wraplength=260,
        ).pack(anchor="w", pady=(6, 16))
        tk.Label(right_inner, text="연동 코드", fg=COLORS["muted"], bg=COLORS["surface"], font=("Segoe UI", 10, "bold")).pack(anchor="w")
        entry = ttk.Entry(right_inner, textvariable=self.link_code_var, width=28)
        entry.pack(fill="x", pady=(8, 12))
        tk.Checkbutton(
            right_inner,
            text="약관과 컴퓨터 자원 사용 조건에 동의합니다.",
            variable=self.accept_var,
            bg=COLORS["surface"],
            fg=COLORS["text"],
            selectcolor=COLORS["surface"],
            activebackground=COLORS["surface"],
            activeforeground=COLORS["text"],
            wraplength=260,
            justify="left",
        ).pack(anchor="w", pady=(6, 18))
        actions = tk.Frame(right_inner, bg=COLORS["surface"])
        actions.pack(fill="x", pady=(8, 0))
        ttk.Button(actions, text="설치 및 연동 시작", style="Accent.TButton", command=self.begin_link).pack(fill="x")
        ttk.Button(actions, text="나중에 하기", style="Soft.TButton", command=self.root.destroy).pack(fill="x", pady=(10, 0))
        entry.focus_set()

    def normalize_error(self, error_text):
        text = str(error_text or "").strip()
        if "invalid_or_expired_link_code" in text:
            return "연동 코드가 만료되었거나 다른 기기에서 이미 사용됐습니다.\n\n웹사이트에서 새 연동 코드를 발급한 뒤 다시 시도해 주세요."
        if "link_code_required" in text:
            return "연동 코드가 비어 있습니다.\n\n웹사이트의 기여 구독 상태 화면에서 코드를 복사해 붙여넣어 주세요."
        if "HTTPSConnectionPool" in text or "Connection" in text:
            return "Purple Bee 서버와 연결하지 못했습니다.\n\n인터넷 연결을 확인한 뒤 다시 시도해 주세요."
        if text:
            return f"연동에 실패했습니다.\n\n{text}"
        return "연동에 실패했습니다.\n\n웹사이트에서 새 연동 코드를 발급한 뒤 다시 시도해 주세요."

    def begin_link(self):
        if not self.accept_var.get():
            messagebox.showwarning(APP_NAME, "먼저 약관과 자원 사용 조건에 동의해 주세요.")
            return
        link_code = self.link_code_var.get().strip().upper()
        if not link_code:
            messagebox.showwarning(APP_NAME, "연동 코드를 입력해 주세요.")
            return
        if not requests:
            messagebox.showerror(APP_NAME, "requests 패키지가 없어 연동을 진행할 수 없습니다.")
            return
        payload = {
            "device_id": self.config["device_id"],
            "link_code": link_code,
            "device_name": self.config.get("device_name") or platform.node() or APP_NAME,
            "client_version": APP_VERSION,
            "hardware": get_hardware_snapshot(),
            "runtime": {"os": platform.platform(), "appVersion": APP_VERSION},
            "auto_start": True,
        }
        try:
            response = requests.post(
                self.config.get("server_base_url", DEFAULT_SERVER).rstrip("/") + "/api/contributor/client/link",
                json=payload,
                timeout=20,
            )
            data = response.json()
            if not data.get("ok"):
                raise RuntimeError(data.get("message") or data.get("error") or "연동 실패")
        except Exception as exc:
            self.config["last_error"] = str(exc)
            save_config(self.config)
            messagebox.showerror(APP_NAME, self.normalize_error(exc))
            return

        self.config.update({
            "linked": True,
            "link_code": link_code,
            "user_id": data.get("account", {}).get("user_id", ""),
            "display_name": data.get("account", {}).get("display_name", ""),
            "last_linked_payload": data,
            "last_error": "",
        })
        save_config(self.config)
        self.show_dashboard()

    def dashboard_stat(self, parent, label, value, detail):
        card = tk.Frame(parent, bg=COLORS["surface"], highlightthickness=1, highlightbackground=COLORS["border"])
        card.pack(side="left", fill="both", expand=True, padx=(0, 10))
        inner = tk.Frame(card, bg=COLORS["surface"], padx=14, pady=14)
        inner.pack(fill="both", expand=True)
        tk.Label(inner, text=label, fg=COLORS["muted"], bg=COLORS["surface"], font=("Segoe UI", 9, "bold")).pack(anchor="w")
        value_label = tk.Label(inner, text=value, fg=COLORS["text"], bg=COLORS["surface"], font=("Segoe UI", 17, "bold"))
        value_label.pack(anchor="w", pady=(8, 0))
        detail_label = tk.Label(inner, text=detail, fg=COLORS["muted"], bg=COLORS["surface"], font=("Segoe UI", 9), wraplength=180, justify="left")
        detail_label.pack(anchor="w", pady=(6, 0))
        return value_label, detail_label

    def show_dashboard(self):
        self.clear_body()
        outer = tk.Frame(self.body, bg=COLORS["bg"])
        outer.pack(fill="both", expand=True)
        main = tk.Frame(outer, bg=COLORS["panel"], highlightthickness=1, highlightbackground=COLORS["border"])
        main.pack(side="left", fill="both", expand=True)
        side = tk.Frame(outer, bg=COLORS["panel"], highlightthickness=1, highlightbackground=COLORS["border"], width=300)
        side.pack(side="left", fill="y", padx=(16, 0))
        side.pack_propagate(False)

        main_inner = tk.Frame(main, bg=COLORS["panel"], padx=22, pady=22)
        main_inner.pack(fill="both", expand=True)
        self.section_title(main_inner, "기여 대시보드", "현재 연결 상태와 자원 사용량, 연동 정보를 확인하세요.")

        top = tk.Frame(main_inner, bg=COLORS["panel"])
        top.pack(fill="x")
        self.status_vars["연결 상태"], self.status_vars["연결 상태 세부"] = self.dashboard_stat(top, "연결 상태", "-", "앱 연결 상태")
        self.status_vars["플랜"], self.status_vars["플랜 세부"] = self.dashboard_stat(top, "플랜", "-", "현재 유지 중인 플랜")
        self.status_vars["기여 상태"], self.status_vars["기여 상태 세부"] = self.dashboard_stat(top, "기여 상태", "-", "실시간 기여 상태")
        self.status_vars["서버"], self.status_vars["서버 세부"] = self.dashboard_stat(top, "서버", "-", "연결 중인 Purple Bee 서버")

        usage_panel = tk.Frame(main_inner, bg=COLORS["surface"], highlightthickness=1, highlightbackground=COLORS["border"])
        usage_panel.pack(fill="x", pady=(18, 0))
        usage_inner = tk.Frame(usage_panel, bg=COLORS["surface"], padx=18, pady=18)
        usage_inner.pack(fill="x")
        tk.Label(usage_inner, text="실시간 자원 사용량", fg=COLORS["text"], bg=COLORS["surface"], font=("Segoe UI", 15, "bold")).pack(anchor="w")
        tk.Label(usage_inner, text="현재 기여 앱이 확인한 CPU, RAM, GPU, 저장 공간 정보를 표시합니다.", fg=COLORS["muted"], bg=COLORS["surface"], font=("Segoe UI", 10)).pack(anchor="w", pady=(6, 14))
        for key in ["CPU 사용률", "RAM 사용률", "GPU", "남은 저장 공간"]:
            row = tk.Frame(usage_inner, bg=COLORS["surface"])
            row.pack(fill="x", pady=(0, 10))
            tk.Label(row, text=key, fg=COLORS["muted"], bg=COLORS["surface"], font=("Segoe UI", 10, "bold")).pack(anchor="w")
            label = tk.Label(row, text="-", fg=COLORS["text"], bg=COLORS["surface"], font=("Segoe UI", 11))
            label.pack(anchor="w", pady=(4, 0))
            self.status_vars[key] = label

        side_inner = tk.Frame(side, bg=COLORS["panel"], padx=20, pady=20)
        side_inner.pack(fill="both", expand=True)
        tk.Label(side_inner, text="기여 제어", fg=COLORS["text"], bg=COLORS["panel"], font=("Segoe UI", 17, "bold")).pack(anchor="w")
        tk.Label(side_inner, text="기여를 시작하면 예약된 범위 안에서만 CPU/GPU 상한을 지키며 동작합니다.", fg=COLORS["muted"], bg=COLORS["panel"], font=("Segoe UI", 10), justify="left", wraplength=250).pack(anchor="w", pady=(6, 14))
        toggle_wrap = tk.Frame(side_inner, bg=COLORS["panel"])
        toggle_wrap.pack(fill="x")
        ttk.Checkbutton(toggle_wrap, text="기여 진행", variable=self.contributing_var, command=self.toggle_contribution).pack(anchor="w")

        self.build_info_banner(side_inner, "연결 정보", "기기 ID, 사용자, 연동 코드를 확인합니다.")
        self.link_info = tk.Label(side_inner, text="-", fg=COLORS["text"], bg=COLORS["panel"], font=("Segoe UI", 10), justify="left", wraplength=250)
        self.link_info.pack(anchor="w", fill="x", pady=(0, 16))
        ttk.Button(side_inner, text="연동 코드 다시 입력", style="Soft.TButton", command=self.show_wizard).pack(fill="x")
        ttk.Button(side_inner, text="앱 닫기", style="Soft.TButton", command=self.on_close).pack(fill="x", pady=(10, 0))
        self.refresh_dashboard()
        self.schedule_refresh()

    def toggle_contribution(self):
        self.config["contributing"] = bool(self.contributing_var.get())
        save_config(self.config)
        self.refresh_dashboard()

    def refresh_dashboard(self):
        snapshot = get_hardware_snapshot()
        linked = self.config.get("linked")
        account = (self.config.get("last_linked_payload") or {}).get("account") or {}
        plan = account.get("plan") or "Basic"
        self.status_vars["연결 상태"].configure(text="연결됨" if linked else "미연동")
        self.status_vars["연결 상태 세부"].configure(text="계정과 기기가 연결되어 있습니다." if linked else "연동 코드가 필요합니다.")
        self.status_vars["플랜"].configure(text=plan)
        self.status_vars["플랜 세부"].configure(text="기여 시간 기준 유지 조건으로 관리됩니다.")
        self.status_vars["기여 상태"].configure(text="기여 중" if self.config.get("contributing") else "대기 중")
        self.status_vars["기여 상태 세부"].configure(text="실시간 heartbeat 전송 중" if self.config.get("contributing") else "지금은 기여를 멈춘 상태입니다.")
        self.status_vars["서버"].configure(text=self.config.get("server_base_url", DEFAULT_SERVER).replace("https://", ""))
        self.status_vars["서버 세부"].configure(text="공개 Purple Bee 서비스와 연동됩니다.")
        self.status_vars["CPU 사용률"].configure(text=f"현재 {snapshot['cpu_percent']}% · 논리 코어 {snapshot['cpu_threads']}개")
        self.status_vars["RAM 사용률"].configure(text=f"현재 {snapshot['ram_percent']}% · 총 {snapshot['memory_gb']}GB")
        self.status_vars["GPU"].configure(text=snapshot["gpu_name"])
        self.status_vars["남은 저장 공간"].configure(text=f"약 {snapshot['disk_free_gb']}GB")
        self.link_info.configure(
            text=f"기기 ID: {self.config.get('device_id')}\n연동 코드: {self.config.get('link_code') or '-'}\n사용자: {self.config.get('display_name') or self.config.get('user_id') or '-'}"
        )

    def send_heartbeat(self):
        if not self.config.get("linked") or not requests:
            return
        if time.time() - self.last_heartbeat < HEARTBEAT_SECONDS:
            return
        payload = {
            "user_id": self.config.get("user_id"),
            "device_id": self.config.get("device_id"),
            "status": "contributing" if self.config.get("contributing") else "idle",
            "hardware": get_hardware_snapshot(),
            "runtime": {"os": platform.platform(), "appVersion": APP_VERSION},
            "caps": {"cpuMaxPercent": self.config.get("cpu_cap", 70), "gpuMaxPercent": self.config.get("gpu_cap", 70)},
        }

        def work():
            try:
                requests.post(self.config.get("server_base_url", DEFAULT_SERVER).rstrip("/") + "/api/contributor/client/heartbeat", json=payload, timeout=12)
                self.last_heartbeat = time.time()
            except Exception:
                pass

        threading.Thread(target=work, daemon=True).start()

    def schedule_refresh(self):
        self.send_heartbeat()
        self.refresh_dashboard()
        self.after_job = self.root.after(POLL_SECONDS * 1000, self.schedule_refresh)

    def on_close(self):
        if self.after_job:
            try:
                self.root.after_cancel(self.after_job)
            except Exception:
                pass
        save_config(self.config)
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    save_config(load_config())
    ContributorApp().run()
