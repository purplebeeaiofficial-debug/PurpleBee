import argparse
import json
from pathlib import Path


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Build a browser runtime manifest for Purple Bee model assets.")
    parser.add_argument("--registry", required=True, help="Path to Model/registry.json")
    parser.add_argument("--model-id", required=True, help="Model id such as purple-bee-1-3")
    parser.add_argument("--output", required=True, help="Where to write the manifest JSON")
    parser.add_argument("--onnx", default="", help="Optional ONNX model relative path")
    parser.add_argument("--onnx-data", default="", help="Optional ONNX external data relative path")
    parser.add_argument("--tokenizer", default="", help="Optional tokenizer relative path")
    args = parser.parse_args()

    registry = load_json(Path(args.registry))
    models = registry.get("models", [])
    model = next((item for item in models if item.get("id") == args.model_id), None)
    if not model:
        raise SystemExit(f"Model id not found in registry: {args.model_id}")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    manifest = {
        "family_name": registry.get("family_name", "Purple Bee"),
        "model_id": model.get("id"),
        "display_name": model.get("display_name", model.get("id")),
        "version": model.get("version"),
        "architecture_name": model.get("architecture_name"),
        "target_params": model.get("target_params"),
        "actual_params_estimate": model.get("actual_params_estimate"),
        "pipeline_stage": model.get("pipeline_stage"),
        "pipeline_message": model.get("pipeline_message"),
        "browser_assets": {
            "onnx": args.onnx or None,
            "onnx_data": args.onnx_data or None,
            "tokenizer": args.tokenizer or None,
        },
        "runtime": {
            "provider_preference": ["webgpu", "wasm"],
            "max_context": 2048,
        },
    }
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
