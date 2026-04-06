import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CORPORA_DIR = ROOT / "Model" / "corpora"
DEFAULT_BUCKETS = {
    "dialogue_sft": {"source_type": "dialogue_sft", "modality": "text", "split": "train"},
    "knowledge_text": {"source_type": "knowledge_text", "modality": "text", "split": "train"},
    "teacher_distilled": {"source_type": "teacher_distilled", "modality": "text", "split": "train"},
    "eval_holdout": {"source_type": "eval_holdout", "modality": "text", "split": "eval"},
    "image_analysis": {"source_type": "image_analysis", "modality": "image+text", "split": "train"},
    "image_generation": {"source_type": "image_generation", "modality": "text-to-image", "split": "train"},
    "audio_analysis": {"source_type": "audio_analysis", "modality": "audio+text", "split": "train"},
    "music_analysis": {"source_type": "music_analysis", "modality": "music+text", "split": "train"},
    "music_generation": {"source_type": "music_generation", "modality": "text-to-music", "split": "train"},
}

TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv",
    ".yaml", ".yml", ".xml", ".html", ".htm", ".py", ".js", ".ts",
    ".cpp", ".c", ".h", ".hpp", ".java", ".cs", ".go", ".rs", ".sql",
}


def infer_language(path: Path) -> str:
    lowered = str(path).lower()
    if any(token in lowered for token in ["_ko", "-ko", "korean", "kor", "한국", "한글"]):
        return "ko"
    if any(token in lowered for token in ["_en", "-en", "english", "eng"]):
        return "en"
    if any(token in lowered for token in ["_ja", "-ja", "japanese"]):
        return "ja"
    if any(token in lowered for token in ["_zh", "-zh", "chinese"]):
        return "zh"
    return "unknown"


def infer_quality(path: Path) -> str:
    lowered = str(path).lower()
    if "holdout" in lowered or "eval" in lowered:
        return "reviewed"
    if "teacher" in lowered or "synthetic" in lowered:
        return "needs-review"
    return "unscored"


def should_include(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.name.startswith("."):
        return False
    return path.suffix.lower() in TEXT_EXTENSIONS or path.suffix == ""


def build_manifest() -> list[dict]:
    rows = []
    for bucket_name, meta in DEFAULT_BUCKETS.items():
        bucket_dir = CORPORA_DIR / bucket_name
        bucket_dir.mkdir(parents=True, exist_ok=True)
        for path in sorted(bucket_dir.rglob("*")):
            if not should_include(path):
                continue
            rows.append(
                {
                    "id": f"{bucket_name}:{path.relative_to(CORPORA_DIR).as_posix()}",
                    "path": str(path.relative_to(ROOT)).replace("\\", "/"),
                    "bucket": bucket_name,
                    "source_type": meta["source_type"],
                    "modality": meta["modality"],
                    "split": meta["split"],
                    "language": infer_language(path),
                    "quality": infer_quality(path),
                    "synthetic": "teacher" in bucket_name,
                    "approved_for_training": meta["split"] == "train",
                    "approved_for_eval": meta["split"] == "eval",
                }
            )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Purple Bee corpus manifest")
    parser.add_argument(
        "--output",
        default=str(CORPORA_DIR / "manifest.jsonl"),
        help="Output manifest path",
    )
    args = parser.parse_args()

    rows = build_manifest()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(json.dumps({"output": str(output_path), "rows": len(rows)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
