import argparse
import json
from pathlib import Path

from purple_bee_tokenizer import build_tokenizer, normalize_text, save_tokenizer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--vocab-size", type=int, default=32000)
    args = parser.parse_args()

    corpus_path = Path(args.corpus)
    corpus_text = normalize_text(corpus_path.read_text(encoding="utf-8", errors="replace"))
    tokenizer = build_tokenizer(corpus_text, vocab_size=args.vocab_size)
    save_tokenizer(args.output, tokenizer)
    print(json.dumps({
        "output": str(Path(args.output)),
        "effective_vocab_size": tokenizer["stats"]["effective_vocab_size"],
        "coverage": tokenizer["stats"]["full_piece_coverage"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
