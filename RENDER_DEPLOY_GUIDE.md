# Purple Bee Render Deploy Guide

Target backend URL:

- `https://purplebee.onrender.com`

## Files already prepared

- `render.yaml`
- `Procfile`
- `app/requirements.txt` (includes `gunicorn`)

## Render setup

1. Open [https://dashboard.render.com](https://dashboard.render.com)
2. Open the existing `purplebee`/`purple-bee-api` web service
3. Confirm these settings:
   - Runtime: `Python`
   - Build Command: `pip install -r app/requirements.txt`
   - Start Command: `gunicorn --chdir app --bind 0.0.0.0:$PORT app:app`
   - Health Check Path: `/api/health`
4. Click `Manual Deploy` -> `Deploy latest commit`
5. Wait until the service becomes `Live`

## Verify

Open:

- `https://purplebee.onrender.com/api/health`
- `https://purplebee.onrender.com/api/pbx_chat_sync`

If `/api/health` returns JSON, the backend is alive.

## After Render is live

Set the public backend URL in the Purple Bee model panel:

- `https://purplebee.onrender.com`

Then run Cloudflare deploy again so the public website starts proxying to the Render backend.
