import argparse
import json
from pathlib import Path

from generate_100m import choose_device, sample_next_token
from purple_bee_100m import load_checkpoint, torch
from purple_bee_tokenizer import decode_ids, encode_text, load_tokenizer
from run_public_chat_eval import evaluate_output, read_jsonl

from transformers import AutoModelForCausalLM, AutoTokenizer


ROOT = Path(__file__).resolve().parents[2]
HF_AUTH_PATH = ROOT / "cloudflare" / "hf-auth.local.json"


def load_hf_token():
    if not HF_AUTH_PATH.exists():
        return None
    try:
        payload = json.loads(HF_AUTH_PATH.read_text(encoding="utf-8-sig"))
        return payload.get("token") or None
    except Exception:
        return None


def generate_purple_bee(model, tokenizer, config, prompt: str, device: str, max_new_tokens: int, temperature: float, top_k: int):
    input_ids = encode_text(prompt, tokenizer, add_bos=True, add_eos=False)
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
            next_token_logits = logits[0, -1, :]
            next_id = sample_next_token(next_token_logits, temperature=temperature, top_k=top_k)
            generated.append(next_id)
            if next_id == eos_id:
                break

    prompt_text = decode_ids(input_ids, tokenizer)
    full_text = decode_ids(generated, tokenizer)
    return full_text[len(prompt_text):].strip()


def load_reference_model(model_id: str, device: str):
    token = load_hf_token()
    tokenizer = AutoTokenizer.from_pretrained(model_id, token=token, trust_remote_code=True)
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        token=token,
        torch_dtype=dtype,
        trust_remote_code=True,
    )
    model.to(device)
    model.eval()
    return tokenizer, model


def build_reference_prompt(tokenizer, prompt: str):
    messages = [{"role": "user", "content": prompt}]
    if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template:
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return f"User: {prompt}\nAssistant:"


def generate_reference_reply(tokenizer, model, prompt: str, device: str, max_new_tokens: int, temperature: float, top_p: float):
    rendered = build_reference_prompt(tokenizer, prompt)
    encoded = tokenizer(rendered, return_tensors="pt")
    encoded = {key: value.to(device) for key, value in encoded.items()}
    with torch.no_grad():
        output = model.generate(
            **encoded,
            max_new_tokens=max_new_tokens,
            do_sample=True,
            temperature=temperature,
            top_p=top_p,
            pad_token_id=tokenizer.eos_token_id,
        )
    new_tokens = output[0][encoded["input_ids"].shape[-1]:]
    text = tokenizer.decode(new_tokens, skip_special_tokens=True)
    return text.strip()


def main():
    parser = argparse.ArgumentParser(description="Compare Purple Bee against a small external reference model.")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--eval-file", default=str(ROOT / "Model" / "evals" / "public_chat_regression_ko.jsonl"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--reference-model", default="HuggingFaceTB/SmolLM2-135M-Instruct")
    parser.add_argument("--max-new-tokens", type=int, default=64)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--top-p", type=float, default=0.9)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    device = choose_device(args.device)
    checkpoint, _blueprint, config, purple_model = load_checkpoint(args.checkpoint, device=device)
    purple_tokenizer = load_tokenizer(args.tokenizer)
    ref_tokenizer, ref_model = load_reference_model(args.reference_model, device=device)
    rows = read_jsonl(Path(args.eval_file))

    results = []
    purple_failures = 0
    reference_failures = 0

    for row in rows:
      prompt = row["prompt"]
      purple_output = generate_purple_bee(
          purple_model,
          purple_tokenizer,
          config,
          prompt,
          device,
          args.max_new_tokens,
          args.temperature,
          args.top_k,
      )
      reference_output = generate_reference_reply(
          ref_tokenizer,
          ref_model,
          prompt,
          device,
          args.max_new_tokens,
          args.temperature,
          args.top_p,
      )
      purple_eval = evaluate_output(row, purple_output)
      reference_eval = evaluate_output(row, reference_output)
      if purple_eval:
          purple_failures += 1
      if reference_eval:
          reference_failures += 1
      results.append({
          "prompt": prompt,
          "expectation": row.get("expectation", ""),
          "tags": row.get("tags", []),
          "purple_bee": {
              "output": purple_output,
              "failures": purple_eval,
          },
          "reference": {
              "model": args.reference_model,
              "output": reference_output,
              "failures": reference_eval,
          },
      })

    payload = {
        "purple_bee_checkpoint": str(Path(args.checkpoint)),
        "purple_bee_tokenizer": str(Path(args.tokenizer)),
        "reference_model": args.reference_model,
        "eval_file": str(Path(args.eval_file)),
        "device": device,
        "total": len(results),
        "purple_bee_failed": purple_failures,
        "reference_failed": reference_failures,
        "results": results,
        "purple_bee_vocab_size": purple_tokenizer.get("stats", {}).get("effective_vocab_size"),
        "purple_bee_model_params": checkpoint.get("config", {}).get("parameter_budget"),
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
