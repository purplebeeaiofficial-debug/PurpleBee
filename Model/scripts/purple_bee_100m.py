import json
import math
from dataclasses import dataclass
from pathlib import Path


DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[1] / "configs" / "purple_bee_100m.json"


@dataclass
class PurpleBee100MConfig:
    vocab_size: int = 32000
    hidden_size: int = 768
    intermediate_size: int = 3072
    num_hidden_layers: int = 12
    num_attention_heads: int = 12
    max_position_embeddings: int = 2048
    layer_norm_epsilon: float = 1e-5
    resid_dropout: float = 0.1
    attn_dropout: float = 0.1
    tie_word_embeddings: bool = True


def config_from_blueprint(data):
    model_config = data.get("config", {})
    return PurpleBee100MConfig(**model_config)


def load_blueprint(path=None):
    config_path = Path(path) if path else DEFAULT_CONFIG_PATH
    data = json.loads(config_path.read_text(encoding="utf-8"))
    config = config_from_blueprint(data)
    return data, config


def estimate_parameter_count(config: PurpleBee100MConfig) -> int:
    embed = config.vocab_size * config.hidden_size
    positional = config.max_position_embeddings * config.hidden_size
    attention = config.num_hidden_layers * (4 * config.hidden_size * config.hidden_size + 4 * config.hidden_size)
    mlp = config.num_hidden_layers * (
        2 * config.hidden_size * config.intermediate_size
        + config.intermediate_size
        + config.hidden_size
    )
    norms = config.num_hidden_layers * (4 * config.hidden_size) + 2 * config.hidden_size
    lm_head = 0 if config.tie_word_embeddings else config.hidden_size * config.vocab_size
    return embed + positional + attention + mlp + norms + lm_head


def backend_summary():
    try:
        import torch

        return {
            "torch_available": True,
            "device": "cuda" if torch.cuda.is_available() else "cpu",
            "cuda_available": bool(torch.cuda.is_available()),
        }
    except Exception:
        return {
            "torch_available": False,
            "device": "unavailable",
            "cuda_available": False,
        }


try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except Exception:
    torch = None
    nn = None
    F = None


if torch is not None:
    class CausalSelfAttention(nn.Module):
        def __init__(self, config: PurpleBee100MConfig):
            super().__init__()
            if config.hidden_size % config.num_attention_heads != 0:
                raise ValueError("hidden_size must be divisible by num_attention_heads")
            self.num_heads = config.num_attention_heads
            self.head_dim = config.hidden_size // config.num_attention_heads
            self.qkv = nn.Linear(config.hidden_size, config.hidden_size * 3)
            self.proj = nn.Linear(config.hidden_size, config.hidden_size)
            self.attn_dropout = nn.Dropout(config.attn_dropout)
            self.resid_dropout = nn.Dropout(config.resid_dropout)

        def forward(self, x):
            batch_size, seq_len, hidden = x.shape
            qkv = self.qkv(x)
            qkv = qkv.view(batch_size, seq_len, 3, self.num_heads, self.head_dim)
            qkv = qkv.permute(2, 0, 3, 1, 4)
            q, k, v = qkv[0], qkv[1], qkv[2]
            scores = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
            mask = torch.triu(
                torch.ones(seq_len, seq_len, device=x.device, dtype=torch.bool),
                diagonal=1,
            )
            scores = scores.masked_fill(mask, float("-inf"))
            weights = F.softmax(scores, dim=-1)
            weights = self.attn_dropout(weights)
            attended = weights @ v
            attended = attended.transpose(1, 2).contiguous().view(batch_size, seq_len, hidden)
            return self.resid_dropout(self.proj(attended))


    class FeedForward(nn.Module):
        def __init__(self, config: PurpleBee100MConfig):
            super().__init__()
            self.fc = nn.Linear(config.hidden_size, config.intermediate_size)
            self.proj = nn.Linear(config.intermediate_size, config.hidden_size)
            self.dropout = nn.Dropout(config.resid_dropout)

        def forward(self, x):
            x = self.fc(x)
            x = F.gelu(x)
            x = self.proj(x)
            return self.dropout(x)


    class DecoderBlock(nn.Module):
        def __init__(self, config: PurpleBee100MConfig):
            super().__init__()
            self.ln_1 = nn.LayerNorm(config.hidden_size, eps=config.layer_norm_epsilon)
            self.attn = CausalSelfAttention(config)
            self.ln_2 = nn.LayerNorm(config.hidden_size, eps=config.layer_norm_epsilon)
            self.mlp = FeedForward(config)

        def forward(self, x):
            x = x + self.attn(self.ln_1(x))
            x = x + self.mlp(self.ln_2(x))
            return x


    class PurpleBee100MModel(nn.Module):
        def __init__(self, config: PurpleBee100MConfig):
            super().__init__()
            self.config = config
            self.token_embeddings = nn.Embedding(config.vocab_size, config.hidden_size)
            self.position_embeddings = nn.Embedding(config.max_position_embeddings, config.hidden_size)
            self.dropout = nn.Dropout(config.resid_dropout)
            self.blocks = nn.ModuleList([DecoderBlock(config) for _ in range(config.num_hidden_layers)])
            self.final_norm = nn.LayerNorm(config.hidden_size, eps=config.layer_norm_epsilon)
            self.lm_head = nn.Linear(config.hidden_size, config.vocab_size, bias=False)
            if config.tie_word_embeddings:
                self.lm_head.weight = self.token_embeddings.weight

        def forward(self, input_ids, labels=None):
            batch_size, seq_len = input_ids.shape
            positions = torch.arange(0, seq_len, device=input_ids.device).unsqueeze(0).expand(batch_size, seq_len)
            x = self.token_embeddings(input_ids) + self.position_embeddings(positions)
            x = self.dropout(x)
            for block in self.blocks:
                x = block(x)
            x = self.final_norm(x)
            logits = self.lm_head(x)

            if labels is None:
                return logits, None

            loss = F.cross_entropy(
                logits.contiguous().view(-1, logits.size(-1)),
                labels.contiguous().view(-1),
            )
            return logits, loss


def build_model(config: PurpleBee100MConfig):
    if torch is None:
        raise RuntimeError("PyTorch is not installed.")
    return PurpleBee100MModel(config)


def count_torch_parameters(model) -> int:
    return sum(param.numel() for param in model.parameters())


def load_checkpoint(checkpoint_path, device="cpu"):
    if torch is None:
        raise RuntimeError("PyTorch is not installed.")
    checkpoint = torch.load(checkpoint_path, map_location=device)
    blueprint = checkpoint.get("config", {})
    config = config_from_blueprint(blueprint)
    model = build_model(config).to(device)
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return checkpoint, blueprint, config, model


if __name__ == "__main__":
    blueprint, config = load_blueprint()
    estimate = estimate_parameter_count(config)
    backend = backend_summary()
    print(json.dumps({
        "model_name": blueprint.get("name", "Purple Bee 100M"),
        "estimated_parameters": estimate,
        "backend": backend,
    }, ensure_ascii=False, indent=2))
