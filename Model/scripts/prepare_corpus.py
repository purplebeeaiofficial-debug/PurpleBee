import argparse
import json
import re
from pathlib import Path


LOW_QUALITY_MARKERS = [
    "localhost server inference",
    "question core",
    "at a glance",
    "disambiguation",
    "official google ai news and updates",
]

LOW_QUALITY_REGEXES = [
    re.compile(r"turn\d+(?:search|view|fetch)\d+", re.IGNORECASE),
    re.compile(r"[]cite", re.IGNORECASE),
    re.compile(r"<\|[^>\n]{0,40}\|>"),
]


def normalize_text(text: str) -> str:
    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def signature(text: str) -> str:
    return re.sub(r"\s+", " ", normalize_text(text)).lower()


def repeated_line_ratio(text: str) -> float:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return 0.0
    return 1.0 - (len(set(lines)) / len(lines))


def looks_broken_spacing(text: str) -> bool:
    return bool(
        re.search(r"(?:[A-Za-z]\s+){6,}[A-Za-z]", text)
        or re.search(r"(?:[\uac00-\ud7af]\s+){6,}[\uac00-\ud7af]", text)
    )


def looks_structural_leak(text: str) -> bool:
    lowered = text.lower()
    if any(marker in lowered for marker in LOW_QUALITY_MARKERS):
        return True
    return any(pattern.search(text) for pattern in LOW_QUALITY_REGEXES)


def looks_low_quality_text(text: str) -> bool:
    cleaned = normalize_text(text)
    if len(cleaned) < 8:
        return True
    if looks_structural_leak(cleaned):
        return True
    if looks_broken_spacing(cleaned):
        return True
    if repeated_line_ratio(cleaned) > 0.35:
        return True
    if re.search(r"(.)\1{6,}", cleaned):
        return True
    if len(re.findall(r"https?://|www\.", cleaned.lower())) >= 2:
        return True
    if cleaned.count("Assistant:") > 4 or cleaned.count("User:") > 4:
        return True
    tokens = cleaned.split()
    if tokens:
        single_ratio = sum(1 for token in tokens if len(token) == 1) / len(tokens)
        if len(tokens) >= 12 and single_ratio > 0.34:
            return True
    return False


def render_chat_example(row: dict) -> str:
    if row.get("target_text"):
        return normalize_text(row["target_text"])

    user_input = normalize_text(row.get("input", ""))
    response = normalize_text(row.get("response", "") or row.get("output", ""))
    text = normalize_text(row.get("text", "") or row.get("content", ""))

    if user_input and response:
        return f"User: {user_input}\nAssistant: {response}"
    if text:
        return text
    return ""


def read_jsonl_source(path: Path) -> list[str]:
    blocks: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        rendered = render_chat_example(row)
        if rendered and not looks_low_quality_text(rendered):
            blocks.append(rendered)
    return blocks


def read_source(path: Path) -> str:
    if path.suffix.lower() == ".jsonl":
        return "\n\n".join(read_jsonl_source(path))
    return path.read_text(encoding="utf-8", errors="replace")


def build_clean_corpus(inputs: list[str]) -> str:
    merged_blocks = []
    for source in inputs:
        path = Path(source)
        if path.exists():
            merged_blocks.append(read_source(path))

    seen = set()
    paragraphs = []
    for block in merged_blocks:
        for chunk in re.split(r"\n{2,}", normalize_text(block)):
            cleaned = normalize_text(chunk)
            if len(cleaned) < 20:
                continue
            if looks_low_quality_text(cleaned):
                continue
            key = signature(cleaned)
            if key in seen:
                continue
            seen.add(key)
            paragraphs.append(cleaned)
    return "\n\n".join(paragraphs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", nargs="+", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    normalized = build_clean_corpus(args.inputs)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(normalized, encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "characters": len(normalized),
        "paragraphs": len([p for p in normalized.split("\n\n") if p.strip()]),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
