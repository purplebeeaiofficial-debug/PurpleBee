import argparse
import json
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from purple_bee_100m import load_checkpoint, torch  # noqa: E402
from purple_bee_tokenizer import decode_ids, encode_text, load_tokenizer  # noqa: E402


if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE_CHAT_PROMPT = (
    "Instruction: You are Purple Bee.\n"
    "Instruction: Reply naturally and directly in the same language as the user.\n"
    "Instruction: Avoid menus, repeated phrases, role labels, system markers, and broken text.\n"
)


def choose_device(requested="auto"):
    if requested != "auto":
        return requested
    if torch is not None and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def apply_repetition_penalty(logits, recent_ids, penalty=1.0):
    if penalty is None or penalty <= 1.0 or not recent_ids:
        return logits
    adjusted = logits.clone()
    recent = set(int(token_id) for token_id in recent_ids if int(token_id) >= 0)
    for token_id in recent:
        value = adjusted[token_id]
        adjusted[token_id] = value / penalty if value > 0 else value * penalty
    return adjusted


def apply_frequency_penalty(logits, recent_ids, alpha=0.0):
    if alpha <= 0 or not recent_ids:
        return logits
    adjusted = logits.clone()
    counts = {}
    for token_id in recent_ids:
        token_id = int(token_id)
        if token_id < 0:
            continue
        counts[token_id] = counts.get(token_id, 0) + 1
    for token_id, count in counts.items():
        adjusted[token_id] = adjusted[token_id] - (alpha * count)
    return adjusted


def apply_no_repeat_ngram(logits, generated, ngram_size=3):
    if ngram_size <= 1 or len(generated) < ngram_size - 1:
        return logits
    prefix = tuple(int(token_id) for token_id in generated[-(ngram_size - 1):])
    blocked = set()
    upper = len(generated) - ngram_size + 1
    for start in range(max(0, upper)):
        if tuple(int(token_id) for token_id in generated[start:start + ngram_size - 1]) == prefix:
            blocked.add(int(generated[start + ngram_size - 1]))
    if not blocked:
        return logits
    adjusted = logits.clone()
    for token_id in blocked:
        if 0 <= token_id < adjusted.shape[-1]:
            adjusted[token_id] = float("-inf")
    return adjusted


def block_runaway_token(logits, generated, limit=3):
    if limit <= 1 or len(generated) < limit:
        return logits
    tail = [int(token_id) for token_id in generated[-limit:]]
    if len(set(tail)) != 1:
        return logits
    adjusted = logits.clone()
    runaway_id = tail[-1]
    if 0 <= runaway_id < adjusted.shape[-1]:
        adjusted[runaway_id] = float("-inf")
    return adjusted


def sample_next_token(logits, temperature=0.8, top_k=40, top_p=0.92):
    if temperature <= 0:
        return int(torch.argmax(logits).item())
    logits = logits / max(temperature, 1e-5)
    if top_k and top_k > 0:
        values, indices = torch.topk(logits, k=min(top_k, logits.shape[-1]))
        if 0 < top_p < 1:
            sorted_probs = torch.softmax(values, dim=-1)
            cumulative = torch.cumsum(sorted_probs, dim=-1)
            keep_mask = cumulative <= top_p
            if keep_mask.numel():
                keep_mask[0] = True
            filtered_values = values.masked_fill(~keep_mask, float("-inf"))
            probs = torch.softmax(filtered_values, dim=-1)
        else:
            probs = torch.softmax(values, dim=-1)
        selected = torch.multinomial(probs, num_samples=1)
        return int(indices[selected].item())
    probs = torch.softmax(logits, dim=-1)
    return int(torch.multinomial(probs, num_samples=1).item())


def mask_unused_logits(logits, tokenizer):
    effective_vocab_size = int(tokenizer.get("stats", {}).get("effective_vocab_size") or len(tokenizer.get("vocab", [])))
    if effective_vocab_size <= 0 or effective_vocab_size >= logits.shape[-1]:
        return logits
    masked = logits.clone()
    masked[effective_vocab_size:] = float("-inf")
    return masked


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--max-new-tokens", type=int, default=80)
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--top-k", type=int, default=40)
    parser.add_argument("--top-p", type=float, default=0.92)
    parser.add_argument("--repetition-penalty", type=float, default=1.08)
    parser.add_argument("--frequency-penalty", type=float, default=0.2)
    parser.add_argument("--no-repeat-ngram-size", type=int, default=3)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    if torch is None:
        raise RuntimeError("PyTorch is not installed.")

    device = choose_device(args.device)
    checkpoint, blueprint, config, model = load_checkpoint(args.checkpoint, device=device)
    tokenizer = load_tokenizer(args.tokenizer)
    chat_prompt = f"{BASE_CHAT_PROMPT}User: {str(args.prompt).strip()}\nAssistant:"
    input_ids = encode_text(chat_prompt, tokenizer, add_bos=True, add_eos=False)
    generated = list(input_ids)
    eos_id = tokenizer["special_tokens"]["<eos>"]

    model.eval()
    with torch.no_grad():
        for _ in range(max(1, args.max_new_tokens)):
            window = generated[-config.max_position_embeddings:]
            x = torch.tensor([window], dtype=torch.long, device=device)
            with torch.autocast(device_type=device, enabled=(device == "cuda"), dtype=(torch.bfloat16 if device == "cuda" and hasattr(torch.cuda, "is_bf16_supported") and torch.cuda.is_bf16_supported() else torch.float16)):
                logits, _ = model(x)
            next_token_logits = mask_unused_logits(logits[0, -1, :], tokenizer)
            next_token_logits = apply_repetition_penalty(next_token_logits, generated[-96:], args.repetition_penalty)
            next_token_logits = apply_frequency_penalty(next_token_logits, generated[-96:], args.frequency_penalty)
            next_token_logits = apply_no_repeat_ngram(next_token_logits, generated, ngram_size=args.no_repeat_ngram_size)
            next_token_logits = block_runaway_token(next_token_logits, generated, limit=3)
            next_id = sample_next_token(
                next_token_logits,
                temperature=args.temperature,
                top_k=args.top_k,
                top_p=args.top_p,
            )
            generated.append(next_id)
            if next_id == eos_id:
                break

    prompt_text = decode_ids(input_ids, tokenizer)
    full_text = decode_ids(generated, tokenizer)
    completion_text = full_text[len(prompt_text):]
    completion_text = completion_text.strip()
    completion_text = completion_text.removeprefix("Assistant:").strip()
    completion_text = completion_text.split("\nUser:")[0].split("\nAssistant:")[0].strip()
    print(json.dumps({
        "prompt": args.prompt,
        "prompt_decoded": prompt_text,
        "completion": completion_text.strip(),
        "full_text": full_text,
        "device": device,
        "checkpoint": str(Path(args.checkpoint)),
        "tokenizer_vocab_size": tokenizer.get("stats", {}).get("effective_vocab_size"),
        "model_params": checkpoint.get("config", {}).get("parameter_budget"),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
