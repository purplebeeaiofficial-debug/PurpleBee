# Purple Bee Model Workspace

`Model/` is the local model workspace used on the management computer.

## Main structure

- `registry.json`
  Stores the current model, latest model, and version list.
- `configs/purple_bee_100m.json`
  Base blueprint for the planned 100M-class transformer.
- `scripts/purple_bee_100m.py`
  Parameter estimator and optional PyTorch model definition.
- `scripts/train_100m.py`
  Offline 100M pipeline entry point. Supports dry-run and bootstrap training.
- `scripts/prepare_corpus.py`
  Cleans and merges local text sources into a corpus file.
- `versions/<model-id>/artifacts/`
  Local runtime artifacts used by the current lightweight runtime.
- `versions/<model-id>/browser_assets/`
  Browser-side static assets copied with each model version.
- `versions/<model-id>/training/`
  100M pipeline files for that version:
  `architecture.json`, `pipeline_status.json`, `corpus_snapshot.txt`, `checkpoints/`

## Rules

- New versions are always cloned from the latest version.
- Only the model that is both `current` and `latest` can be trained.
- The lightweight browser/runtime model and the planned 100M offline model are tracked separately.
- The model panel lives at `http://localhost:7860/model-panel`.

## Launchers

- `D:\Purple Bee AI\Purple_Bee_Model_Panel.bat`
- `D:\Purple Bee AI\Purple_Bee_모델패널.bat`
