import { type FormEvent, useEffect, useMemo, useState } from "react";
import "./App.css";

type JobStatus = Record<string, string> | null;
type Screenshot = { name: string; url: string };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

const viewportProfiles = [
  { name: "iPhone", size: "390 x 844" },
  { name: "Tablet", size: "834 x 1112" },
  { name: "Laptop", size: "1440 x 900" },
  { name: "Ultrawide", size: "2560 x 1080" },
  { name: "4K", size: "3840 x 2160" }
];

function App() {
  const [url, setUrl] = useState("https://example.com");
  const [jobID, setJobID] = useState("");
  const [status, setStatus] = useState<JobStatus>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);

  const stateLabel = useMemo(() => {
    if (!status || !status.state) return "idle";
    return status.state;
  }, [status]);

  async function submitCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError("");
    setScreenshots([]);

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/captures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const payload = (await response.json()) as { id: string };
      setJobID(payload.id);
      setStatus({ id: payload.id, state: "queued" });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unknown error");
    } finally {
      setIsSubmitting(false);
    }
  }

  // Poll job state
  useEffect(() => {
    if (!jobID) return;

    const poll = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/captures/${jobID}`);
        if (!response.ok) return;
        const payload = (await response.json()) as Record<string, string>;
        setStatus(payload);
      } catch {
        // Ignore one-off poll failures and retry in the next interval.
      }
    };

    poll();
    const timer = window.setInterval(poll, 3000);
    return () => window.clearInterval(timer);
  }, [jobID]);

  // Fetch screenshots when job completes
  useEffect(() => {
    if (status?.state !== "completed" || !jobID) return;

    fetch(`${API_BASE_URL}/api/v1/captures/${jobID}/screenshots`)
      .then((r) => r.json())
      .then((data: { screenshots?: Screenshot[] }) => {
        setScreenshots(data.screenshots ?? []);
      })
      .catch(() => {});
  }, [status?.state, jobID]);

  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">DevTools Screenshot Automation Platform</p>
        <h1>Viewport Forge</h1>
        <p className="subtitle">
          Upload any site URL, then auto-capture iPhone, tablet, laptop, ultrawide, and 4K screenshots.
        </p>

        <form className="capture-form" onSubmit={submitCapture}>
          <label htmlFor="url">Website URL</label>
          <div className="form-row">
            <input
              id="url"
              name="url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              placeholder="https://your-site.com"
            />
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Queueing..." : "Queue Capture"}
            </button>
          </div>
        </form>

        <div className="status-strip">
          <span>Job: {jobID || "none"}</span>
          <span className={`pill pill-${stateLabel}`}>State: {stateLabel}</span>
          {status?.state === "processing" && (
            <span className="spinner" aria-label="processing" />
          )}
        </div>

        {error ? <p className="error-text">Error: {error}</p> : null}
      </section>

      {screenshots.length > 0 && (
        <section className="screenshot-gallery">
          <h2 className="gallery-heading">Screenshots</h2>
          <div className="screenshot-grid">
            {screenshots.map((shot) => (
              <div key={shot.name} className="screenshot-item">
                <div className="screenshot-label">{shot.name}</div>
                <a
                  href={`${API_BASE_URL}${shot.url}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={`${API_BASE_URL}${shot.url}`}
                    alt={`${shot.name} screenshot`}
                    loading="lazy"
                  />
                </a>
                <a
                  className="download-link"
                  href={`${API_BASE_URL}${shot.url}`}
                  download
                >
                  Download PNG
                </a>
              </div>
            ))}
          </div>
        </section>
      )}

      {screenshots.length === 0 && (
        <section className="viewport-grid" aria-label="Default viewport targets">
          {viewportProfiles.map((profile) => (
            <article key={profile.name} className="viewport-card">
              <h2>{profile.name}</h2>
              <p>{profile.size}</p>
            </article>
          ))}
        </section>
      )}

      <section className="roadmap-strip">
        <h3>Coming next</h3>
        <p>Visual diffing, layout-break alerts, Lighthouse scores per viewport.</p>
      </section>
    </main>
  );
}

export default App;
