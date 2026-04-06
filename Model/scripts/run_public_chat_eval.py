import argparse
import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

from generate_100m import (  # noqa: E402
    apply_frequency_penalty,
    apply_no_repeat_ngram,
    apply_repetition_penalty,
    block_runaway_token,
    choose_device,
    sample_next_token,
)
from purple_bee_100m import load_checkpoint, torch  # noqa: E402
from purple_bee_tokenizer import decode_ids, encode_text, load_tokenizer  # noqa: E402


if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


BAD_MARKERS = [
    "<|",
    "\ue200cite",
    "localhost server inference",
    "question core",
    "at a glance",
    "assistant:",
    "user:",
]


def mask_unused_logits(logits, tokenizer):
    effective_vocab_size = int(tokenizer.get("stats", {}).get("effective_vocab_size") or len(tokenizer.get("vocab", [])))
    if effective_vocab_size <= 0 or effective_vocab_size >= logits.shape[-1]:
        return logits
    masked = logits.clone()
    masked[effective_vocab_size:] = float("-inf")
    return masked


def read_jsonl(path: Path):
    rows = []
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def generate_completion(
    model,
    tokenizer,
    config,
    prompt: str,
    device: str,
    max_new_tokens: int,
    temperature: float,
    top_k: int,
    top_p: float,
    repetition_penalty: float,
    frequency_penalty: float,
    no_repeat_ngram_size: int,
):
    chat_prompt = (
        "Instruction: You are Purple Bee.\n"
        "Instruction: Reply naturally and directly in the same language as the user.\n"
        "Instruction: Avoid menus, repeated phrases, role labels, and system markers.\n"
        f"User: {str(prompt).strip()}\n"
        "Assistant:"
    )
    input_ids = encode_text(chat_prompt, tokenizer, add_bos=True, add_eos=False)
    generated = list(input_ids)
    eos_id = tokenizer["special_tokens"]["<eos>"]

    model.eval()
    with torch.no_grad():
        for _ in range(max(1, max_new_tokens)):
            window = generated[-config.max_position_embeddings:]
            x = torch.tensor([window], dtype=torch.long, device=device)
            with torch.autocast(
                device_type=device,
                enabled=(device == "cuda"),
                dtype=(torch.bfloat16 if device == "cuda" and hasattr(torch.cuda, "is_bf16_supported") and torch.cuda.is_bf16_supported() else torch.float16),
            ):
                logits, _ = model(x)
            next_token_logits = mask_unused_logits(logits[0, -1, :], tokenizer)
            next_token_logits = apply_repetition_penalty(next_token_logits, generated[-96:], repetition_penalty)
            next_token_logits = apply_frequency_penalty(next_token_logits, generated[-96:], frequency_penalty)
            next_token_logits = apply_no_repeat_ngram(next_token_logits, generated, ngram_size=no_repeat_ngram_size)
            next_token_logits = block_runaway_token(next_token_logits, generated, limit=3)
            next_id = sample_next_token(
                next_token_logits,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
            )
            generated.append(next_id)
            if next_id == eos_id:
                break

    prompt_text = decode_ids(input_ids, tokenizer)
    full_text = decode_ids(generated, tokenizer)
    completion = full_text[len(prompt_text):].strip()
    completion = re.sub(r"^(Assistant:)\s*", "", completion, flags=re.IGNORECASE)
    completion = re.split(r"\n(?:User|Assistant)\s*:", completion)[0].strip()
    return completion


def has_heavy_repetition(text: str) -> bool:
    cleaned = text.strip()
    if not cleaned:
        return False
    lowered = cleaned.lower()
    if any(marker in lowered for marker in BAD_MARKERS):
        return True
    if len(cleaned) >= 8 and cleaned[:2] * 4 in cleaned:
        return True
    if re.search(r"(.{2,8})\1{2,}", cleaned):
        return True

    words = cleaned.split()
    if len(words) >= 6:
        lowered_words = [word.lower() for word in words]
        unique_ratio = len(set(lowered_words)) / len(lowered_words)
        if unique_ratio < 0.55:
            return True
        repeated = max(lowered_words.count(word) for word in set(lowered_words))
        if repeated >= max(3, len(lowered_words) // 3):
            return True
    return False


def evaluate_output(row: dict, output: str):
    failures = []
    if not output:
        failures.append("empty")
    should_contain_any = [str(item).lower() for item in (row.get("should_contain_any") or []) if str(item).strip()]
    if should_contain_any and not any(token in output.lower() for token in should_contain_any):
        failures.append("missing-anchor")
    for marker in row.get("must_not_contain", []):
        if marker and marker.lower() in output.lower():
            failures.append(f"contains:{marker}")
    if has_heavy_repetition(output):
        failures.append("repetition-or-marker")
    return failures


def summarize_results(results: list[dict]):
    by_category = defaultdict(lambda: {"total": 0, "passed": 0, "failed": 0})
    by_tag = defaultdict(lambda: {"total": 0, "passed": 0, "failed": 0})
    for row in results:
        failures = row.get("failures") or []
        passed = not failures
        category = str(row.get("category") or "uncategorized")
        by_category[category]["total"] += 1
        by_category[category]["passed"] += int(passed)
        by_category[category]["failed"] += int(not passed)
        for tag in row.get("tags") or []:
            key = str(tag)
            by_tag[key]["total"] += 1
            by_tag[key]["passed"] += int(passed)
            by_tag[key]["failed"] += int(not passed)
    return {
        "by_category": dict(sorted(by_category.items())),
        "by_tag": dict(sorted(by_tag.items())),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--eval-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-new-tokens", type=int, default=64)
    parser.add_argument("--temperature", type=float, default=0.82)
    parser.add_argument("--top-k", type=int, default=40)
    parser.add_argument("--top-p", type=float, default=0.92)
    parser.add_argument("--repetition-penalty", type=float, default=1.08)
    parser.add_argument("--frequency-penalty", type=float, default=0.2)
    parser.add_argument("--no-repeat-ngram-size", type=int, default=3)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    device = choose_device(args.device)
    checkpoint, _blueprint, config, model = load_checkpoint(args.checkpoint, device=device)
    tokenizer = load_tokenizer(args.tokenizer)
    rows = read_jsonl(Path(args.eval_file))

    results = []
    failure_count = 0
    for row in rows:
        output = generate_completion(
            model,
            tokenizer,
            config,
            row["prompt"],
            device,
            args.max_new_tokens,
            args.temperature,
            args.top_k,
            args.top_p,
            args.repetition_penalty,
            args.frequency_penalty,
            args.no_repeat_ngram_size,
        )
        failures = evaluate_output(row, output)
        if failures:
            failure_count += 1
        category = row.get("category") or ((row.get("tags") or [None])[0]) or "uncategorized"
        results.append({
            "prompt": row["prompt"],
            "expectation": row.get("expectation", ""),
            "output": output,
            "failures": failures,
            "category": category,
            "tags": row.get("tags", []),
        })

    summaries = summarize_results(results)
    payload = {
        "checkpoint": str(Path(args.checkpoint)),
        "tokenizer": str(Path(args.tokenizer)),
        "eval_file": str(Path(args.eval_file)),
        "device": device,
        "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "total": len(results),
        "failed": failure_count,
        "passed": len(results) - failure_count,
        "pass_rate": round(((len(results) - failure_count) / max(1, len(results))) * 100, 2),
        "categories": sorted({row["category"] for row in results}),
        "by_category": summaries["by_category"],
        "by_tag": summaries["by_tag"],
        "results": results,
        "tokenizer_vocab_size": tokenizer.get("stats", {}).get("effective_vocab_size"),
        "model_params": checkpoint.get("config", {}).get("parameter_budget"),
        "generation": {
            "temperature": args.temperature,
            "top_k": args.top_k,
            "top_p": args.top_p,
            "repetition_penalty": args.repetition_penalty,
            "frequency_penalty": args.frequency_penalty,
            "no_repeat_ngram_size": args.no_repeat_ngram_size,
        },
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
