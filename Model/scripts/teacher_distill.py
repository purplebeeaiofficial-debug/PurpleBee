import argparse
import json
import os
import time
from pathlib import Path

import requests


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def split_blocks(text: str):
    return [block.strip() for block in str(text or "").split("\n\n") if block.strip()]


def build_user_prompt(source_block: str, samples_per_block: int):
    return (
        "Create high-quality training data for Purple Bee.\n"
        "Return strict JSON with this shape:\n"
        '{"pairs":[{"instruction":"...","response":"...","tags":["chat","coding"]}]}\n'
        f"Generate up to {samples_per_block} pairs.\n"
        "Requirements:\n"
        "- natural Korean-first conversational quality when appropriate\n"
        "- concise, direct, useful answers\n"
        "- no meta commentary about prompts or policies\n"
        "- no repetitive boilerplate\n"
        "- include diverse tasks if the source supports it\n\n"
        "Source material:\n"
        f"{source_block}"
    )


def call_openai_compatible(config: dict, user_prompt: str):
    api_key = os.getenv(config.get("api_key_env", "")) if config.get("api_key_env") else ""
    if not api_key:
        raise RuntimeError(f"Missing API key env var: {config.get('api_key_env')}")

    base_url = str(config.get("base_url") or "").rstrip("/")
    if not base_url:
      raise RuntimeError("Teacher base_url is empty")

    model = config.get("model")
    if not model:
      raise RuntimeError("Teacher model name is empty")

    url = f"{base_url}/chat/completions"
    payload = {
        "model": model,
        "temperature": float(config.get("temperature", 0.4)),
        "max_tokens": int(config.get("max_output_tokens", 900)),
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": config.get("system_prompt", "Return strict JSON only.")},
            {"role": "user", "content": user_prompt},
        ],
    }
    response = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=180,
    )
    response.raise_for_status()
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    return json.loads(content)


def main():
    parser = argparse.ArgumentParser(description="Run teacher-assisted data distillation for Purple Bee.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--samples-per-block", type=int, default=2)
    args = parser.parse_args()

    config = load_json(Path(args.config))
    source_text = Path(args.source).read_text(encoding="utf-8", errors="replace")
    output_path = Path(args.output)
    status_path = Path(args.status_file)

    write_json(status_path, {
        "running": True,
        "stage": "teacher-request",
        "message": "Teacher distillation running",
        "generated_pairs": 0,
        "last_output_path": str(output_path),
    })

    blocks = split_blocks(source_text)[: max(1, args.limit)]
    pairs = []
    try:
        for index, block in enumerate(blocks, start=1):
            reply = call_openai_compatible(config, build_user_prompt(block, args.samples_per_block))
            for pair in reply.get("pairs", []):
                instruction = str(pair.get("instruction") or "").strip()
                response = str(pair.get("response") or "").strip()
                tags = pair.get("tags") if isinstance(pair.get("tags"), list) else []
                if not instruction or not response:
                    continue
                pairs.append({
                    "instruction": instruction,
                    "response": response,
                    "tags": tags,
                    "source_index": index,
                })
            write_json(status_path, {
                "running": True,
                "stage": "teacher-request",
                "message": f"Teacher distillation block {index}/{len(blocks)}",
                "generated_pairs": len(pairs),
                "last_output_path": str(output_path),
            })

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("w", encoding="utf-8") as handle:
            for pair in pairs:
                handle.write(json.dumps(pair, ensure_ascii=False) + "\n")

        write_json(status_path, {
            "running": False,
            "stage": "complete",
            "message": "Teacher distillation completed",
            "generated_pairs": len(pairs),
            "last_output_path": str(output_path),
        })
        print(json.dumps({
            "pairs_written": len(pairs),
            "output": str(output_path),
        }, ensure_ascii=False))
    except Exception as exc:
        write_json(status_path, {
            "running": False,
            "stage": "error",
            "message": f"Teacher distillation failed: {str(exc)[:160]}",
            "generated_pairs": len(pairs),
            "last_output_path": str(output_path),
        })
        raise


if __name__ == "__main__":
    main()
