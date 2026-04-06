import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE_ROOT = ROOT / "Model" / "corpora" / "knowledge_text"
DEFAULT_OUTPUT = ROOT / "Model" / "corpora" / "dialogue_sft" / "knowledge_grounded_ko.jsonl"
TEXT_SUFFIXES = {".txt", ".md", ".rst"}


def normalize_text(text: str) -> str:
    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def cleanup_title(title: str) -> str:
    value = normalize_text(title).strip("# ").strip()
    value = re.sub(r"\s+", " ", value)
    suffixes = [
        " 요약",
        " 메모",
        " summary",
        " Summary",
        " integration",
        " Integration",
        " report",
        " Report",
        " note",
        " Note",
    ]
    for suffix in suffixes:
        if value.endswith(suffix) and len(value) > len(suffix) + 1:
            value = value[: -len(suffix)].strip()
    return value


def looks_mojibake_text(text: str) -> bool:
    cleaned = normalize_text(text)
    if not cleaned:
        return False
    compatibility = len(re.findall(r"[\uF900-\uFAFF]", cleaned))
    prefixed_question_marks = len(re.findall(r"\?[\uAC00-\uD7A3A-Za-z\u3040-\u30ff\u4e00-\u9fff]", cleaned))
    return "\ufffd" in cleaned or compatibility >= 2 or prefixed_question_marks >= 2 or (compatibility + prefixed_question_marks) >= 3


def extract_title(path: Path, text: str) -> str:
    for line in normalize_text(text).splitlines():
        stripped = line.strip("# ").strip()
        if len(stripped) >= 2:
            return cleanup_title(stripped)
    return cleanup_title(path.stem.replace("_", " ").replace("-", " ").strip())


def iter_source_files():
    if not KNOWLEDGE_ROOT.exists():
        return
    for path in sorted(KNOWLEDGE_ROOT.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if path.name.lower().startswith("readme"):
            continue
        yield path


def first_good_paragraphs(text: str, limit: int = 2):
    paragraphs = []
    for block in normalize_text(text).split("\n\n"):
        cleaned = normalize_text(block)
        if len(cleaned) < 60:
            continue
        if looks_mojibake_text(cleaned):
            continue
        paragraphs.append(cleaned)
        if len(paragraphs) >= limit:
            break
    return paragraphs


def make_rows(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    if looks_mojibake_text(text):
        return []
    title = extract_title(path, text)
    paragraphs = first_good_paragraphs(text, limit=2)
    if not title or not paragraphs:
        return []
    source_label = path.relative_to(KNOWLEDGE_ROOT).as_posix()
    title_variants = [title]
    title_parts = title.split()
    if len(title_parts) >= 2:
        lead = title_parts[0].strip()
        if len(lead) >= 2:
            title_variants.append(lead)
    if re.fullmatch(r"[가-힣A-Za-z0-9 ]+", title):
        if not title.endswith("이") and not title.endswith("가"):
            title_variants.append(f"{title}이")
        if not title.endswith("는"):
            title_variants.append(f"{title}는")

    rows = []
    for variant in dict.fromkeys(title_variants):
        rows.extend(
            [
                {
                    "instruction": "제목과 배경 지식을 바탕으로 핵심 정의를 짧고 자연스럽게 설명한다.",
                    "input": f"{variant} 뭐야",
                    "response": paragraphs[0],
                    "tags": ["knowledge", "definition", "grounded"],
                    "language": "ko",
                    "reward_weight": 14,
                    "source_file": "knowledge_grounded_ko.jsonl",
                    "source_doc": source_label,
                },
                {
                    "instruction": "제목과 배경 지식을 바탕으로 핵심 정의를 짧고 자연스럽게 설명한다.",
                    "input": f"{variant} 알아?",
                    "response": paragraphs[0],
                    "tags": ["knowledge", "definition", "grounded"],
                    "language": "ko",
                    "reward_weight": 13,
                    "source_file": "knowledge_grounded_ko.jsonl",
                    "source_doc": source_label,
                },
                {
                    "instruction": "글의 핵심을 짧게 요약해서 설명한다.",
                    "input": f"{variant} 핵심만 요약해줘",
                    "response": paragraphs[0],
                    "tags": ["knowledge", "summary", "grounded"],
                    "language": "ko",
                    "reward_weight": 12,
                    "source_file": "knowledge_grounded_ko.jsonl",
                    "source_doc": source_label,
                },
            ]
        )
    if len(paragraphs) > 1:
        for variant in dict.fromkeys(title_variants):
            rows.append(
                {
                    "instruction": "한 문단을 더 참고해 조금 더 자세히 설명한다.",
                    "input": f"{variant} 조금 더 자세히 알려줘",
                    "response": f"{paragraphs[0]} {paragraphs[1]}",
                    "tags": ["knowledge", "explanation", "grounded"],
                    "language": "ko",
                    "reward_weight": 12,
                    "source_file": "knowledge_grounded_ko.jsonl",
                    "source_doc": source_label,
                }
            )
    return rows


def main():
    parser = argparse.ArgumentParser(description="Build grounded SFT rows from local knowledge text sources.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    rows = []
    seen = set()
    for path in iter_source_files():
        for row in make_rows(path):
            key = (row["input"], row["response"])
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)

    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(json.dumps({"output": str(output_path), "rows": len(rows)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
