import argparse
import json
import random
import shutil
import subprocess
import sys
import time
import math
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from purple_bee_100m import (  # noqa: E402
    backend_summary,
    build_model,
    count_torch_parameters,
    estimate_parameter_count,
    load_checkpoint,
    load_blueprint,
    torch,
)
from purple_bee_tokenizer import (  # noqa: E402
    build_tokenizer,
    build_tokenizer_report,
    encode_text,
    load_tokenizer,
    save_tokenizer,
)

PROJECT_ROOT = SCRIPT_DIR.parents[1]
MODEL_ROOT = SCRIPT_DIR.parent
DEFAULT_SFT_DATASET = MODEL_ROOT / "corpora" / "dialogue_sft" / "purple_bee_sft_dataset_clean.jsonl"
CATEGORY_TAG_ALIASES = {
    "인사": {"greeting", "smalltalk"},
    "자기소개": {"self-intro", "identity"},
    "정의 설명": {"definition", "knowledge"},
    "짧은 질문 직답": {"direct-answer", "short"},
    "능력 설명": {"ability", "coding", "language"},
    "후속 질문 생성": {"followup", "repair", "style", "preference"},
}

CATEGORY_TAG_ALIASES = {
    "greeting": {"greeting", "smalltalk"},
    "identity": {"self-intro", "identity"},
    "definition": {"definition", "knowledge"},
    "direct-answer": {"direct-answer", "short"},
    "ability": {"ability", "coding", "language"},
    "followup": {"followup", "repair", "style", "preference", "conversation", "empathy"},
}

BASE_CHAT_PROMPT_LINES = [
    "Instruction: You are Purple Bee.",
    "Instruction: Reply naturally and directly in the same language as the user.",
    "Instruction: Avoid menus, repeated phrases, role labels, system markers, and broken text.",
]


def build_chat_prompt_prefix(user_text: str, instruction_text: str = "") -> str:
    blocks = list(BASE_CHAT_PROMPT_LINES)
    if instruction_text:
        blocks.append(f"Instruction: {instruction_text}")
    blocks.append(f"User: {str(user_text or '').strip()}")
    blocks.append("Assistant:")
    return "\n".join(blocks)

def write_status(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_corpus(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def read_jsonl(path: Path):
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def derive_reward_profile(eval_payload: dict | None) -> dict:
    profile = {"category_boosts": {}, "tag_boosts": {}}
    if not isinstance(eval_payload, dict):
        return profile
    by_category = eval_payload.get("by_category") or {}
    for category, stats in by_category.items():
        try:
            total = int(stats.get("total") or 0)
            passed = int(stats.get("passed") or 0)
        except Exception:
            continue
        if total <= 0:
            continue
        failure_ratio = max(0.0, min(1.0, 1.0 - (passed / total)))
        boost = round(1.0 + (failure_ratio * 1.5), 3)
        profile["category_boosts"][str(category)] = boost
        for tag in CATEGORY_TAG_ALIASES.get(str(category), set()):
            profile["tag_boosts"][tag] = max(profile["tag_boosts"].get(tag, 1.0), boost)
    return profile


def load_reward_profile(eval_output_path: Path | None) -> dict:
    if not eval_output_path or not Path(eval_output_path).exists():
        return {"category_boosts": {}, "tag_boosts": {}}
    try:
        payload = json.loads(Path(eval_output_path).read_text(encoding="utf-8"))
    except Exception:
        return {"category_boosts": {}, "tag_boosts": {}}
    return derive_reward_profile(payload)


def reward_weight_for_example(example: dict, reward_profile: dict | None = None) -> int:
    explicit_weight = example.get("reward_weight")
    try:
        explicit_weight = int(explicit_weight) if explicit_weight is not None else None
    except Exception:
        explicit_weight = None
    tags = {str(tag).lower() for tag in (example.get("tags") or [])}
    source_file = str(example.get("source_file") or "").lower()
    prompt = str(example.get("input") or "").strip()
    response = str(example.get("response") or "").strip()

    weight = 1
    if "regression_anchor" in source_file:
        weight += 8
    if "foundation_chat" in source_file:
        weight += 4
    if "conversation_natural" in source_file or "everyday_chat" in source_file:
        weight += 4
    if "instruction_social" in source_file:
        weight += 3
    if "instruction_seed" in source_file:
        weight += 4
    if "curriculum_chat" in source_file:
        weight += 2
    if "curriculum_knowledge" in source_file:
        weight += 2
    if "basic_dialogue_variants" in source_file:
        weight += 2

    if {"greeting", "self-intro", "identity", "definition", "direct-answer", "ability", "followup"} & tags:
        weight += 3
    if {"natural", "smalltalk", "repair", "style", "casual", "direct", "clarification"} & tags:
        weight += 2
    if {"multilingual", "same-language", "followup"} & tags:
        weight += 1
    if {"coding", "language", "knowledge"} & tags:
        weight += 1

    if 3 <= len(prompt) <= 40:
        weight += 1
    if 12 <= len(response) <= 180:
        weight += 1
    if "Assistant:" in response or "User:" in response:
        weight = max(1, weight - 3)
    if explicit_weight is not None:
        weight = max(weight, explicit_weight)
    reward_profile = reward_profile or {}
    tag_boosts = reward_profile.get("tag_boosts") or {}
    boost = 1.0
    for tag in tags:
        boost = max(boost, float(tag_boosts.get(tag, 1.0)))
    weight = int(round(weight * boost))
    return max(1, min(weight, 64))


def build_sft_examples(tokenizer, dataset_path: Path, seq_len: int, reward_profile: dict | None = None):
    rows = read_jsonl(dataset_path)
    examples = []
    total_weight = 0
    for row in rows:
        prompt_text = str(row.get("input") or "").strip()
        response_text = str(row.get("response") or row.get("output") or "").strip()
        if not prompt_text or not response_text:
            continue

        instruction_text = str(row.get("instruction") or "").strip()
        prompt_prefix = build_chat_prompt_prefix(prompt_text, instruction_text=instruction_text)
        prompt_ids = encode_text(prompt_prefix, tokenizer, add_bos=True, add_eos=False)
        response_ids = encode_text(f" {response_text}", tokenizer, add_bos=False, add_eos=True)
        full_sequence = prompt_ids + response_ids
        if len(full_sequence) < 2:
            continue
        # Causal LM training must predict the next token, not the current token.
        # Keep prompt tokens as context only, then supervise only the response span.
        input_ids = full_sequence[:-1]
        labels = ([-100] * max(0, len(prompt_ids) - 1)) + response_ids
        if len(input_ids) > seq_len:
            input_ids = input_ids[-seq_len:]
            labels = labels[-seq_len:]
        if not any(label != -100 for label in labels):
            continue
        weight = reward_weight_for_example(row, reward_profile=reward_profile)
        total_weight += weight
        examples.append({
            "input_ids": input_ids,
            "labels": labels,
            "weight": weight,
            "source_file": row.get("source_file"),
            "tags": row.get("tags", []),
        })
    return examples, {
        "rows": len(rows),
        "usable_examples": len(examples),
        "total_weight": total_weight,
        "dataset_path": str(dataset_path),
    }


def build_tokenizer_training_text(corpus_text: str, sft_rows: list[dict]) -> str:
    parts = [corpus_text]
    for row in sft_rows:
        prompt_text = str(row.get("input") or "").strip()
        response_text = str(row.get("response") or row.get("output") or "").strip()
        if not prompt_text or not response_text:
            continue
        instruction = str(row.get("instruction") or "").strip()
        thinking = str(row.get("thinking") or "").strip()
        block = [build_chat_prompt_prefix(prompt_text, instruction_text=instruction)]
        if thinking:
            block.append(f"Thinking: {thinking}")
        block.append(response_text)
        parts.append("\n".join(block))
    return "\n\n".join(part for part in parts if str(part).strip())


def build_language_model_corpus(corpus_text: str, sft_rows: list[dict]) -> str:
    parts = [corpus_text]
    for row in sft_rows:
        prompt_text = str(row.get("input") or "").strip()
        response_text = str(row.get("response") or row.get("output") or "").strip()
        if not prompt_text or not response_text:
            continue
        instruction = str(row.get("instruction") or "").strip()
        thinking = str(row.get("thinking") or "").strip()
        block = [build_chat_prompt_prefix(prompt_text, instruction_text=instruction)]
        if thinking:
            block.append(f"Thinking: {thinking}")
        block.append(response_text)
        parts.append("\n".join(block))
    return "\n\n".join(part for part in parts if str(part).strip())


def build_foundation_warmup_corpus(corpus_text: str, sft_rows: list[dict]) -> str:
    parts = [corpus_text]
    for row in sft_rows:
        instruction = str(row.get("instruction") or "").strip()
        prompt_text = str(row.get("input") or "").strip()
        response_text = str(row.get("response") or row.get("output") or "").strip()
        if prompt_text and response_text:
            parts.append(f"{build_chat_prompt_prefix(prompt_text, instruction_text=instruction)} {response_text}")
    return "\n\n".join(part for part in parts if str(part).strip())


def load_resume_tokenizer(resume_checkpoint_path: Path | None):
    if not resume_checkpoint_path or not resume_checkpoint_path.exists() or torch is None:
        return None
    try:
        checkpoint = torch.load(str(resume_checkpoint_path), map_location="cpu")
    except Exception:
        return None
    tokenizer = checkpoint.get("tokenizer")
    if not isinstance(tokenizer, dict):
        return None
    return tokenizer


def read_json(path: Path | None):
    if not path or not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def should_discard_resume_checkpoint(resume_checkpoint_path: Path | None) -> bool:
    if not resume_checkpoint_path or not resume_checkpoint_path.exists():
        return False
    training_dir = resume_checkpoint_path.parent.parent
    summary = read_json(training_dir / "training_summary.json")
    status = read_json(training_dir / "pipeline_status.json")
    latest_eval = summary.get("latest_evaluation") or status.get("latest_evaluation") or {}
    best_reward = summary.get("best_reward_score")
    if best_reward is None:
        best_reward = status.get("best_reward_score")

    try:
        if best_reward is not None and float(best_reward) <= 0:
            return True
    except Exception:
        pass

    try:
        total = int(latest_eval.get("total") or 0)
        passed = int(latest_eval.get("passed") or 0)
        if total > 0 and passed <= 0:
            return True
    except Exception:
        pass
    return False


def parse_eval_steps(raw_value, train_steps: int) -> list[int]:
    if not raw_value:
        return []
    if isinstance(raw_value, (list, tuple)):
        candidates = raw_value
    else:
        candidates = str(raw_value).replace(";", ",").split(",")
    parsed = []
    for item in candidates:
        try:
            step = int(str(item).strip())
        except Exception:
            continue
        if step > 0 and step <= train_steps:
            parsed.append(step)
    return sorted(set(parsed))


def save_checkpoint(checkpoint_path: Path, model, blueprint, tokenizer, step: int, losses: list[float]):
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "state_dict": model.state_dict(),
        "config": blueprint,
        "tokenizer": tokenizer,
        "step": step,
        "loss_history": losses[-200:],
    }
    last_error = None
    for attempt in range(1, 6):
        try:
            temp_path = checkpoint_path.with_suffix(f".attempt{attempt}.tmp")
            if temp_path.exists():
                temp_path.unlink()
            torch.save(payload, str(temp_path))
            temp_path.replace(checkpoint_path)
            return
        except Exception as exc:
            last_error = exc
            time.sleep(1.0 * attempt)
    raise RuntimeError(f"checkpoint save failed after retries: {last_error}")


def run_checkpoint_evaluation(
    checkpoint_path: Path,
    tokenizer_path: Path,
    eval_file: Path,
    output_path: Path,
    device: str,
    max_new_tokens: int,
    temperature: float,
    top_k: int,
    top_p: float,
    repetition_penalty: float,
):
    command = [
        sys.executable,
        str(SCRIPT_DIR / "run_public_chat_eval.py"),
        "--checkpoint", str(checkpoint_path),
        "--tokenizer", str(tokenizer_path),
        "--eval-file", str(eval_file),
        "--output", str(output_path),
        "--device", device,
        "--max-new-tokens", str(int(max_new_tokens)),
        "--temperature", str(float(temperature)),
        "--top-k", str(int(top_k)),
        "--top-p", str(float(top_p)),
        "--repetition-penalty", str(float(repetition_penalty)),
    ]
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
        raise RuntimeError((completed.stdout or "checkpoint evaluation failed")[-1200:])
    return json.loads(output_path.read_text(encoding="utf-8"))


def sample_batch(tokens, batch_size, seq_len, device):
    if len(tokens) <= seq_len + 1:
        tokens = tokens + tokens
    starts = [random.randint(0, len(tokens) - seq_len - 2) for _ in range(batch_size)]
    rows = []
    for start in starts:
        rows.append(tokens[start:start + seq_len + 1])
    batch = torch.tensor(rows, dtype=torch.long, device=device)
    return batch[:, :-1], batch[:, 1:]


def sample_supervised_batch(examples, batch_size, seq_len, device, pad_id):
    weights = [max(1, int(example.get("weight", 1))) for example in examples]
    batch_input = []
    batch_labels = []
    for example in random.choices(examples, weights=weights, k=batch_size):
        input_ids = list(example["input_ids"])[:seq_len]
        labels = list(example["labels"])[:seq_len]
        pad_amount = max(0, seq_len - len(input_ids))
        if pad_amount:
            input_ids = input_ids + ([pad_id] * pad_amount)
            labels = labels + ([-100] * pad_amount)
        batch_input.append(input_ids)
        batch_labels.append(labels)
    return (
        torch.tensor(batch_input, dtype=torch.long, device=device),
        torch.tensor(batch_labels, dtype=torch.long, device=device),
    )


def compute_reward_score(evaluation_payload: dict) -> float:
    total = max(1, int(evaluation_payload.get("total") or 0))
    passed = int(evaluation_payload.get("passed") or 0)
    reward = (passed / total) * 100.0
    by_category = evaluation_payload.get("by_category") or {}
    for _category, stats in by_category.items():
        cat_total = max(1, int(stats.get("total") or 0))
        cat_passed = int(stats.get("passed") or 0)
        reward += (cat_passed / cat_total) * 10.0
    return round(reward, 4)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--steps", type=int, default=120)
    parser.add_argument("--sft-dataset", default=str(DEFAULT_SFT_DATASET))
    parser.add_argument("--resume-checkpoint", default="")
    parser.add_argument("--tokenizer-path", default="")
    parser.add_argument("--eval-file", default="")
    parser.add_argument("--eval-output", default="")
    parser.add_argument("--eval-steps", default="")
    parser.add_argument("--eval-max-new-tokens", type=int, default=64)
    parser.add_argument("--eval-temperature", type=float, default=0.82)
    parser.add_argument("--eval-top-k", type=int, default=40)
    parser.add_argument("--eval-top-p", type=float, default=0.92)
    parser.add_argument("--eval-repetition-penalty", type=float, default=1.08)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--seed", type=int, default=20260405)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    status_path = Path(args.status_file)
    checkpoint_dir = output_dir / "checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    eval_dir = output_dir / "evaluations"
    eval_dir.mkdir(parents=True, exist_ok=True)

    blueprint, config = load_blueprint(args.config)
    estimated_params = estimate_parameter_count(config)
    backend = backend_summary()
    random.seed(args.seed)
    if torch is not None:
        torch.manual_seed(args.seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(args.seed)

    status = {
        "running": True,
        "stage": "initializing",
        "message": "Preparing 100M pipeline",
        "model_id": args.model_id,
        "estimated_params": estimated_params,
        "backend": backend,
        "progress": 3,
        "corpus_path": str(Path(args.corpus)),
        "output_dir": str(output_dir),
        "dry_run": bool(args.dry_run),
    }
    requested_steps = max(1, int(args.steps))
    eval_steps = parse_eval_steps(args.eval_steps, requested_steps)
    eval_file = Path(args.eval_file) if args.eval_file else None
    eval_output = Path(args.eval_output) if args.eval_output else (eval_dir / "latest.json")
    eval_enabled = bool(eval_file and eval_file.exists() and eval_steps)
    status["eval_schedule"] = eval_steps
    status["eval_file"] = str(eval_file) if eval_file else ""
    status["eval_latest_output"] = str(eval_output)
    status["evaluation_history"] = []
    status["latest_evaluation"] = None
    status["evaluation_running"] = False
    write_status(status_path, status)

    sft_dataset_path = Path(args.sft_dataset) if args.sft_dataset else DEFAULT_SFT_DATASET
    sft_rows = read_jsonl(sft_dataset_path)
    corpus_text = load_corpus(Path(args.corpus))
    corpus_size = len(corpus_text)
    status["corpus_characters"] = corpus_size
    tokenizer_path = output_dir / "tokenizer.json"
    tokenizer_report_path = output_dir / "tokenizer_report.json"
    tokenizer_training_text = build_tokenizer_training_text(corpus_text, sft_rows)
    lm_corpus_text = build_language_model_corpus(corpus_text, sft_rows)
    foundation_corpus_text = build_foundation_warmup_corpus(corpus_text, sft_rows)
    resume_checkpoint_path = Path(args.resume_checkpoint) if args.resume_checkpoint else None
    resume_checkpoint_rejected = should_discard_resume_checkpoint(resume_checkpoint_path)
    if resume_checkpoint_rejected:
        resume_checkpoint_path = None
    external_tokenizer_path = Path(args.tokenizer_path) if args.tokenizer_path else None
    resume_tokenizer = load_resume_tokenizer(resume_checkpoint_path)
    if external_tokenizer_path and external_tokenizer_path.exists():
        tokenizer = load_tokenizer(external_tokenizer_path)
        tokenizer_path = external_tokenizer_path
    elif resume_tokenizer:
        tokenizer = resume_tokenizer
        save_tokenizer(tokenizer_path, tokenizer)
    else:
        tokenizer = build_tokenizer(tokenizer_training_text, vocab_size=config.vocab_size)
        save_tokenizer(tokenizer_path, tokenizer)
    tokenizer_stats = tokenizer.get("stats", {})
    tokenizer_report = build_tokenizer_report(tokenizer_training_text, tokenizer)
    tokenizer_report_path.write_text(json.dumps(tokenizer_report, ensure_ascii=False, indent=2), encoding="utf-8")
    reward_profile = load_reward_profile(eval_output if eval_enabled else None)
    status["tokenizer_path"] = str(tokenizer_path)
    status["tokenizer_report_path"] = str(tokenizer_report_path)
    status["tokenizer_vocab_size"] = tokenizer_stats.get("effective_vocab_size", 0)
    status["tokenizer_coverage"] = tokenizer_stats.get("full_piece_coverage", 0.0)
    status["reward_profile"] = reward_profile
    status["resume_checkpoint_rejected"] = bool(resume_checkpoint_rejected)
    if resume_checkpoint_rejected:
        status["resume_checkpoint_rejected_reason"] = "zero-reward-or-zero-pass-evaluation"
    sft_examples, sft_stats = build_sft_examples(
        tokenizer,
        sft_dataset_path,
        min(256, config.max_position_embeddings),
        reward_profile=reward_profile,
    )

    if args.dry_run:
        status.update({
            "running": False,
            "stage": "dry-run-complete",
            "message": "100M dry run completed",
            "progress": 100,
            "training_summary": {
                "estimated_params": estimated_params,
                "corpus_characters": corpus_size,
                "lm_corpus_characters": len(foundation_corpus_text),
                "backend": backend,
                "steps_requested": args.steps,
                "tokenizer_vocab_size": tokenizer_stats.get("effective_vocab_size", 0),
                "tokenizer_coverage": tokenizer_stats.get("full_piece_coverage", 0.0),
                "tokenizer_report_path": str(tokenizer_report_path),
                "sft_dataset": sft_stats,
                "eval_schedule": eval_steps,
                "eval_file": str(eval_file) if eval_file else "",
                "reward_profile": reward_profile,
                "resume_checkpoint": str(resume_checkpoint_path) if resume_checkpoint_path else "",
                "resume_checkpoint_rejected": bool(resume_checkpoint_rejected),
                "tokenizer_source": str(tokenizer_path),
            },
        })
        write_status(status_path, status)
        return

    if torch is None:
        status.update({
            "running": False,
            "stage": "blocked",
            "message": "PyTorch is not installed on the management computer",
            "progress": 100,
        })
        write_status(status_path, status)
        raise SystemExit(2)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda":
        try:
            torch.set_float32_matmul_precision("high")
        except Exception:
            pass
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    status.update({
        "stage": "building-model",
        "message": f"Building Purple Bee 100M on {device}",
        "progress": 10,
    })
    write_status(status_path, status)

    try:
        resumed_step = 0
        resumed_checkpoint_path = ""
        if resume_checkpoint_path and resume_checkpoint_path.exists():
            checkpoint_payload, _resume_blueprint, _resume_config, model = load_checkpoint(resume_checkpoint_path, device=device)
            model = model.to(device)
            resumed_step = int(checkpoint_payload.get("step") or 0)
            resumed_checkpoint_path = str(resume_checkpoint_path)
        else:
            model = build_model(config).to(device)
        param_count = count_torch_parameters(model)
        defaults = blueprint.get("training_defaults", {})
        learning_rate = float(defaults.get("learning_rate", 3e-4))
        min_learning_rate = float(defaults.get("min_learning_rate", learning_rate * 0.1))
        warmup_steps = max(0, int(defaults.get("warmup_steps", 0)))
        gradient_accumulation_steps = max(1, int(defaults.get("gradient_accumulation_steps", 1)))
        if resumed_step > 0:
            learning_rate = min(learning_rate, 6e-5)
            min_learning_rate = min(min_learning_rate, max(1e-5, learning_rate * 0.25))
            warmup_steps = min(max(20, requested_steps // 8), max(warmup_steps, 20))
            gradient_accumulation_steps = max(gradient_accumulation_steps, 8)
        optimizer = torch.optim.AdamW(
            model.parameters(),
            lr=learning_rate,
            weight_decay=float(defaults.get("weight_decay", 0.01)),
            betas=(0.9, 0.95),
        )

        status.update({
            "stage": "training",
            "message": "Running bootstrap training loop",
            "progress": 18,
            "actual_params": param_count,
            "device": device,
            "resume_checkpoint": resumed_checkpoint_path,
            "resume_step": resumed_step,
        })
        write_status(status_path, status)

        encoded = encode_text(foundation_corpus_text, tokenizer, add_bos=True, add_eos=True)
        sequence_length = min(defaults.get("sequence_length", 256), config.max_position_embeddings)
        batch_size = int(defaults.get("batch_size", 2))
        train_steps = requested_steps
        losses = []
        evaluation_history = []
        pad_id = tokenizer["special_tokens"]["<pad>"]
        if sequence_length != min(256, config.max_position_embeddings):
            sft_examples, sft_stats = build_sft_examples(
                tokenizer,
                sft_dataset_path,
                sequence_length,
                reward_profile=reward_profile,
            )
        use_supervised = len(sft_examples) > 0
        lm_warmup_steps = train_steps
        if use_supervised:
            # Chat repair mode: start from supervised dialogue immediately.
            lm_warmup_steps = 0
        if use_supervised:
            learning_rate = min(learning_rate, 1.5e-4)
            min_learning_rate = min(min_learning_rate, learning_rate * 0.2)
            gradient_accumulation_steps = max(gradient_accumulation_steps, 4)
            if resumed_step > 0:
                learning_rate = min(learning_rate, 6e-5)
                min_learning_rate = min(min_learning_rate, max(1e-5, learning_rate * 0.25))
                gradient_accumulation_steps = max(gradient_accumulation_steps, 8)
            for param_group in optimizer.param_groups:
                param_group["lr"] = learning_rate
        amp_enabled = device == "cuda"
        amp_dtype = torch.bfloat16 if amp_enabled and hasattr(torch.cuda, "is_bf16_supported") and torch.cuda.is_bf16_supported() else torch.float16
        scaler = torch.amp.GradScaler(device, enabled=amp_enabled and amp_dtype == torch.float16)

        def lr_for_step(step_index: int) -> float:
            if train_steps <= 1:
                return learning_rate
            if warmup_steps > 0 and step_index <= warmup_steps:
                return learning_rate * (step_index / max(1, warmup_steps))
            progress = (step_index - warmup_steps) / max(1, train_steps - warmup_steps)
            progress = min(max(progress, 0.0), 1.0)
            cosine = 0.5 * (1.0 + math.cos(math.pi * progress))
            return min_learning_rate + (learning_rate - min_learning_rate) * cosine

        model.train()
        for step in range(1, train_steps + 1):
            global_step = resumed_step + step
            optimizer.zero_grad(set_to_none=True)
            micro_losses = []
            supervised_phase = bool(use_supervised and step > lm_warmup_steps)
            for _micro in range(gradient_accumulation_steps):
                if supervised_phase:
                    input_ids, labels = sample_supervised_batch(
                        sft_examples,
                        batch_size=batch_size,
                        seq_len=sequence_length,
                        device=device,
                        pad_id=pad_id,
                    )
                else:
                    input_ids, labels = sample_batch(encoded, batch_size=batch_size, seq_len=sequence_length, device=device)
                with torch.autocast(device_type=device, enabled=amp_enabled, dtype=amp_dtype):
                    _, loss = model(input_ids, labels=labels)
                    normalized_loss = loss / gradient_accumulation_steps
                scaler.scale(normalized_loss).backward()
                micro_losses.append(float(loss.detach().cpu().item()))

            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), defaults.get("gradient_clip", 1.0))
            scaler.step(optimizer)
            scaler.update()
            current_lr = lr_for_step(step)
            for param_group in optimizer.param_groups:
                param_group["lr"] = current_lr

            loss_value = sum(micro_losses) / max(1, len(micro_losses))
            losses.append(loss_value)
            status.update({
                "progress": round(18 + (step / train_steps) * 78, 1),
                "message": f"Training step {global_step} ({step}/{train_steps} in this run)",
                "last_loss": round(loss_value, 6),
                "avg_loss": round(sum(losses[-20:]) / len(losses[-20:]), 6),
                "learning_rate": round(current_lr, 8),
                "gradient_accumulation_steps": gradient_accumulation_steps,
                "training_mode": "supervised-dialogue-sft" if supervised_phase else "plain-lm-warmup",
                "sft_dataset": sft_stats,
                "lm_corpus_characters": len(foundation_corpus_text),
                "lm_warmup_steps": lm_warmup_steps,
                "reward_profile": reward_profile,
            })
            if step == 1 or step == train_steps or step % 10 == 0:
                write_status(status_path, status)

            if eval_enabled and step in eval_steps:
                checkpoint_path = checkpoint_dir / f"purple_bee_100m_step{global_step:05d}.pt"
                save_checkpoint(checkpoint_path, model, blueprint, tokenizer, step=global_step, losses=losses)
                status.update({
                    "stage": "evaluating",
                    "message": f"Evaluating checkpoint step {global_step}",
                    "evaluation_running": True,
                    "checkpoint": str(checkpoint_path),
                })
                write_status(status_path, status)
                try:
                    evaluation_output_path = eval_dir / f"eval_step_{step:05d}.json"
                    evaluation_payload = run_checkpoint_evaluation(
                        checkpoint_path=checkpoint_path,
                        tokenizer_path=tokenizer_path,
                        eval_file=eval_file,
                        output_path=evaluation_output_path,
                        device=device,
                        max_new_tokens=args.eval_max_new_tokens,
                        temperature=args.eval_temperature,
                        top_k=args.eval_top_k,
                        top_p=args.eval_top_p,
                        repetition_penalty=args.eval_repetition_penalty,
                    )
                    evaluation_summary = {
                        "step": global_step,
                        "checkpoint": str(checkpoint_path),
                        "output_path": str(evaluation_output_path),
                        "total": evaluation_payload.get("total", 0),
                        "passed": evaluation_payload.get("passed", 0),
                        "failed": evaluation_payload.get("failed", 0),
                        "pass_rate": evaluation_payload.get("pass_rate", 0.0),
                        "device": evaluation_payload.get("device", device),
                        "categories": evaluation_payload.get("categories", []),
                        "by_category": evaluation_payload.get("by_category", {}),
                        "evaluated_at": evaluation_payload.get("evaluated_at"),
                        "reward_score": compute_reward_score(evaluation_payload),
                    }
                    evaluation_history.append(evaluation_summary)
                    status["latest_evaluation"] = evaluation_summary
                    status["evaluation_history"] = evaluation_history
                    status["eval_latest_output"] = str(evaluation_output_path)
                    best_reward = float(status.get("best_reward_score") or -1)
                    if evaluation_summary["reward_score"] > best_reward:
                        best_checkpoint_path = checkpoint_dir / "purple_bee_100m_reward_best.pt"
                        shutil.copy2(checkpoint_path, best_checkpoint_path)
                        status["best_reward_score"] = evaluation_summary["reward_score"]
                        status["best_reward_step"] = global_step
                        status["best_reward_checkpoint"] = str(best_checkpoint_path)
                    if eval_output:
                        eval_output.write_text(json.dumps(evaluation_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                except Exception as eval_exc:
                    error_summary = {
                        "step": global_step,
                        "error": str(eval_exc)[:800],
                    }
                    evaluation_history.append(error_summary)
                    status["latest_evaluation"] = error_summary
                    status["evaluation_history"] = evaluation_history
                status.update({
                    "stage": "training",
                    "message": f"Training step {global_step} ({step}/{train_steps} in this run)",
                    "evaluation_running": False,
                })
                write_status(status_path, status)

        checkpoint_path = checkpoint_dir / "purple_bee_100m_bootstrap.pt"
        save_checkpoint(checkpoint_path, model, blueprint, tokenizer, step=resumed_step + train_steps, losses=losses)

        summary_path = output_dir / "training_summary.json"
        summary_path.write_text(json.dumps({
            "model_id": args.model_id,
            "estimated_params": estimated_params,
            "actual_params": param_count,
            "steps": train_steps,
            "final_global_step": resumed_step + train_steps,
            "final_loss": round(losses[-1], 6) if losses else None,
            "avg_loss": round(sum(losses) / len(losses), 6) if losses else None,
            "checkpoint": str(checkpoint_path),
            "device": device,
            "tokenizer_path": str(tokenizer_path),
            "tokenizer_vocab_size": tokenizer_stats.get("effective_vocab_size", 0),
            "tokenizer_coverage": tokenizer_stats.get("full_piece_coverage", 0.0),
            "gradient_accumulation_steps": gradient_accumulation_steps,
            "sequence_length": sequence_length,
            "batch_size": batch_size,
            "training_mode": "supervised-dialogue-sft" if use_supervised else "plain-lm-warmup",
            "sft_dataset": sft_stats,
            "lm_corpus_characters": len(foundation_corpus_text),
            "lm_warmup_steps": lm_warmup_steps,
            "learning_rate": learning_rate,
            "min_learning_rate": min_learning_rate,
            "warmup_steps": warmup_steps,
            "eval_schedule": eval_steps,
            "eval_file": str(eval_file) if eval_file else "",
            "eval_temperature": args.eval_temperature,
            "eval_top_k": args.eval_top_k,
            "eval_top_p": args.eval_top_p,
            "eval_repetition_penalty": args.eval_repetition_penalty,
            "evaluation_history": evaluation_history,
            "best_reward_step": status.get("best_reward_step"),
            "best_reward_checkpoint": status.get("best_reward_checkpoint"),
            "best_reward_score": status.get("best_reward_score"),
            "tokenizer_report_path": str(tokenizer_report_path),
            "tokenizer_report": tokenizer_report,
                "reward_profile": reward_profile,
                "resume_checkpoint": resumed_checkpoint_path,
                "resume_step": resumed_step,
                "resume_checkpoint_rejected": bool(resume_checkpoint_rejected),
            }, ensure_ascii=False, indent=2), encoding="utf-8")

        status.update({
            "running": False,
            "stage": "complete",
            "message": "100M bootstrap training completed",
            "progress": 100,
            "checkpoint": str(checkpoint_path),
            "summary_path": str(summary_path),
            "evaluation_running": False,
            "evaluation_history": evaluation_history,
            "training_mode": "supervised-dialogue-sft" if use_supervised else "plain-lm-warmup",
            "sft_dataset": sft_stats,
            "lm_corpus_characters": len(foundation_corpus_text),
            "lm_warmup_steps": lm_warmup_steps,
            "reward_profile": reward_profile,
        })
        write_status(status_path, status)
    except Exception as exc:
        status.update({
            "running": False,
            "stage": "error",
            "message": f"Training failed: {str(exc)[:140]}",
            "progress": status.get("progress", 0),
        })
        write_status(status_path, status)
        raise


if __name__ == "__main__":
    main()
