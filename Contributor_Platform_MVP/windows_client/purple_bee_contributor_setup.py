import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
import tkinter as tk
from tkinter import ttk, messagebox


APP_NAME = "Purple Bee Contributor Setup"
INSTALL_ROOT = Path(os.getenv("LOCALAPPDATA", Path.home())) / "PurpleBeeContributor"
APP_EXE_NAME = "PurpleBeeContributor.exe"

COLORS = {
    "bg": "#0d0b15",
    "panel": "#161226",
    "surface": "#211b35",
    "border": "#3a3158",
    "text": "#f5f1ff",
    "muted": "#bdb4df",
    "accent": "#8b5cf6",
    "accent2": "#d946ef",
}

LEGAL_NOTICE = """Purple Bee Contributor 설치 안내

이 설치 프로그램은 Purple Bee Contributor를 사용자 PC에 복사하고,
웹사이트에서 발급한 연동 코드로 계정을 연결할 수 있게 준비합니다.

- 설치 후에는 웹사이트에서 받은 연동 코드를 앱에 입력해야 연결이 완료됩니다.
- 기여 시간 동안 CPU, GPU, RAM, 네트워크 일부가 사용될 수 있습니다.
- 사용자가 직접 작업을 시작하거나 안전 조건을 벗어나면 기여 작업은 자동 일시정지될 수 있습니다.
- Purple Bee는 설치 또는 실행 중 발생할 수 있는 발열, 성능 저하, 네트워크 사용량 증가에 대해 직접적인 책임을 지지 않습니다.
- 중요한 작업 중에는 기여를 일시중지하거나 예약 시간을 조정하는 것을 권장합니다.
"""


def bundle_root():
    if getattr(sys, "_MEIPASS", None):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def payload_exe_path():
    return bundle_root() / "payload" / APP_EXE_NAME


def create_shortcut(shortcut_path: Path, target_path: Path):
    ps_script = f"""
$WScriptShell = New-Object -ComObject WScript.Shell
$Shortcut = $WScriptShell.CreateShortcut('{str(shortcut_path)}')
$Shortcut.TargetPath = '{str(target_path)}'
$Shortcut.WorkingDirectory = '{str(target_path.parent)}'
$Shortcut.IconLocation = '{str(target_path)},0'
$Shortcut.Save()
"""
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
        check=False,
        capture_output=True,
        text=True,
    )


class SetupApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.geometry("880x640")
        self.root.minsize(780, 580)
        self.root.configure(bg=COLORS["bg"])
        self.accept_var = tk.BooleanVar(value=False)
        self.launch_var = tk.BooleanVar(value=True)
        self.shortcut_var = tk.BooleanVar(value=True)
        self.install_path_var = tk.StringVar(value=str(INSTALL_ROOT))
        self.progress_var = tk.DoubleVar(value=0)
        self.status_var = tk.StringVar(value="설치 준비 중")
        self._configure_style()
        self._build_shell()
        self.show_welcome()

    def _configure_style(self):
        self.style = ttk.Style()
        try:
            self.style.theme_use("clam")
        except Exception:
            pass
        self.style.configure(
            "Accent.TButton",
            padding=10,
            font=("Segoe UI", 11, "bold"),
            foreground="white",
            background=COLORS["accent"],
        )
        self.style.map("Accent.TButton", background=[("active", COLORS["accent2"])])
        self.style.configure(
            "Soft.TButton",
            padding=10,
            font=("Segoe UI", 10),
            foreground=COLORS["text"],
            background=COLORS["surface"],
        )

    def _build_shell(self):
        outer = tk.Frame(self.root, bg=COLORS["bg"], padx=22, pady=22)
        outer.pack(fill="both", expand=True)
        self.panel = tk.Frame(outer, bg=COLORS["panel"], highlightbackground=COLORS["border"], highlightthickness=1)
        self.panel.pack(fill="both", expand=True)

        head = tk.Frame(self.panel, bg=COLORS["panel"], padx=24, pady=20)
        head.pack(fill="x")
        logo = tk.Canvas(head, width=52, height=52, bg=COLORS["panel"], highlightthickness=0)
        logo.pack(side="left")
        logo.create_oval(4, 4, 48, 48, fill="#b139d8", outline="")
        logo.create_oval(15, 18, 37, 40, fill="#f5d76e", outline="")
        logo.create_rectangle(20, 23, 32, 27, fill="#5323a8", outline="")
        logo.create_rectangle(20, 30, 32, 34, fill="#5323a8", outline="")
        logo.create_oval(15, 12, 25, 20, fill="#d5ddff", outline="")
        logo.create_oval(27, 12, 37, 20, fill="#d5ddff", outline="")
        title_box = tk.Frame(head, bg=COLORS["panel"])
        title_box.pack(side="left", padx=14)
        tk.Label(title_box, text="Purple Bee Contributor", bg=COLORS["panel"], fg=COLORS["text"], font=("Segoe UI", 20, "bold")).pack(anchor="w")
        tk.Label(title_box, text="설치 마법사 · 설치 후 바로 실행할 수 있어요.", bg=COLORS["panel"], fg=COLORS["muted"], font=("Segoe UI", 10)).pack(anchor="w", pady=(4, 0))
        self.body = tk.Frame(self.panel, bg=COLORS["panel"], padx=24, pady=8)
        self.body.pack(fill="both", expand=True)

    def _clear_body(self):
        for child in self.body.winfo_children():
            child.destroy()

    def _stepper(self, step):
        steps = ["약관 확인", "설치 위치", "설치 진행", "완료"]
        row = tk.Frame(self.body, bg=COLORS["panel"])
        row.pack(fill="x", pady=(0, 18))
        for idx, label in enumerate(steps):
            box = tk.Frame(row, bg=COLORS["surface"], highlightbackground=COLORS["border"], highlightthickness=1)
            box.pack(side="left", fill="x", expand=True, padx=(0 if idx == 0 else 8, 0))
            inner = tk.Frame(box, bg=COLORS["surface"], padx=12, pady=12)
            inner.pack(fill="x")
            chip_bg = COLORS["accent"] if idx <= step else COLORS["border"]
            tk.Label(inner, text=str(idx + 1), bg=chip_bg, fg="white", width=2, font=("Segoe UI", 9, "bold")).pack(anchor="w")
            tk.Label(inner, text=label, bg=COLORS["surface"], fg=COLORS["text"], font=("Segoe UI", 11, "bold")).pack(anchor="w", pady=(8, 0))

    def show_welcome(self):
        self._clear_body()
        self._stepper(0)
        tk.Label(self.body, text="설치 전에 꼭 확인해 주세요", bg=COLORS["panel"], fg=COLORS["text"], font=("Segoe UI", 24, "bold")).pack(anchor="w")
        tk.Label(self.body, text="기여 앱을 설치한 뒤 웹사이트에서 받은 연동 코드로 계정을 연결하게 됩니다.", bg=COLORS["panel"], fg=COLORS["muted"], font=("Segoe UI", 11)).pack(anchor="w", pady=(8, 16))
        legal = tk.Text(self.body, height=14, wrap="word", bg=COLORS["surface"], fg=COLORS["text"], relief="flat", padx=14, pady=14)
        legal.insert("1.0", LEGAL_NOTICE)
        legal.configure(state="disabled")
        legal.pack(fill="both", expand=True)
        tk.Checkbutton(
            self.body,
            text="위 안내를 읽었고 설치를 계속 진행하는 데 동의합니다.",
            variable=self.accept_var,
            bg=COLORS["panel"],
            fg=COLORS["text"],
            activebackground=COLORS["panel"],
            activeforeground=COLORS["text"],
            selectcolor=COLORS["surface"],
            font=("Segoe UI", 10),
        ).pack(anchor="w", pady=(16, 18))
        ttk.Button(self.body, text="다음", style="Accent.TButton", command=self.show_location).pack(anchor="e")

    def show_location(self):
        if not self.accept_var.get():
            messagebox.showwarning("동의 필요", "설치를 계속하려면 안내 문구를 먼저 확인하고 동의해 주세요.")
            return
        self._clear_body()
        self._stepper(1)
        tk.Label(self.body, text="설치 위치를 확인해 주세요", bg=COLORS["panel"], fg=COLORS["text"], font=("Segoe UI", 24, "bold")).pack(anchor="w")
        tk.Label(self.body, text="기본 설치 위치는 LocalAppData 아래 PurpleBeeContributor 폴더입니다.", bg=COLORS["panel"], fg=COLORS["muted"], font=("Segoe UI", 11)).pack(anchor="w", pady=(8, 18))
        tk.Entry(self.body, textvariable=self.install_path_var, bg=COLORS["surface"], fg=COLORS["text"], relief="flat", font=("Segoe UI", 11)).pack(fill="x", ipady=11)
        tk.Checkbutton(self.body, text="바탕화면 바로가기 만들기", variable=self.shortcut_var, bg=COLORS["panel"], fg=COLORS["text"], selectcolor=COLORS["surface"], activebackground=COLORS["panel"], activeforeground=COLORS["text"]).pack(anchor="w", pady=(16, 8))
        tk.Checkbutton(self.body, text="설치 완료 후 바로 Purple Bee Contributor 실행", variable=self.launch_var, bg=COLORS["panel"], fg=COLORS["text"], selectcolor=COLORS["surface"], activebackground=COLORS["panel"], activeforeground=COLORS["text"]).pack(anchor="w")
        actions = tk.Frame(self.body, bg=COLORS["panel"])
        actions.pack(fill="x", pady=(22, 0))
        ttk.Button(actions, text="이전", style="Soft.TButton", command=self.show_welcome).pack(side="left")
        ttk.Button(actions, text="설치 시작", style="Accent.TButton", command=self.start_install).pack(side="right")

    def start_install(self):
        src = payload_exe_path()
        if not src.exists():
            messagebox.showerror("설치 오류", "기여 앱 본체 파일을 찾지 못했습니다. 설치 파일을 다시 받아 주세요.")
            return
        self._clear_body()
        self._stepper(2)
        tk.Label(self.body, text="설치 중입니다", bg=COLORS["panel"], fg=COLORS["text"], font=("Segoe UI", 24, "bold")).pack(anchor="w")
        tk.Label(self.body, text="기여 앱을 복사하고 바로가기와 실행 환경을 준비하고 있습니다. 잠시만 기다려 주세요.", bg=COLORS["panel"], fg=COLORS["muted"], font=("Segoe UI", 11)).pack(anchor="w", pady=(8, 18))
        ttk.Progressbar(self.body, maximum=100, variable=self.progress_var).pack(fill="x", pady=(0, 12))
        tk.Label(self.body, textvariable=self.status_var, bg=COLORS["panel"], fg=COLORS["muted"], font=("Segoe UI", 10)).pack(anchor="w")
        threading.Thread(target=self._do_install, daemon=True).start()

    def _do_install(self):
        try:
            install_dir = Path(self.install_path_var.get().strip() or INSTALL_ROOT)
            install_dir.mkdir(parents=True, exist_ok=True)
            target = install_dir / APP_EXE_NAME
            src = payload_exe_path()
            total = max(src.stat().st_size, 1)
            copied = 0
            self._update_progress(5, "설치 폴더를 준비하고 있습니다...")
            with open(src, "rb") as rf, open(target, "wb") as wf:
                while True:
                    chunk = rf.read(1024 * 512)
                    if not chunk:
                        break
                    wf.write(chunk)
                    copied += len(chunk)
                    percent = 10 + (copied / total) * 70
                    self._update_progress(percent, f"기여 앱을 복사하는 중... {copied / 1024 / 1024:.1f}MB / {total / 1024 / 1024:.1f}MB")
            self._update_progress(86, "바탕화면 바로가기를 준비하고 있습니다...")
            if self.shortcut_var.get():
                create_shortcut(Path.home() / "Desktop" / "Purple Bee Contributor.lnk", target)
            self._update_progress(94, "마무리 설정을 적용하고 있습니다...")
            self._update_progress(100, "설치가 완료되었습니다.")
            self.root.after(250, lambda: self.show_complete(target))
        except Exception as exc:
            self.root.after(0, lambda: messagebox.showerror("설치 실패", f"설치 중 문제가 발생했습니다.\n\n{exc}"))
            self.root.after(0, self.show_location)

    def _update_progress(self, percent, message):
        self.root.after(0, lambda: self.progress_var.set(round(percent, 1)))
        self.root.after(0, lambda: self.status_var.set(message))

    def show_complete(self, target: Path):
        self._clear_body()
        self._stepper(3)
        tk.Label(self.body, text="설치가 완료되었습니다", bg=COLORS["panel"], fg=COLORS["text"], font=("Segoe UI", 24, "bold")).pack(anchor="w")
        tk.Label(self.body, text="이제 Purple Bee Contributor를 열고, 웹사이트에서 받은 연동 코드를 붙여넣으면 됩니다.", bg=COLORS["panel"], fg=COLORS["muted"], font=("Segoe UI", 11), wraplength=760, justify="left").pack(anchor="w", pady=(8, 18))
        summary = tk.Frame(self.body, bg=COLORS["surface"], highlightbackground=COLORS["border"], highlightthickness=1, padx=16, pady=16)
        summary.pack(fill="x")
        tk.Label(summary, text="설치 위치", bg=COLORS["surface"], fg=COLORS["muted"], font=("Segoe UI", 10, "bold")).pack(anchor="w")
        tk.Label(summary, text=str(target), bg=COLORS["surface"], fg=COLORS["text"], font=("Segoe UI", 10), wraplength=760, justify="left").pack(anchor="w", pady=(4, 10))
        tk.Label(summary, text="다음 단계", bg=COLORS["surface"], fg=COLORS["muted"], font=("Segoe UI", 10, "bold")).pack(anchor="w")
        tk.Label(summary, text="1) 앱 실행 → 2) 연동 코드 입력 → 3) 웹사이트에서 연동 확인", bg=COLORS["surface"], fg=COLORS["text"], font=("Segoe UI", 10), wraplength=760, justify="left").pack(anchor="w", pady=(4, 0))
        actions = tk.Frame(self.body, bg=COLORS["panel"])
        actions.pack(fill="x", pady=(22, 0))
        ttk.Button(actions, text="마침", style="Soft.TButton", command=self.root.destroy).pack(side="left")
        ttk.Button(actions, text="앱 실행", style="Accent.TButton", command=lambda: self.finish_and_launch(target)).pack(side="right")
        if self.launch_var.get():
            self.root.after(500, lambda: self.finish_and_launch(target))

    def finish_and_launch(self, target: Path):
        try:
            subprocess.Popen([str(target)], shell=False)
        except Exception:
            pass
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    SetupApp().run()
