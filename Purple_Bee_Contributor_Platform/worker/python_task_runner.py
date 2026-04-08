import json
import re
import sys


def preprocess_text(text: str) -> dict:
    normalized = re.sub(r"\s+", " ", text.strip())
    tokens = normalized.split(" ") if normalized else []
    return {
        "type": "preprocess_text",
        "normalized": normalized,
        "token_count": len(tokens),
    }


def summarize_stub(text: str) -> dict:
    text = re.sub(r"\s+", " ", text.strip())
    words = text.split(" ") if text else []
    summary = " ".join(words[:20])
    return {
        "type": "summarize_stub",
        "summary": summary,
        "source_length": len(words),
    }


def main() -> None:
    payload = json.loads(sys.stdin.read() or "{}")
    task_type = payload.get("type", "")
    task_payload = payload.get("payload", {}) or {}
    text = str(task_payload.get("text", ""))

    if task_type == "preprocess_text":
      result = preprocess_text(text)
    elif task_type == "summarize_stub":
      result = summarize_stub(text)
    else:
      result = {
          "type": task_type,
          "ok": False,
          "error": "unsupported-task-type",
      }

    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
