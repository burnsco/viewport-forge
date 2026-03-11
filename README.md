# Viewport Forge

Viewport Forge is a responsive QA tool that captures multi-device screenshots and Lighthouse artifacts for a target URL. It combines a React frontend, Go API, and Playwright worker around a Redis-backed job queue.

## Repo layout

- `frontend/`: React UI
- `backend/`: Go API
- `worker/`: Playwright capture worker
- `artifacts/`: generated outputs

## Highlights

- Queue capture jobs from the UI or API
- Generate screenshots across multiple viewport presets
- Produce Lighthouse JSON and HTML reports per run

## Quick start

```bash
make setup
make redis
make dev
```

Default services:

- Frontend: `http://localhost:5173`
- API: `http://localhost:8080`
