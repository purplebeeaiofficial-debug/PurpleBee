import argparse
import json
import shutil
from pathlib import Path

from onnxruntime.quantization import QuantType, quantize_dynamic


def first_match(directory: Path, pattern: str):
    return next(iter(sorted(directory.glob(pattern))), None)


def ensure_clean_dir(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    for child in directory.iterdir():
        if child.is_file():
            child.unlink()
        elif child.is_dir():
            shutil.rmtree(child)


def artifact_info(path: Path | None):
    if not path or not path.exists():
        return {"path": "", "size": 0}
    return {"path": str(path), "size": path.stat().st_size}


def build_manifest(display_name: str, model_id: str, onnx_name: str, tokenizer_name: str, onnx_data_name: str, max_context: int):
    return {
        "family_name": "Purple Bee",
        "model_id": model_id,
        "display_name": display_name,
        "browser_assets": {
            "onnx": onnx_name,
            "tokenizer": tokenizer_name,
            "onnx_data": onnx_data_name or None,
        },
        "runtime": {
            "provider_preference": ["wasm"],
            "max_context": max_context,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Package a Purple Bee browser runtime bundle.")
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--display-name", required=True)
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--public-base-url", default="")
    parser.add_argument("--safe-limit", type=int, default=25 * 1024 * 1024)
    parser.add_argument("--skip-quantize", action="store_true")
    parser.add_argument("--prefer-quantize", action="store_true")
    parser.add_argument("--max-context", type=int, default=2048)
    args = parser.parse_args()

    source_dir = Path(args.source_dir)
    output_dir = Path(args.output_dir)
    ensure_clean_dir(output_dir)

    source_onnx = first_match(source_dir, "*.onnx")
    if source_onnx is None:
      raise SystemExit("Source ONNX file is missing.")
    source_tokenizer = first_match(source_dir, "*tokenizer*.json") or (source_dir / "tokenizer.json")
    if not source_tokenizer.exists():
      raise SystemExit("Source tokenizer JSON is missing.")

    packaged_onnx = output_dir / f"{source_onnx.stem}-int8.onnx"
    quantized = False
    quantize_error = ""

    if args.prefer_quantize and not args.skip_quantize:
        try:
            quantize_dynamic(
                str(source_onnx),
                str(packaged_onnx),
                weight_type=QuantType.QInt8,
                per_channel=True,
            )
            quantized = packaged_onnx.exists()
        except Exception as exc:
            quantize_error = str(exc)

    if not quantized:
        packaged_onnx = output_dir / source_onnx.name
        shutil.copy2(source_onnx, packaged_onnx)
        source_onnx_data = first_match(source_dir, "*.onnx.data")
        if source_onnx_data and source_onnx_data.exists():
            shutil.copy2(source_onnx_data, output_dir / source_onnx_data.name)

    tokenizer_target = output_dir / "tokenizer.json"
    shutil.copy2(source_tokenizer, tokenizer_target)

    packaged_onnx_data = first_match(output_dir, "*.onnx.data")
    manifest = build_manifest(
        args.display_name,
        args.model_id,
        packaged_onnx.name,
        tokenizer_target.name,
        packaged_onnx_data.name if packaged_onnx_data else "",
        args.max_context,
    )
    (output_dir / "browser-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    public_base_url = args.public_base_url.rstrip("/")
    largest_file = max(
        [
            packaged_onnx.stat().st_size if packaged_onnx.exists() else 0,
            packaged_onnx_data.stat().st_size if packaged_onnx_data and packaged_onnx_data.exists() else 0,
            tokenizer_target.stat().st_size if tokenizer_target.exists() else 0,
        ]
    )
    recommended_storage = "workers-static-assets" if largest_file <= args.safe_limit else "r2-or-public-object-storage"
    report = {
        "model_id": args.model_id,
        "display_name": args.display_name,
        "output_dir": str(output_dir),
        "quantized": quantized,
        "quantize_error": quantize_error,
        "safe_limit": args.safe_limit,
        "recommended_storage": recommended_storage,
        "public_base_url": public_base_url,
        "artifacts": {
            "onnx": artifact_info(packaged_onnx),
            "onnx_data": artifact_info(packaged_onnx_data),
            "tokenizer": artifact_info(tokenizer_target),
            "manifest": artifact_info(output_dir / "browser-manifest.json"),
        },
    }
    (output_dir / "package-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
