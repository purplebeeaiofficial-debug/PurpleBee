import argparse
import json
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from purple_bee_100m import load_checkpoint, torch  # noqa: E402
from purple_bee_tokenizer import save_tokenizer  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="Export Purple Bee 100M checkpoint to ONNX for browser/WebGPU preparation.")
    parser.add_argument("--checkpoint", required=True, help="Path to the .pt checkpoint file")
    parser.add_argument("--output", required=True, help="Path to the output ONNX file")
    parser.add_argument("--tokenizer-output", default="", help="Optional path to save tokenizer JSON")
    parser.add_argument("--opset", type=int, default=17, help="ONNX opset version")
    args = parser.parse_args()

    if torch is None:
      raise SystemExit("PyTorch is not available.")

    checkpoint_path = Path(args.checkpoint)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    checkpoint, blueprint, config, model = load_checkpoint(checkpoint_path, device="cpu")
    model.eval()

    dummy_input = torch.randint(
        low=0,
        high=config.vocab_size,
        size=(1, min(32, config.max_position_embeddings)),
        dtype=torch.long,
    )

    torch.onnx.export(
        model,
        (dummy_input,),
        output_path,
        input_names=["input_ids"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "logits": {0: "batch", 1: "sequence"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
    )

    tokenizer_output = args.tokenizer_output.strip()
    if tokenizer_output:
        tokenizer_path = Path(tokenizer_output)
        tokenizer_path.parent.mkdir(parents=True, exist_ok=True)
        save_tokenizer(tokenizer_path, checkpoint.get("tokenizer", {}))

    manifest = {
        "model_name": blueprint.get("name", "Purple Bee 100M"),
        "family": blueprint.get("family", "Purple Bee"),
        "checkpoint": str(checkpoint_path),
        "onnx_path": str(output_path),
        "tokenizer_output": tokenizer_output or None,
        "vocab_size": config.vocab_size,
        "hidden_size": config.hidden_size,
        "num_layers": config.num_hidden_layers,
        "num_heads": config.num_attention_heads,
        "max_position_embeddings": config.max_position_embeddings,
        "tie_word_embeddings": bool(config.tie_word_embeddings),
    }
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
