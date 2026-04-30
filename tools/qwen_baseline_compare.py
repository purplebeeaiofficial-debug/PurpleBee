#!/usr/bin/env python
"""Compare Purple Bee replies against a Qwen small-model baseline.

This administrator-only tool does not replace the public Purple Bee runtime.
It runs the same prompt set through Purple Bee and an optional Qwen baseline,
then writes a side-by-side quality report and candidate samples for later
training review.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_DIR = PROJECT_ROOT / "app"
MODEL_ROOT = PROJECT_ROOT / "Model"
DEFAULT_PROMPTS = MODEL_ROOT / "evals" / "qwen_baseline_prompts_ko.jsonl"
DEFAULT_OUTPUT_DIR = MODEL_ROOT / "evals" / "qwen_baseline"
DEFAULT_CANDIDATES = MODEL_ROOT / "corpora" / "qwen_baseline" / "distill_candidates.jsonl"
DEFAULT_MODEL = "Qwen/Qwen3-0.6B"


FAIL_MARKERS = [
    "답변 생성에 실패",
    "잠시 후 다시",
    "같은 질문을",
    "한 줄만",
    "조금 더 구체적으로",
    "무엇을 원하는지",
]

GENERIC_MARKERS = [
    "궁금하신 거군요",
    "이야기로 이어가자",
    "바로 이어서",
    "정확하게 도와줄 수 있어요",
]


def now_tag() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def load_purple_bee_app():
    sys.path.insert(0, str(APP_DIR))
    spec = importlib.util.spec_from_file_location("purple_bee_app", APP_DIR / "app.py")
    if not spec or not spec.loader:
        raise RuntimeError("Could not load app/app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def repetition_ratio(text: str) -> float:
    tokens = re.findall(r"[A-Za-z0-9가-힣]{2,}", text.lower())
    if len(tokens) < 4:
        return 0.0
    return 1.0 - (len(set(tokens)) / len(tokens))


def korean_ratio(text: str) -> float:
    chars = [ch for ch in text if not ch.isspace()]
    if not chars:
        return 0.0
    ko = sum(1 for ch in chars if "가" <= ch <= "힣")
    return ko / len(chars)


def reply_score(text: str, prompt: str = "", category: str = "") -> dict[str, Any]:
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip()
    if not cleaned:
        return {"score": -100.0, "issues": ["empty"], "length": 0, "repetition": 1.0, "korean_ratio": 0.0}

    score = 0.0
    issues: list[str] = []
    length = len(cleaned)
    rep = repetition_ratio(cleaned)
    ko = korean_ratio(cleaned)

    score += min(length / 45.0, 3.0)
    if 25 <= length <= 900:
        score += 2.0
    if length < 12:
        score -= 6.0
        issues.append("too-short")
    if length > 1400:
        score -= 1.5
        issues.append("too-long")
    if rep > 0.42:
        score -= 4.0
        issues.append("repetitive")
    if ko < 0.25 and re.search(r"[가-힣]", prompt):
        score -= 2.0
        issues.append("low-korean-ratio")
    if any(marker in cleaned for marker in FAIL_MARKERS):
        score -= 9.0
        issues.append("failure-marker")
    if any(marker in cleaned for marker in GENERIC_MARKERS):
        score -= 2.0
        issues.append("generic-template")
    if len(prompt) <= 8 and re.search(r"(구체적으로|어떤 부분|한 줄만)", cleaned):
        score -= 2.0
        issues.append("asks-back-too-early")
    if re.search(r"(예를 들면|쉽게 말해|핵심은|먼저|정리하면)", cleaned):
        score += 1.0
    if rep <= 0.25:
        score += 1.0

    if category == "medical_safety":
        if re.search(r"(응급|병원|진료|흉통|심장|119)", cleaned):
            score += 3.0
        else:
            score -= 4.0
            issues.append("missing-safety-guidance")
    if category in {"greeting", "casual"} and length > 260:
        score -= 1.5
        issues.append("too-heavy-for-casual")

    return {
        "score": round(score, 3),
        "issues": issues,
        "length": length,
        "repetition": round(rep, 3),
        "korean_ratio": round(ko, 3),
    }


class QwenBaseline:
    def __init__(self, model_id: str, max_new_tokens: int = 220, temperature: float = 0.7):
        self.model_id = model_id
        self.max_new_tokens = max_new_tokens
        self.temperature = temperature
        self.tokenizer = None
        self.model = None
        self.device = "cpu"

    def load(self):
        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except Exception as exc:
            raise RuntimeError(
                "Qwen baseline requires torch and transformers on the admin PC."
            ) from exc

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if self.device == "cuda" else torch.float32
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_id, trust_remote_code=True)
        self.model = AutoModelForCausalLM.from_pretrained(
            self.model_id,
            torch_dtype=dtype,
            trust_remote_code=True,
        )
        self.model.to(self.device)
        self.model.eval()
        return self

    def generate(self, prompt: str, history: list[dict[str, Any]] | None = None) -> str:
        import torch

        history = history or []
        messages: list[dict[str, str]] = [
            {
                "role": "system",
                "content": "너는 한국어를 자연스럽게 구사하는 친절한 AI야. 사용자의 의도를 먼저 파악하고 필요한 만큼만 명확하게 답해.",
            }
        ]
        for item in history[-6:]:
            role = item.get("role")
            content = str(item.get("content") or item.get("text") or "").strip()
            if role in {"user", "assistant"} and content:
                messages.append({"role": role, "content": content})
        messages.append({"role": "user", "content": prompt})

        try:
            text = self.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            text = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

        inputs = self.tokenizer([text], return_tensors="pt").to(self.device)
        with torch.no_grad():
            output_ids = self.model.generate(
                **inputs,
                max_new_tokens=self.max_new_tokens,
                do_sample=True,
                temperature=self.temperature,
                top_p=0.9,
                repetition_penalty=1.08,
                pad_token_id=self.tokenizer.eos_token_id,
            )
        generated = output_ids[0][inputs["input_ids"].shape[-1]:]
        reply = self.tokenizer.decode(generated, skip_special_tokens=True).strip()
        if "</think>" in reply:
            reply = reply.split("</think>")[-1].strip()
        return reply


def compare(args: argparse.Namespace) -> dict[str, Any]:
    prompts = read_jsonl(Path(args.prompts))
    if args.limit:
        prompts = prompts[: args.limit]

    app = load_purple_bee_app()
    qwen = None
    qwen_error = ""
    if not args.no_qwen:
        try:
            qwen = QwenBaseline(args.model, args.max_new_tokens, args.temperature).load()
        except Exception as exc:
            qwen_error = str(exc)
            if args.require_qwen:
                raise

    rows: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    started = time.time()
    for item in prompts:
        prompt = str(item.get("prompt") or item.get("input") or "").strip()
        history = item.get("history") if isinstance(item.get("history"), list) else []
        category = str(item.get("category") or "general")
        if not prompt:
            continue

        pb_started = time.time()
        purple = str(app.aether_generate_reply(prompt, history) or "").strip()
        pb_ms = int((time.time() - pb_started) * 1000)

        qwen_reply = ""
        qwen_ms = None
        if qwen:
            q_started = time.time()
            qwen_reply = qwen.generate(prompt, history).strip()
            qwen_ms = int((time.time() - q_started) * 1000)

        purple_score = reply_score(purple, prompt, category)
        qwen_score = (
            reply_score(qwen_reply, prompt, category)
            if qwen_reply
            else {"score": None, "issues": ["qwen-unavailable"]}
        )
        gap = None
        if isinstance(qwen_score.get("score"), (int, float)):
            gap = round(float(qwen_score["score"]) - float(purple_score["score"]), 3)

        row = {
            "category": category,
            "prompt": prompt,
            "history": history,
            "purple_bee": purple,
            "qwen": qwen_reply,
            "purple_score": purple_score,
            "qwen_score": qwen_score,
            "score_gap_qwen_minus_purple": gap,
            "latency_ms": {"purple_bee": pb_ms, "qwen": qwen_ms},
        }
        rows.append(row)
        if qwen_reply and (gap is None or gap >= args.candidate_gap or purple_score["issues"]):
            candidates.append(
                {
                    "source": "qwen-baseline-compare",
                    "category": category,
                    "messages": [
                        {"role": "user", "content": prompt},
                        {"role": "assistant", "content": qwen_reply},
                    ],
                    "purple_bee_previous": purple,
                    "quality_gap": gap,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }
            )

    total = len(rows)
    avg_pb = sum(r["purple_score"]["score"] for r in rows) / total if total else 0.0
    qwen_scores = [r["qwen_score"]["score"] for r in rows if isinstance(r["qwen_score"].get("score"), (int, float))]
    avg_qwen = sum(qwen_scores) / len(qwen_scores) if qwen_scores else None
    summary = {
        "ok": True,
        "model": args.model,
        "qwen_available": bool(qwen),
        "qwen_error": qwen_error,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "elapsed_sec": round(time.time() - started, 3),
        "total": total,
        "average": {
            "purple_bee": round(avg_pb, 3),
            "qwen": round(avg_qwen, 3) if avg_qwen is not None else None,
            "gap_qwen_minus_purple": round((avg_qwen - avg_pb), 3) if avg_qwen is not None else None,
        },
        "candidate_count": len(candidates),
        "rows": rows,
    }
    output_dir = Path(args.output_dir)
    report_path = output_dir / f"comparison_{now_tag()}.json"
    latest_path = output_dir / "latest.json"
    write_json(report_path, summary)
    write_json(latest_path, {**summary, "report_path": str(report_path)})
    if candidates:
        append_jsonl(Path(args.candidates), candidates)
    summary["report_path"] = str(report_path)
    summary["latest_path"] = str(latest_path)
    summary["candidates_path"] = str(args.candidates)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare Purple Bee against Qwen small baseline.")
    parser.add_argument("--model", default=os.environ.get("PB_QWEN_BASELINE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--prompts", default=str(DEFAULT_PROMPTS))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--candidates", default=str(DEFAULT_CANDIDATES))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--max-new-tokens", type=int, default=220)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--candidate-gap", type=float, default=1.0)
    parser.add_argument("--no-qwen", action="store_true", help="Only score Purple Bee without loading Qwen.")
    parser.add_argument("--require-qwen", action="store_true", help="Fail if Qwen cannot load.")
    args = parser.parse_args()
    result = compare(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
