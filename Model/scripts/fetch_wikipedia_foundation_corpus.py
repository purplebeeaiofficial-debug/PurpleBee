import argparse
import json
import random
import time
from pathlib import Path

import requests


API_URL = "https://ko.wikipedia.org/api/rest_v1/page/random/summary"
HEADERS = {
    "User-Agent": "PurpleBeeFoundationCorpusBuilder/1.0 (https://purple-bee.local)",
    "Accept": "application/json",
}


def normalize_text(text: str) -> str:
    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    return "\n".join(lines).strip()


def fetch_random_summary(session: requests.Session, timeout: int = 15):
    response = session.get(API_URL, headers=HEADERS, timeout=timeout)
    response.raise_for_status()
    payload = json.loads(response.content.decode("utf-8", errors="replace"))
    title = normalize_text(payload.get("title", ""))
    extract = normalize_text(payload.get("extract", ""))
    if not title or not extract:
        return None
    if len(extract) < 80:
        return None
    if payload.get("type") in {"disambiguation"}:
        return None
    return {
        "title": title,
        "extract": extract,
        "url": payload.get("content_urls", {}).get("desktop", {}).get("page", ""),
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch a Korean Wikipedia foundation corpus for Purple Bee.")
    parser.add_argument("--count", type=int, default=200)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", default="")
    parser.add_argument("--delay-ms", type=int, default=120)
    args = parser.parse_args()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_path = Path(args.report) if args.report else None

    session = requests.Session()
    seen_titles = set()
    blocks = []
    failures = 0

    target_count = max(1, int(args.count))
    max_attempts = max(target_count * 6, 50)

    for _attempt in range(max_attempts):
        if len(blocks) >= target_count:
            break
        try:
            item = fetch_random_summary(session)
        except Exception:
            failures += 1
            time.sleep(max(0, args.delay_ms) / 1000)
            continue
        if not item:
            failures += 1
            time.sleep(max(0, args.delay_ms) / 1000)
            continue
        title = item["title"]
        if title in seen_titles:
            continue
        seen_titles.add(title)
        blocks.append(f"{title}\n{item['extract']}")
        time.sleep(max(0, args.delay_ms) / 1000)

    output_text = "\n\n".join(blocks).strip()
    output_path.write_text(output_text, encoding="utf-8")

    report = {
        "output": str(output_path),
        "target_count": target_count,
        "written_count": len(blocks),
        "failures": failures,
        "characters": len(output_text),
    }
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
