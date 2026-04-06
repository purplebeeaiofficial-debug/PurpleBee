import json
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path


SPECIAL_TOKENS = ["<pad>", "<bos>", "<eos>", "<unk>"]
TOKEN_PATTERN = re.compile(
    r"\n|[ \t]+|[\uac00-\ud7af]+|[\u3040-\u30ff]+|[\u4e00-\u9fff]+|[A-Za-z]+(?:'[A-Za-z]+)?|[0-9]+|[^\w\s]",
    re.UNICODE,
)
LANGUAGE_PATTERNS = {
    "ko": re.compile(r"[\uac00-\ud7af]"),
    "en": re.compile(r"[A-Za-z]"),
    "ja": re.compile(r"[\u3040-\u30ff]"),
    "zh": re.compile(r"[\u4e00-\u9fff]"),
}

try:
    from tokenizers import Tokenizer
    from tokenizers import decoders, models, normalizers, pre_tokenizers, trainers
except Exception:
    Tokenizer = None
    decoders = None
    models = None
    normalizers = None
    pre_tokenizers = None
    trainers = None


def normalize_text(text: str) -> str:
    text = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def pretokenize(text: str):
    normalized = normalize_text(text)
    if not normalized:
        return []
    return TOKEN_PATTERN.findall(normalized)


def _legacy_build_tokenizer(corpus_text: str, vocab_size: int = 32000):
    pieces = pretokenize(corpus_text)
    token_counter = Counter(pieces)
    char_counter = Counter()
    for token in pieces:
        if token in {" ", "\n"}:
            continue
        if len(token) > 1:
            char_counter.update(token)

    vocab = list(SPECIAL_TOKENS)
    max_main_tokens = max(vocab_size - len(SPECIAL_TOKENS), 0)
    for token, _freq in token_counter.most_common(max_main_tokens):
        if token not in vocab:
            vocab.append(token)
        if len(vocab) >= vocab_size:
            break

    if len(vocab) < vocab_size:
        for char, _freq in char_counter.most_common(vocab_size - len(vocab)):
            if char not in vocab:
                vocab.append(char)
            if len(vocab) >= vocab_size:
                break

    stoi = {token: index for index, token in enumerate(vocab)}
    full_piece_hits = sum(freq for token, freq in token_counter.items() if token in stoi)
    total_piece_count = sum(token_counter.values()) or 1
    full_piece_coverage = round(full_piece_hits / total_piece_count, 6)

    return {
        "version": 2,
        "type": "purple-bee-hybrid-tokenizer",
        "vocab_size_limit": vocab_size,
        "vocab": vocab,
        "special_tokens": {token: stoi[token] for token in SPECIAL_TOKENS},
        "stats": {
            "effective_vocab_size": len(vocab),
            "total_pieces": total_piece_count,
            "full_piece_coverage": full_piece_coverage,
        },
    }


def _iter_training_chunks(corpus_text: str):
    normalized = normalize_text(corpus_text)
    if not normalized:
        return []
    chunks = []
    for block in re.split(r"\n{2,}", normalized):
        cleaned = block.strip()
        if cleaned:
            chunks.append(cleaned)
    return chunks or [normalized]


def _build_hf_tokenizer(corpus_text: str, vocab_size: int = 32000):
    tokenizer = Tokenizer(models.BPE(unk_token="<unk>"))
    tokenizer.normalizer = normalizers.Sequence([normalizers.NFKC()])
    tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tokenizer.decoder = decoders.ByteLevel()

    trainer = trainers.BpeTrainer(
        vocab_size=max(len(SPECIAL_TOKENS) + 256, int(vocab_size)),
        special_tokens=SPECIAL_TOKENS,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        show_progress=False,
    )
    tokenizer.train_from_iterator(_iter_training_chunks(corpus_text), trainer=trainer)

    encoded = tokenizer.encode(normalize_text(corpus_text))
    total_piece_count = len(encoded.ids) or 1
    effective_vocab_size = tokenizer.get_vocab_size()
    special_token_ids = {}
    for token in SPECIAL_TOKENS:
        token_id = tokenizer.token_to_id(token)
        if token_id is None:
            raise RuntimeError(f"Tokenizer special token is missing: {token}")
        special_token_ids[token] = int(token_id)

    return {
        "version": 3,
        "type": "purple-bee-bytelevel-bpe",
        "vocab_size_limit": vocab_size,
        "backend": "huggingface-tokenizers",
        "special_tokens": special_token_ids,
        "hf_tokenizer_json": json.loads(tokenizer.to_str()),
        "stats": {
            "effective_vocab_size": effective_vocab_size,
            "total_pieces": total_piece_count,
            "full_piece_coverage": 1.0,
        },
    }


def build_tokenizer(corpus_text: str, vocab_size: int = 32000):
    if Tokenizer is None:
        return _legacy_build_tokenizer(corpus_text, vocab_size=vocab_size)
    return _build_hf_tokenizer(corpus_text, vocab_size=vocab_size)


def load_tokenizer(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_tokenizer(path, tokenizer_data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(tokenizer_data, ensure_ascii=False, indent=2), encoding="utf-8")


@lru_cache(maxsize=8)
def _cached_hf_tokenizer(tokenizer_json_text: str):
    return Tokenizer.from_str(tokenizer_json_text)


def _hf_backend(tokenizer_data):
    payload = tokenizer_data.get("hf_tokenizer_json")
    if not payload:
        raise RuntimeError("Tokenizer payload is missing hf_tokenizer_json.")
    return _cached_hf_tokenizer(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def encode_text(text: str, tokenizer_data, add_bos: bool = False, add_eos: bool = False):
    if tokenizer_data.get("type") == "purple-bee-bytelevel-bpe":
        tokenizer = _hf_backend(tokenizer_data)
        tokens = []
        special = tokenizer_data["special_tokens"]
        if add_bos:
            tokens.append(int(special["<bos>"]))
        tokens.extend(tokenizer.encode(str(text or "")).ids)
        if add_eos:
            tokens.append(int(special["<eos>"]))
        return tokens

    stoi = {token: index for index, token in enumerate(tokenizer_data["vocab"])}
    unk_id = stoi["<unk>"]
    tokens = []
    if add_bos:
        tokens.append(stoi["<bos>"])

    for piece in pretokenize(text):
        if piece in stoi:
            tokens.append(stoi[piece])
            continue
        for char in piece:
            tokens.append(stoi.get(char, unk_id))

    if add_eos:
        tokens.append(stoi["<eos>"])
    return tokens


def decode_ids(ids, tokenizer_data, skip_special: bool = True):
    if tokenizer_data.get("type") == "purple-bee-bytelevel-bpe":
        tokenizer = _hf_backend(tokenizer_data)
        filtered = []
        special_ids = set(tokenizer_data.get("special_tokens", {}).values()) if skip_special else set()
        for index in ids:
            if int(index) in special_ids:
                continue
            filtered.append(int(index))
        return tokenizer.decode(filtered, skip_special_tokens=False).strip()

    vocab = tokenizer_data["vocab"]
    special = set(SPECIAL_TOKENS) if skip_special else set()
    tokens = []
    for index in ids:
        if index < 0 or index >= len(vocab):
            continue
        token = vocab[index]
        if token in special:
            continue
        tokens.append(token)
    return "".join(tokens)


def build_tokenizer_report(corpus_text: str, tokenizer_data) -> dict:
    normalized = normalize_text(corpus_text)
    lines = [line.strip() for line in normalized.splitlines() if line.strip()]
    report = {
        "tokenizer_type": tokenizer_data.get("type", "unknown"),
        "effective_vocab_size": tokenizer_data.get("stats", {}).get("effective_vocab_size", 0),
        "total_pieces": tokenizer_data.get("stats", {}).get("total_pieces", 0),
        "full_piece_coverage": tokenizer_data.get("stats", {}).get("full_piece_coverage", 0.0),
        "languages": {},
    }
    for language, pattern in LANGUAGE_PATTERNS.items():
        samples = [line for line in lines if pattern.search(line)][:400]
        if not samples:
            report["languages"][language] = {
                "samples": 0,
                "avg_tokens_per_sample": 0.0,
            }
            continue
        token_lengths = [len(encode_text(sample, tokenizer_data, add_bos=False, add_eos=False)) for sample in samples]
        report["languages"][language] = {
            "samples": len(samples),
            "avg_tokens_per_sample": round(sum(token_lengths) / max(1, len(token_lengths)), 2),
        }
    return report


if __name__ == "__main__":
    sample = "\uc548\ub155\ud558\uc138\uc694. Purple Bee\uac00 \uc2e4\uc81c 100M \ud30c\ub77c\ubbf8\ud130\uc778\uc9c0 \ud655\uc778\ud569\ub2c8\ub2e4."
    tokenizer = build_tokenizer(sample, vocab_size=128)
    ids = encode_text(sample, tokenizer, add_bos=True, add_eos=True)
    print(json.dumps({
        "tokenizer_type": tokenizer.get("type"),
        "effective_vocab_size": tokenizer["stats"]["effective_vocab_size"],
        "encoded_length": len(ids),
        "decoded": decode_ids(ids, tokenizer),
    }, ensure_ascii=False, indent=2))
