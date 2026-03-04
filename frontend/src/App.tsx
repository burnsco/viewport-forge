import { useEffect, useMemo, useState } from "react";
import "./App.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JobStatus = Record<string, string> | null;
type Screenshot = { name: string; url: string };
type Tab = "screenshots" | "performance" | "report";

type CWVMetric = {
  value: string;
  numericValue: number;
  score: number;
  rating: "good" | "needs-improvement" | "poor";
};

type LighthouseResult = {
  scores: {
    performance: number;
    accessibility: number;
    bestPractices: number;
    seo: number;
  };
  cwv: {
    lcp: CWVMetric | null;
    cls: CWVMetric | null;
    tbt: CWVMetric | null;
    fcp: CWVMetric | null;
    si: CWVMetric | null;
    tti: CWVMetric | null;
  };
  opportunities: Array<{
    id: string;
    title: string;
    description: string;
    displayValue: string;
    score: number;
  }>;
};

type BundleResult = {
  totalBytes: number;
  jsBytes: number;
  cssBytes: number;
  imageBytes: number;
  fontBytes: number;
  otherBytes: number;
  topResources: Array<{ url: string; type: string; bytes: number }>;
};

type Report = {
  lighthouse: LighthouseResult | null;
  bundles: BundleResult | null;
  lighthouse_full?: Record<string, unknown> | null;
  lighthouse_text?: string | null;
  lighthouse_html_url?: string | null;
};

type HistoryEntry = { id: string; url: string; requestedAt: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

const HISTORY_KEY = "vf:history";

const viewportProfiles = [
  { name: "iPhone", size: "390 × 844", desc: "Mobile portrait" },
  { name: "Tablet", size: "834 × 1112", desc: "iPad-class tablet" },
  { name: "Laptop", size: "1440 × 900", desc: "Standard desktop" },
  { name: "Ultrawide", size: "2560 × 1080", desc: "Wide monitor" },
  { name: "4K", size: "3840 × 2160", desc: "4K display" },
];

// Maps screenshot file name (sans .png) back to human dimensions
const viewportSizes: Record<string, string> = {
  iphone: "390 × 844",
  tablet: "834 × 1112",
  laptop: "1440 × 900",
  ultrawide: "2560 × 1080",
  "4k": "3840 × 2160",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(startIso: string, endIso: string) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function truncateUrl(url: string, max = 60) {
  return url.length > max ? `\u2026${url.slice(-(max - 1))}` : url;
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function ScoreChip({ label, score }: { label: string; score: number }) {
  const cls =
    score >= 90 ? "score-good" : score >= 50 ? "score-warn" : "score-poor";
  return (
    <div className={`score-chip ${cls}`}>
      <span className="score-num">{score}</span>
      <span className="score-lbl">{label}</span>
    </div>
  );
}

function CWVBox({
  label,
  metric,
  hint,
}: {
  label: string;
  metric: CWVMetric | null;
  hint?: string;
}) {
  if (!metric) return null;
  const cls =
    metric.rating === "good"
      ? "cwv-good"
      : metric.rating === "needs-improvement"
        ? "cwv-warn"
        : "cwv-poor";
  return (
    <div className={`cwv-box ${cls}`} title={hint}>
      <span className="cwv-value">{metric.value}</span>
      <span className="cwv-label">{label}</span>
      <span className="cwv-rating">{metric.rating}</span>
    </div>
  );
}

function BundleBar({
  label,
  bytes,
  total,
  color,
}: {
  label: string;
  bytes: number;
  total: number;
  color: string;
}) {
  const kb = Math.round(bytes / 1024);
  const pct = total > 0 ? Math.round((bytes / total) * 100) : 0;
  return (
    <div className="bundle-row">
      <span className="bundle-label">{label}</span>
      <div className="bundle-track">
        <div
          className="bundle-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="bundle-pct">{pct}%</span>
      <span className="bundle-kb">{kb} KB</span>
    </div>
  );
}

function TopResourcesTable({
  resources,
}: {
  resources: Array<{ url: string; type: string; bytes: number }>;
}) {
  if (resources.length === 0) return null;
  return (
    <div className="resource-table-wrap">
      <table className="resource-table">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Type</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {resources.map((r) => (
            <tr key={r.url}>
              <td className="resource-url" title={r.url}>
                {truncateUrl(r.url)}
              </td>
              <td>
                <span className={`resource-type-badge type-${r.type}`}>
                  {r.type}
                </span>
              </td>
              <td className="resource-kb">{Math.round(r.bytes / 1024)} KB</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

function App() {
  const [url, setUrl] = useState("https://example.com");
  const [jobID, setJobID] = useState("");
  const [status, setStatus] = useState<JobStatus>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("screenshots");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  // Load history from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {
      // ignore corrupt data
    }
  }, []);

  const stateLabel = useMemo(() => {
    if (!status || !status.state) return "idle";
    return status.state;
  }, [status]);

  const isComplete = status?.state === "completed";
  const isFailed = status?.state === "failed";

  async function submitCapture(event: { preventDefault(): void }) {
    event.preventDefault();
    setIsSubmitting(true);
    setError("");
    setScreenshots([]);
    setReport(null);
    setActiveTab("screenshots");
    setCopyStatus("");

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/captures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) throw new Error(`API returned ${response.status}`);

      const payload = (await response.json()) as { id: string };
      setJobID(payload.id);
      setStatus({ id: payload.id, state: "queued" });

      // Persist to history
      const entry: HistoryEntry = {
        id: payload.id,
        url,
        requestedAt: new Date().toISOString(),
      };
      setHistory((prev) => {
        const updated = [
          entry,
          ...prev.filter((e) => e.id !== entry.id),
        ].slice(0, 10);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
        return updated;
      });
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Unknown error",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function loadJob(entry: HistoryEntry) {
    setUrl(entry.url);
    setJobID(entry.id);
    setStatus(null);
    setScreenshots([]);
    setReport(null);
    setError("");
    setShowHistory(false);
    setActiveTab("screenshots");
    setCopyStatus("");
  }

  function resetForNewAudit() {
    setJobID("");
    setStatus(null);
    setScreenshots([]);
    setReport(null);
    setError("");
    setCopyStatus("");
  }

  async function copyToClipboard(text: string, label: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`${label} copied.`);
      window.setTimeout(() => setCopyStatus(""), 2500);
    } catch {
      setCopyStatus(`Failed to copy ${label.toLowerCase()}.`);
      window.setTimeout(() => setCopyStatus(""), 2500);
    }
  }

  // Poll job state
  useEffect(() => {
    if (!jobID) return;

    const poll = async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/v1/captures/${jobID}`,
        );
        if (!response.ok) return;
        const payload = (await response.json()) as Record<string, string>;
        setStatus(payload);
      } catch {
        // Ignore transient poll failures
      }
    };

    poll();
    const timer = window.setInterval(poll, 3000);
    return () => window.clearInterval(timer);
  }, [jobID]);

  // Fetch screenshots + report when job completes
  useEffect(() => {
    if (!isComplete || !jobID) return;

    fetch(`${API_BASE_URL}/api/v1/captures/${jobID}/screenshots`)
      .then((r) => r.json())
      .then((data: { screenshots?: Screenshot[] }) => {
        setScreenshots(data.screenshots ?? []);
      })
      .catch(() => {});

    fetch(`${API_BASE_URL}/api/v1/captures/${jobID}/report`)
      .then((r) => r.json())
      .then((data: Report) => setReport(data))
      .catch(() => {});
  }, [isComplete, jobID]);

  const duration =
    status?.started_at && status?.finished_at
      ? formatDuration(status.started_at, status.finished_at)
      : null;

  return (
    <main className="page-shell">
      {/* Hero card */}
      <section className="hero-card">
        <p className="eyebrow">Site Audit &amp; Screenshot Platform</p>
        <h1>Viewport Forge</h1>
        <p className="subtitle">
          Enter any URL to capture screenshots at every viewport, run a
          Lighthouse audit, and get a full detailed report you can copy into
          your local AI agent.
        </p>

        <form className="capture-form" onSubmit={submitCapture}>
          <label htmlFor="url">Website URL</label>
          <div className="form-row">
            <input
              id="url"
              name="url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              placeholder="https://your-site.com"
            />
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Queueing\u2026" : "Run Audit"}
            </button>
          </div>
        </form>

        {/* History toggle */}
        <div className="history-bar">
          <button
            type="button"
            className="history-toggle"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
          >
            Recent audits ({history.length})
            <span
              className="history-chevron"
              aria-hidden
              style={{
                transform: showHistory ? "rotate(180deg)" : "rotate(0deg)",
              }}
            >
              &#8963;
            </span>
          </button>

          {showHistory && (
            <div className="history-dropdown">
              {history.length === 0 ? (
                <p className="history-empty">No previous audits yet.</p>
              ) : (
                history.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="history-entry"
                    onClick={() => loadJob(entry)}
                  >
                    <span className="history-url">{entry.url}</span>
                    <span className="history-meta">
                      {entry.id} &middot; {formatTime(entry.requestedAt)}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Status strip */}
        <div className="status-strip">
          <span className="status-id">
            Job: <code>{jobID || "none"}</code>
          </span>
          <span className={`pill pill-${stateLabel}`}>{stateLabel}</span>
          {status?.state === "processing" && <span className="spinner" />}
          {status?.started_at && (
            <span className="status-time">
              Started: {formatTime(status.started_at)}
            </span>
          )}
          {duration && (
            <span className="status-time duration-badge">
              Duration: {duration}
            </span>
          )}
          {isComplete && status?.screenshots && (
            <span className="status-time">
              {status.screenshots} screenshots captured
            </span>
          )}
          {isComplete && (
            <button
              type="button"
              className="new-audit-btn"
              onClick={resetForNewAudit}
            >
              New audit
            </button>
          )}
        </div>

        {/* Error display */}
        {error ? <p className="error-text">Error: {error}</p> : null}
        {isFailed && status?.error ? (
          <p className="error-text">
            Job failed: {status.error}
          </p>
        ) : null}
      </section>

      {/* Results area */}
      {isComplete ? (
        <section className="results-section">
          {/* Tab bar */}
          <div className="tab-bar" role="tablist">
            {(["screenshots", "performance", "report"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={activeTab === t}
                className={`tab-btn${activeTab === t ? " tab-active" : ""}`}
                onClick={() => setActiveTab(t)}
              >
                {t === "screenshots" && "Screenshots"}
                {t === "performance" && "Performance"}
                {t === "report" && "Detailed Report"}
              </button>
            ))}
          </div>

          {/* Screenshots tab */}
          {activeTab === "screenshots" && (
            <div className="tab-panel">
              {screenshots.length > 0 ? (
                <div className="screenshot-grid">
                  {screenshots.map((shot) => (
                    <div key={shot.name} className="screenshot-item">
                      <div className="screenshot-label">
                        <span className="screenshot-name">{shot.name}</span>
                        {viewportSizes[shot.name] && (
                          <span className="screenshot-size">
                            {viewportSizes[shot.name]}
                          </span>
                        )}
                      </div>
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
              ) : (
                <p className="empty-msg">No screenshots available.</p>
              )}
            </div>
          )}

          {/* Performance tab */}
          {activeTab === "performance" && (
            <div className="tab-panel">
              {report?.lighthouse ? (
                <>
                  {/* Scores */}
                  <h2 className="section-heading">Lighthouse Scores</h2>
                  <div className="scores-row">
                    <ScoreChip
                      label="Performance"
                      score={report.lighthouse.scores.performance}
                    />
                    <ScoreChip
                      label="Accessibility"
                      score={report.lighthouse.scores.accessibility}
                    />
                    <ScoreChip
                      label="Best Practices"
                      score={report.lighthouse.scores.bestPractices}
                    />
                    <ScoreChip
                      label="SEO"
                      score={report.lighthouse.scores.seo}
                    />
                  </div>
                  <p className="scores-legend">
                    90&ndash;100 = good &nbsp;&bull;&nbsp; 50&ndash;89 = needs
                    improvement &nbsp;&bull;&nbsp; 0&ndash;49 = poor
                  </p>

                  {/* Core Web Vitals */}
                  <h2 className="section-heading">Core Web Vitals</h2>
                  <div className="cwv-row">
                    <CWVBox
                      label="LCP"
                      metric={report.lighthouse.cwv.lcp}
                      hint="Largest Contentful Paint — good < 2.5 s"
                    />
                    <CWVBox
                      label="CLS"
                      metric={report.lighthouse.cwv.cls}
                      hint="Cumulative Layout Shift — good < 0.1"
                    />
                    <CWVBox
                      label="TBT"
                      metric={report.lighthouse.cwv.tbt}
                      hint="Total Blocking Time (INP proxy) — good < 200 ms"
                    />
                    <CWVBox
                      label="FCP"
                      metric={report.lighthouse.cwv.fcp}
                      hint="First Contentful Paint — good < 1.8 s"
                    />
                    <CWVBox
                      label="Speed Index"
                      metric={report.lighthouse.cwv.si}
                      hint="Speed Index — how quickly content is visually populated"
                    />
                    <CWVBox
                      label="TTI"
                      metric={report.lighthouse.cwv.tti}
                      hint="Time to Interactive — good < 3.8 s"
                    />
                  </div>

                  {/* Opportunities */}
                  {report.lighthouse.opportunities.length > 0 && (
                    <>
                      <h2 className="section-heading">Top Opportunities</h2>
                      <ul className="opportunity-list">
                        {report.lighthouse.opportunities.map((o) => (
                          <li key={o.id} className="opportunity-item">
                            <div className="opp-main">
                              <span className="opp-title">{o.title}</span>
                              {o.description && (
                                <span className="opp-desc">{o.description}</span>
                              )}
                            </div>
                            {o.displayValue && (
                              <span className="opp-value">{o.displayValue}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <p className="empty-msg">Lighthouse data unavailable.</p>
              )}

              {/* Bundle breakdown */}
              {report?.bundles && report.bundles.totalBytes > 0 && (
                <>
                  <h2 className="section-heading">Bundle Breakdown</h2>
                  <div className="bundle-card">
                    <BundleBar
                      label="JavaScript"
                      bytes={report.bundles.jsBytes}
                      total={report.bundles.totalBytes}
                      color="#1248ff"
                    />
                    <BundleBar
                      label="Images"
                      bytes={report.bundles.imageBytes}
                      total={report.bundles.totalBytes}
                      color="#7c3aed"
                    />
                    <BundleBar
                      label="CSS"
                      bytes={report.bundles.cssBytes}
                      total={report.bundles.totalBytes}
                      color="#0891b2"
                    />
                    <BundleBar
                      label="Fonts"
                      bytes={report.bundles.fontBytes}
                      total={report.bundles.totalBytes}
                      color="#059669"
                    />
                    <BundleBar
                      label="Other"
                      bytes={report.bundles.otherBytes}
                      total={report.bundles.totalBytes}
                      color="#94a3b8"
                    />
                    <div className="bundle-total">
                      Total page weight:{" "}
                      {Math.round(report.bundles.totalBytes / 1024)} KB
                    </div>
                  </div>

                  {/* Top resources */}
                  {report.bundles.topResources?.length > 0 && (
                    <>
                      <h2 className="section-heading">Heaviest Resources</h2>
                      <TopResourcesTable
                        resources={report.bundles.topResources}
                      />
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* Detailed report tab */}
          {activeTab === "report" && (
            <div className="tab-panel">
              {report ? (
                <>
                  <div className="ai-summary-card">
                    <p>
                      Use this tab to copy full Lighthouse output into your
                      local AI workflow.
                    </p>
                  </div>

                  <div className="report-actions">
                    <button
                      type="button"
                      className="report-btn"
                      disabled={!report.lighthouse_text}
                      onClick={() =>
                        copyToClipboard(
                          report.lighthouse_text ?? "",
                          "Lighthouse text report",
                        )
                      }
                    >
                      Copy Text Report
                    </button>
                    <button
                      type="button"
                      className="report-btn"
                      disabled={!report.lighthouse_full}
                      onClick={() =>
                        copyToClipboard(
                          JSON.stringify(report.lighthouse_full, null, 2),
                          "Lighthouse JSON",
                        )
                      }
                    >
                      Copy Full JSON
                    </button>
                    {report.lighthouse_html_url && (
                      <a
                        className="report-btn report-link-btn"
                        href={`${API_BASE_URL}${report.lighthouse_html_url}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open HTML Report
                      </a>
                    )}
                  </div>

                  {copyStatus && <p className="copy-status">{copyStatus}</p>}

                  {report.lighthouse_text && (
                    <>
                      <h2 className="section-heading">Copy-Ready Text Report</h2>
                      <pre className="report-text-preview">
                        {report.lighthouse_text}
                      </pre>
                    </>
                  )}
                </>
              ) : (
                <div className="empty-msg">Detailed report is still loading…</div>
              )}
            </div>
          )}
        </section>
      ) : (
        /* Pre-run: show viewport profile cards */
        <section
          className="viewport-grid"
          aria-label="Default viewport targets"
        >
          {viewportProfiles.map((profile) => (
            <article key={profile.name} className="viewport-card">
              <h2>{profile.name}</h2>
              <p className="viewport-size">{profile.size}</p>
              <p className="viewport-desc">{profile.desc}</p>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

export default App;
