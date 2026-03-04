package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/corey-burns-dev/viewport-forge/backend/internal/queue"
)

var (
	validJobID    = regexp.MustCompile(`^[0-9a-f]+$`)
	validFilename = regexp.MustCompile(`^[a-z0-9_-]+\.png$`)
)

type Server struct {
	queue         *queue.RedisQueue
	allowedOrigin string
	artifactsDir  string
}

type createCaptureRequest struct {
	URL       string           `json:"url"`
	Viewports []queue.Viewport `json:"viewports,omitempty"`
}

func NewServer(jobQueue *queue.RedisQueue, allowedOrigin, artifactsDir string) http.Handler {
	s := &Server{queue: jobQueue, allowedOrigin: allowedOrigin, artifactsDir: artifactsDir}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/api/v1/captures", s.handleCreateCapture)
	mux.HandleFunc("/api/v1/captures/", s.handleCaptureRoute)
	return s.withCORS(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleCreateCapture(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req createCaptureRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json payload"})
		return
	}

	if err := validateURL(req.URL); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	id, err := randomID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "unable to create job id"})
		return
	}

	job := queue.CaptureJob{
		ID:        id,
		URL:       req.URL,
		Requested: time.Now().UTC(),
		Viewports: req.Viewports,
	}

	if err := s.queue.Enqueue(r.Context(), job); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to enqueue job"})
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]string{
		"id":         id,
		"state":      "queued",
		"status_url": "/api/v1/captures/" + id,
	})
}

// handleCaptureRoute dispatches:
//
//	GET /api/v1/captures/:id                     → job status
//	GET /api/v1/captures/:id/screenshots         → list screenshots
//	GET /api/v1/captures/:id/screenshots/:file   → serve PNG
//	GET /api/v1/captures/:id/lighthouse-html     → serve Lighthouse HTML report
func (s *Server) handleCaptureRoute(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	trimmed := strings.TrimPrefix(r.URL.Path, "/api/v1/captures/")
	parts := strings.SplitN(trimmed, "/", 3)

	jobID := parts[0]
	if jobID == "" || !validJobID.MatchString(jobID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid job id"})
		return
	}

	switch {
	case len(parts) == 1:
		s.handleCaptureStatus(w, r, jobID)
	case len(parts) >= 2 && parts[1] == "screenshots":
		if len(parts) == 3 && parts[2] != "" {
			s.handleScreenshotFile(w, r, jobID, parts[2])
		} else {
			s.handleScreenshotList(w, r, jobID)
		}
	case len(parts) == 2 && parts[1] == "report":
		s.handleReport(w, r, jobID)
	case len(parts) == 2 && parts[1] == "lighthouse-html":
		s.handleLighthouseHTML(w, r, jobID)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func (s *Server) handleCaptureStatus(w http.ResponseWriter, r *http.Request, jobID string) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	status, err := s.queue.GetStatus(r.Context(), jobID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "job not found"})
		return
	}

	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleScreenshotList(w http.ResponseWriter, r *http.Request, jobID string) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	dir := filepath.Join(s.artifactsDir, jobID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no screenshots found"})
		return
	}

	type screenshotInfo struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}

	var screenshots []screenshotInfo
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		filename := entry.Name()
		if !validFilename.MatchString(filename) {
			continue
		}
		name := strings.TrimSuffix(filename, ".png")
		screenshots = append(screenshots, screenshotInfo{
			Name: name,
			URL:  "/api/v1/captures/" + jobID + "/screenshots/" + filename,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"job_id":      jobID,
		"screenshots": screenshots,
	})
}

func (s *Server) handleReport(w http.ResponseWriter, r *http.Request, jobID string) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	filePath := filepath.Join(s.artifactsDir, jobID, "report.json")
	data, err := os.ReadFile(filePath)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "report not found"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleScreenshotFile(w http.ResponseWriter, r *http.Request, jobID, filename string) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	if !validFilename.MatchString(filename) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid filename"})
		return
	}

	filePath := filepath.Join(s.artifactsDir, jobID, filename)
	http.ServeFile(w, r, filePath)
}

func (s *Server) handleLighthouseHTML(w http.ResponseWriter, r *http.Request, jobID string) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	filePath := filepath.Join(s.artifactsDir, jobID, "lighthouse-report.html")
	http.ServeFile(w, r, filePath)
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", s.allowedOrigin)
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func validateURL(raw string) error {
	u, err := url.ParseRequestURI(raw)
	if err != nil {
		return errors.New("url must be valid")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("url scheme must be http or https")
	}
	return nil
}

func randomID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}
