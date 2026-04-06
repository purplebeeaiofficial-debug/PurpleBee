import importlib.util
import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_PATH = PROJECT_ROOT / "app" / "app.py"


def load_app_module():
    spec = importlib.util.spec_from_file_location("purple_bee_app", APP_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    mod = load_app_module()
    mod.init_db()
    mod.ensure_model_registry()
    if hasattr(mod, "ensure_local_runtime_bundle"):
        try:
            mod.ensure_local_runtime_bundle()
        except Exception:
            pass
    port = int(os.environ.get("PORT", 7860))
    mod.app.run(host="0.0.0.0", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
