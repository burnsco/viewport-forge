package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/corey-burns-dev/viewport-forge/backend/internal/config"
	"github.com/corey-burns-dev/viewport-forge/backend/internal/httpapi"
	"github.com/corey-burns-dev/viewport-forge/backend/internal/queue"
)

func main() {
	cfg := config.Load()

	ctx := context.Background()
	jobQueue, err := queue.NewRedisQueue(ctx, cfg.RedisAddr, cfg.QueueKey, cfg.StatusPrefix)
	if err != nil {
		log.Fatalf("queue init failed: %v", err)
	}
	defer jobQueue.Close()

	artifactsDir, err := filepath.Abs(cfg.ArtifactsDir)
	if err != nil {
		log.Fatalf("invalid artifacts dir: %v", err)
	}

	handler := httpapi.NewServer(jobQueue, cfg.AllowedOrigin, artifactsDir)
	httpServer := &http.Server{
		Addr:         ":" + cfg.APIPort,
		Handler:      handler,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("api listening on http://localhost:%s", cfg.APIPort)
		if serveErr := httpServer.ListenAndServe(); serveErr != nil && serveErr != http.ErrServerClosed {
			log.Fatalf("http server error: %v", serveErr)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
}
