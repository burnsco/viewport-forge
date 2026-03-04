.PHONY: setup redis api worker web dev

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

dev:
	docker compose up -d redis
	@echo "Waiting for Redis..."
	@until docker compose exec redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 0.5; done
	@echo "Starting API, worker, and web..."
	@trap 'kill 0' SIGINT SIGTERM; \
	cd backend && go run ./cmd/api & \
	cd worker && bun run start & \
	cd frontend && bun run dev & \
	wait
