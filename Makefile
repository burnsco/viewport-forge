.PHONY: setup redis api worker web

setup:
	cd frontend && bun install
	cd worker && bun install
	cd backend && go mod tidy

redis:
	docker compose up -d redis

api:
	cd backend && go run ./cmd/api

worker:
	cd worker && bun run start

web:
	cd frontend && bun run dev
