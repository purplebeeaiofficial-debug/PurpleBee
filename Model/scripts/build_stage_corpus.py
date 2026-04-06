import argparse
import json
import random
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODEL_ROOT = ROOT / "Model"
SFT_DIR = MODEL_ROOT / "corpora" / "dialogue_sft"
SAFE_DIALOGUE_SOURCE_NAMES = {
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
    "krdict_augmented_ko.jsonl",
    "reasoning_seed_ko.jsonl",
    "regression_anchor_ko.jsonl",
}
SAFE_TEXT_SOURCE_PATHS = ()
SEED = 20260405


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


ROLE_PREFIX_PATTERN = re.compile(
    r"^(?:user|assistant|purple bee)\s*:\s*",
    re.IGNORECASE,
)
ROLE_TURN_PATTERN = re.compile(
    r"\n+\s*(?:user|assistant|purple bee)\s*:\s*",
    re.IGNORECASE,
)


def strip_role_prefixes(text: str) -> str:
    value = normalize_text(text)
    while True:
        updated = ROLE_PREFIX_PATTERN.sub("", value).strip()
        if updated == value:
            return value
        value = updated


def sanitize_dialogue_text(text: str) -> str:
    value = strip_role_prefixes(text)
    parts = ROLE_TURN_PATTERN.split(value, maxsplit=1)
    return normalize_text(parts[0] if parts else value)


def signature(text: str) -> str:
    return re.sub(r"\s+", " ", normalize_text(text)).lower()


def discover_text_sources():
    return [path for path in SAFE_TEXT_SOURCE_PATHS if path.exists()]


def read_jsonl(path: Path):
    rows = []
    for raw_line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            rows.append(json.loads(raw_line))
        except json.JSONDecodeError:
            continue
    return rows


def iter_text_blocks(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    for block in re.split(r"\n{2,}", text):
        cleaned = normalize_text(block)
        if len(cleaned) < 20:
            continue
        if looks_mojibake_text(cleaned):
            continue
        if "\ufffd" in cleaned:
            continue
        yield cleaned


def render_dialogue(row: dict) -> str:
    user_text = sanitize_dialogue_text(row.get("input", ""))
    response_text = sanitize_dialogue_text(row.get("response", "") or row.get("output", ""))
    if not user_text or not response_text:
        return ""
    if looks_mojibake_text(user_text) or looks_mojibake_text(response_text):
        return ""
    return f"User: {user_text}\nAssistant: {response_text}"


def source_weight(path: Path, row: dict | None = None) -> int:
    name = path.name.lower()
    tags = {str(tag).lower() for tag in (row or {}).get("tags", [])}
    weight = 1

    if "chat_quality_pack" in name:
        weight += 5
    if "reasoning_seed" in name:
        weight += 3

    if {"smalltalk", "conversation", "natural"} & tags:
        weight += 2
    if {"repair", "style", "preference", "followup"} & tags:
        weight += 2
    if {"ability", "coding", "tool"} & tags:
        weight += 1
    if {"knowledge", "definition"} & tags:
        weight += 1
    if {"emotion", "empathy"} & tags:
        weight += 1

    return max(1, min(weight, 8))


def text_source_weight(path: Path, block: str) -> int:
    name = path.name.lower()
    weight = 1
    if "purple_bee_public_dialogues" in name:
        weight += 2
    if "purple_bee_seed_v1" in name:
        weight += 2
    if "deep-research-report" in name:
        weight += 1
    if "wikipedia_random_ko" in name:
        weight += 1
    if len(block) > 300:
        weight += 1
    return max(1, min(weight, 4))


def iter_safe_sources():
    for path in sorted(SFT_DIR.glob("*.jsonl")):
        if path.name not in SAFE_DIALOGUE_SOURCE_NAMES:
            continue
        yield path


def collect_sft_blocks():
    report = {
        "jsonl_sources": {},
        "text_sources": {},
        "raw_blocks": 0,
        "weighted_blocks": 0,
    }
    seen = set()
    blocks = []

    for path in iter_safe_sources():
        kept = 0
        weighted = 0
        for row in read_jsonl(path):
            rendered = render_dialogue(row)
            if not rendered:
                continue
            key = signature(rendered)
            if key in seen:
                continue
            seen.add(key)
            kept += 1
            repeat = source_weight(path, row)
            weighted += repeat
            for _ in range(repeat):
                blocks.append(rendered)
        report["jsonl_sources"][path.name] = {"kept": kept, "weighted": weighted}

    for path in discover_text_sources():
        kept = 0
        weighted = 0
        for block in iter_text_blocks(path):
            key = signature(block)
            if key in seen:
                continue
            seen.add(key)
            kept += 1
            repeat = text_source_weight(path, block)
            weighted += repeat
            for _ in range(repeat):
                blocks.append(block)
        report["text_sources"][path.name] = {"kept": kept, "weighted": weighted}

    report["raw_blocks"] = len(seen)
    report["weighted_blocks"] = len(blocks)
    return blocks, report


def main():
    parser = argparse.ArgumentParser(description="Build a weighted stage corpus for Purple Bee 100M.")
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", default="")
    parser.add_argument("--manual-text", default="")
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()

    blocks, report = collect_sft_blocks()
    manual_text = normalize_text(args.manual_text)
    if manual_text and not looks_mojibake_text(manual_text):
        blocks.extend([manual_text] * 3)
        report["manual_text"] = {"weighted": 3, "characters": len(manual_text)}
    else:
        report["manual_text"] = {"weighted": 0, "characters": 0}

    rng = random.Random(args.seed)
    rng.shuffle(blocks)

    output_text = "\n\n".join(blocks).strip()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(output_text, encoding="utf-8")

    tag_counts = Counter()
    for path in iter_safe_sources():
        for row in read_jsonl(path):
            for tag in row.get("tags", []):
                tag_counts[str(tag).lower()] += 1

    report["output"] = str(output_path)
    report["characters"] = len(output_text)
    report["paragraphs"] = len([part for part in output_text.split("\n\n") if part.strip()])
    report["tag_counts"] = dict(sorted(tag_counts.items()))

    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=True, indent=2), encoding="utf-8")

    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
