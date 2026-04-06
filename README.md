# Purple Bee

Local chat UI, local model panel, and Cloudflare public frontend.

## Quick start

First setup:

```bat
설치_최초실행.bat
```

Run local chat:

```bat
Purple_Bee_Run.bat
```

Run local model panel:

```bat
Purple_Bee_Model_Panel.bat
```

Korean filename launchers still exist too:

- `Purple_Bee_AI_실행.bat`
- `Purple_Bee_모델패널.bat`

## Important paths

- `D:\Purple Bee AI\app\templates\index.html`
  Main chat UI
- `D:\Purple Bee AI\app\templates\model_panel.html`
  Local model management panel
- `D:\Purple Bee AI\Model\registry.json`
  Current/latest model registry
- `D:\Purple Bee AI\Model\configs\purple_bee_100m.json`
  100M architecture blueprint
- `D:\Purple Bee AI\Model\scripts\train_100m.py`
  100M offline training entry point
- `D:\Purple Bee AI\tools\launch_purple_bee.py`
  Stable launcher used by the batch files

## Current direction

- Browser chat stays lightweight for fast interaction.
- Real larger-scale language learning is intended to happen on the management computer through the `Model/` pipeline.
- The current 100M work is a real offline training scaffold and dry-run path, not a finished GPT-class model yet.

## Cloudflare

- Public URL:
  [https://purple-bee-cloudflare.purplebeeai.workers.dev](https://purple-bee-cloudflare.purplebeeai.workers.dev)
- Public static assets:
  `D:\Purple Bee AI\cloudflare\public`
- Worker:
  `D:\Purple Bee AI\cloudflare\workers\weight-server.js`
