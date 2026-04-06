import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SFT_DIR = ROOT / "Model" / "corpora" / "dialogue_sft"
SAFE_SOURCE_NAMES = {
    "basic_dialogue_variants_ko.jsonl",
    "chat_quality_pack_ko.jsonl",
    "conversation_core_ko.jsonl",
    "conversation_natural_ko.jsonl",
    "curriculum_chat_ko.jsonl",
    "curriculum_knowledge_ko.jsonl",
    "dialogue_followup_repair_ko.jsonl",
    "dialogue_rebuild_core_ko.jsonl",
    "everyday_chat_ko.jsonl",
    "foundation_chat_ko.jsonl",
    "instruction_seed_ko.jsonl",
    "instruction_social_ko.jsonl",
    "knowledge_grounded_ko.jsonl",
    "krdict_augmented_ko.jsonl",
    "reasoning_seed_ko.jsonl",
    "regression_anchor_ko.jsonl",
}
SKIP_OUTPUT_NAMES = {
    "purple_bee_sft_dataset.jsonl",
    "purple_bee_sft_dataset_clean.jsonl",
}


def normalize_text(text: str) -> str:
    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def looks_mojibake_text(text: str) -> bool:
    cleaned = normalize_text(text)
    if not cleaned:
        return False
    compatibility = len(re.findall(r"[\uF900-\uFAFF]", cleaned))
    prefixed_question_marks = len(re.findall(r"\?[\uAC00-\uD7A3A-Za-z\u3040-\u30ff\u4e00-\u9fff]", cleaned))
    return "\ufffd" in cleaned or compatibility >= 2 or prefixed_question_marks >= 2 or (compatibility + prefixed_question_marks) >= 3


def read_jsonl(path: Path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def infer_stage(path: Path) -> str:
    name = path.stem.lower()
    if "reason" in name or "think" in name:
        return "reasoning"
    if "instruct" in name or "sft" in name:
        return "instruction"
    return "dialogue"


def build_target_text(row: dict) -> str:
    user_input = normalize_text(row.get("input", ""))
    response = normalize_text(row.get("response", "") or row.get("output", ""))
    parts = []
    if user_input:
        parts.append(f"User: {user_input}")
    if response:
        parts.append(f"Assistant: {response}")
    return "\n".join(parts).strip()


def is_usable_row(row: dict) -> bool:
    input_text = normalize_text(row.get("input", ""))
    response_text = normalize_text(row.get("response", "") or row.get("output", ""))
    instruction = normalize_text(row.get("instruction", ""))
    thinking = normalize_text(row.get("thinking", ""))
    if not input_text or not response_text:
        return False
    if len(input_text) < 1 or len(response_text) < 4:
        return False
    for value in (instruction, input_text, thinking, response_text):
        if looks_mojibake_text(value):
            return False
    return True


def iter_safe_sources():
    for path in sorted(SFT_DIR.glob("*.jsonl")):
        if path.name in SKIP_OUTPUT_NAMES:
            continue
        if path.name not in SAFE_SOURCE_NAMES:
            continue
        yield path


def build_rows():
    rows = []
    seen = set()
    for path in iter_safe_sources():
        for row in read_jsonl(path):
            if not is_usable_row(row):
                continue
            normalized = {
                "source_file": path.name,
                "stage": infer_stage(path),
                "instruction": normalize_text(row.get("instruction", "")),
                "input": normalize_text(row.get("input", "")),
                "thinking": normalize_text(row.get("thinking", "")),
                "response": normalize_text(row.get("response", "") or row.get("output", "")),
                "tags": list(row.get("tags", [])),
                "language": row.get("language", "unknown"),
                "reward_weight": row.get("reward_weight"),
                "quality": row.get("quality"),
            }
            normalized["target_text"] = build_target_text(normalized)
            if not normalized["target_text"]:
                continue
            dedupe_key = (
                normalized["input"].lower(),
                normalized["response"].lower(),
            )
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            rows.append(normalized)
    return rows


def main():
    parser = argparse.ArgumentParser(description="Build clean Purple Bee SFT dataset")
    parser.add_argument(
        "--output",
        default=str(SFT_DIR / "purple_bee_sft_dataset_clean.jsonl"),
        help="Output JSONL path",
    )
    args = parser.parse_args()

    rows = build_rows()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")

    print(json.dumps({"output": str(output_path), "rows": len(rows)}, ensure_ascii=True))


if __name__ == "__main__":
    main()
