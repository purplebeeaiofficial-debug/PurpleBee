import argparse
import json
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE_ROOT = ROOT / "Model" / "corpora" / "knowledge_text"
TARGET_MAP = {
    "dictionary": KNOWLEDGE_ROOT / "dictionary",
    "literature": KNOWLEDGE_ROOT / "literature",
    "papers": KNOWLEDGE_ROOT / "papers",
    "general": KNOWLEDGE_ROOT / "general",
}
TEXT_SUFFIXES = {".txt", ".md", ".rst"}


def normalize_text(text: str) -> str:
    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^\w가-힣\-\. ]", "_", str(name or "").strip())
    return cleaned[:120] or "imported.txt"


def import_path(source: Path, domain: str) -> dict:
    target_dir = TARGET_MAP[domain]
    target_dir.mkdir(parents=True, exist_ok=True)
    target_name = sanitize_filename(source.name)
    target_path = target_dir / target_name
    shutil.copy2(source, target_path)
    text = normalize_text(target_path.read_text(encoding="utf-8", errors="replace"))
    target_path.write_text(text, encoding="utf-8")
    return {
        "source": str(source),
        "target": str(target_path),
        "characters": len(text),
        "domain": domain,
    }


def import_directory(source_dir: Path, domain: str) -> list[dict]:
    imported = []
    for path in sorted(source_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        imported.append(import_path(path, domain))
    return imported


def main():
    parser = argparse.ArgumentParser(description="Import text knowledge sources into Purple Bee knowledge_text domains.")
    parser.add_argument("--source", required=True, help="File or directory to import")
    parser.add_argument("--domain", choices=sorted(TARGET_MAP.keys()), default="general")
    parser.add_argument("--report", default="")
    args = parser.parse_args()

    source_path = Path(args.source)
    if not source_path.exists():
        raise FileNotFoundError(f"source not found: {source_path}")

    if source_path.is_dir():
        imported = import_directory(source_path, args.domain)
    else:
        imported = [import_path(source_path, args.domain)]

    payload = {
        "domain": args.domain,
        "source": str(source_path),
        "imported": imported,
        "count": len(imported),
    }
    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
