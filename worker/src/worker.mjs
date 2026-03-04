import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Redis from "ioredis";
import lighthouse from "lighthouse";
import { chromium } from "playwright";

const REDIS_ADDR = process.env.REDIS_ADDR ?? "localhost:6379";
const QUEUE_KEY = process.env.QUEUE_KEY ?? "vf:capture_jobs";
const STATUS_PREFIX = process.env.STATUS_PREFIX ?? "vf:capture_status:";
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "../artifacts";
const MAX_CAPTURE_HEIGHT = Number(process.env.MAX_CAPTURE_HEIGHT ?? 16000);
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEFAULT_VIEWPORTS = [
  { name: "iphone", width: 390, height: 844 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "laptop", width: 1440, height: 900 },
  { name: "ultrawide", width: 2560, height: 1080 },
  // 4K at 200% OS scaling: logical viewport is 1920×1080, deviceScaleFactor:2
  // produces a 3840×2160 screenshot that reflects how real users experience 4K.
  { name: "4k", width: 1920, height: 1080, deviceScaleFactor: 2 },
];

const [host, portString] = REDIS_ADDR.split(":");
const redis = new Redis({
  host,
  port: Number(portString ?? 6379),
  maxRetriesPerRequest: null,
});

let browser;

async function start() {
  // Expose a TCP CDP port so Lighthouse can connect without conflicting
  // with Playwright's internal pipe transport.
  // Note: --disable-gpu removed — it can break CSS compositing and cause
  // black content areas in screenshots on modern headless Chrome.
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--remote-debugging-port=9222",
    ],
  });

  console.log(`[worker] browser ready; waiting on queue ${QUEUE_KEY}`);

  while (true) {
    const result = await redis.brpop(QUEUE_KEY, 0);
    if (!result || result.length < 2) continue;

    let job;
    try {
      job = JSON.parse(result[1]);
    } catch (err) {
      console.error("[worker] skipping invalid job payload", err);
      continue;
    }

    await handleJob(job);
  }
}

async function handleJob(job) {
  const statusKey = `${STATUS_PREFIX}${job.id}`;

  try {
    await redis.hset(statusKey, {
      state: "processing",
      started_at: new Date().toISOString(),
    });

    const outputDir = path.resolve(process.cwd(), OUTPUT_DIR, job.id);
    await fs.mkdir(outputDir, { recursive: true });

    const viewports = normalizeViewports(job.viewports);

    // 1. Screenshots (all viewports)
    for (const viewport of viewports) {
      await captureViewport(job.url, viewport, outputDir);
    }

    // 2. Network / bundle analysis (laptop viewport as representative)
    const bundles = await captureNetworkData(job.url);

    // 3. Lighthouse audit (connects via CDP to the same Chromium)
    const lhResult = await runLighthouse(job.url, outputDir);

    // 4. Persist report.json next to the screenshots
    await fs.writeFile(
      path.join(outputDir, "report.json"),
      JSON.stringify(
        {
          bundles,
          lighthouse: lhResult?.summary ?? null,
          lighthouse_full: lhResult?.full ?? null,
          lighthouse_text: lhResult?.text ?? null,
          lighthouse_html_url: lhResult
            ? `/api/v1/captures/${job.id}/lighthouse-html`
            : null,
        },
        null,
        2
      )
    );

    await redis.hset(statusKey, {
      state: "completed",
      finished_at: new Date().toISOString(),
      output_dir: outputDir,
      screenshots: String(viewports.length),
    });

    console.log(`[worker] completed ${job.id} (${viewports.length} shots)`);
  } catch (err) {
    await redis.hset(statusKey, {
      state: "failed",
      finished_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : "unknown error",
    });
    console.error(`[worker] failed ${job.id}`, err);
  }
}

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------

async function captureViewport(url, viewport, outputDir) {
  const { deviceScaleFactor, ...viewportSize } = viewport;
  const context = await browser.newContext({
    viewport: viewportSize,
    deviceScaleFactor: deviceScaleFactor ?? 1,
    userAgent: USER_AGENT,
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "load", timeout: 45000 });

    // Best-effort network-idle wait — some SPAs never fully settle
    await page
      .waitForLoadState("networkidle", { timeout: 10000 })
      .catch(() => {});

    // Walk the page to trigger lazy-loaded content before capturing.
    await primeLazyContent(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    // Final rendering settle
    await new Promise((r) => setTimeout(r, 1500));

    const metrics = await measureCaptureHeight(page);
    const boundedHeight = Math.min(
      metrics.captureHeight,
      Number.isFinite(MAX_CAPTURE_HEIGHT) && MAX_CAPTURE_HEIGHT > 0
        ? Math.floor(MAX_CAPTURE_HEIGHT)
        : 16000
    );
    const captureHeight = Math.max(viewportSize.height, boundedHeight);

    const filePath = path.join(
      outputDir,
      `${sanitizeName(viewport.name)}.png`
    );
    await page.screenshot({
      path: filePath,
      clip: {
        x: 0,
        y: 0,
        width: viewportSize.width,
        height: captureHeight,
      },
      captureBeyondViewport: true,
      scale: "css",
      animations: "disabled",
    });
  } finally {
    await context.close();
  }
}

async function primeLazyContent(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const root = document.scrollingElement || document.documentElement;
    const step = Math.max(240, Math.floor(window.innerHeight * 0.85));
    const maxSteps = 220;

    for (let i = 0; i < maxSteps; i += 1) {
      const before = root.scrollTop;
      const nextTop = Math.min(
        before + step,
        Math.max(0, root.scrollHeight - root.clientHeight)
      );
      root.scrollTop = nextTop;
      await wait(120);
      if (root.scrollTop === before || nextTop >= root.scrollHeight - root.clientHeight) {
        break;
      }
    }
  });
}

async function measureCaptureHeight(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const viewportHeight = Math.max(window.innerHeight, 1);
    const scrollHeight = Math.max(
      doc?.scrollHeight ?? 0,
      body?.scrollHeight ?? 0,
      doc?.offsetHeight ?? 0,
      body?.offsetHeight ?? 0,
      viewportHeight
    );

    let maxElementBottom = viewportHeight;
    if (body) {
      const elements = body.querySelectorAll("*");
      for (const el of elements) {
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.position === "fixed"
        ) {
          continue;
        }

        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;

        const bottom = rect.bottom + window.scrollY;
        if (bottom > maxElementBottom && bottom < 200000) {
          maxElementBottom = bottom;
        }
      }
    }

    // Ignore obviously inflated document heights when actual rendered content ends much sooner.
    const captureHeight =
      scrollHeight > maxElementBottom * 1.75
        ? Math.ceil(maxElementBottom + viewportHeight * 0.35)
        : Math.ceil(scrollHeight);

    return {
      captureHeight: Math.max(captureHeight, viewportHeight),
    };
  });
}

// ---------------------------------------------------------------------------
// Network / bundle analysis
// ---------------------------------------------------------------------------

async function captureNetworkData(url) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: USER_AGENT,
  });
  const page = await context.newPage();

  const resources = [];
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (
      ["document", "script", "stylesheet", "image", "font", "fetch", "xhr"].includes(
        type
      )
    ) {
      const bytes = parseInt(
        response.headers()["content-length"] ?? "0",
        10
      );
      resources.push({ url: response.url(), type, bytes: bytes || 0 });
    }
  });

  try {
    await page.goto(url, { waitUntil: "load", timeout: 45000 });
    await page
      .waitForLoadState("networkidle", { timeout: 10000 })
      .catch(() => {});
  } finally {
    await context.close();
  }

  const byType = {
    script: 0,
    stylesheet: 0,
    image: 0,
    font: 0,
    document: 0,
    other: 0,
  };
  let totalBytes = 0;

  for (const r of resources) {
    totalBytes += r.bytes;
    if (r.type === "script") byType.script += r.bytes;
    else if (r.type === "stylesheet") byType.stylesheet += r.bytes;
    else if (r.type === "image") byType.image += r.bytes;
    else if (r.type === "font") byType.font += r.bytes;
    else if (r.type === "document") byType.document += r.bytes;
    else byType.other += r.bytes;
  }

  return {
    totalBytes,
    jsBytes: byType.script,
    cssBytes: byType.stylesheet,
    imageBytes: byType.image,
    fontBytes: byType.font,
    documentBytes: byType.document,
    otherBytes: byType.other,
    topResources: resources
      .filter((r) => r.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10)
      .map(({ url, type, bytes }) => ({ url, type, bytes })),
  };
}

// ---------------------------------------------------------------------------
// Lighthouse audit
// ---------------------------------------------------------------------------

async function runLighthouse(url, outputDir) {
  try {
    const result = await lighthouse(url, {
      output: ["html", "json"],
      logLevel: "silent",
      port: 9222,
      onlyCategories: [
        "performance",
        "accessibility",
        "best-practices",
        "seo",
      ],
    });

    const lhr = result?.lhr;
    if (!lhr) return null;

    const reportOutput = Array.isArray(result?.report)
      ? result.report
      : [result?.report];
    const htmlReport = reportOutput.find(
      (entry) =>
        typeof entry === "string" &&
        entry.trimStart().toLowerCase().startsWith("<!doctype html")
    );
    if (htmlReport && outputDir) {
      await fs.writeFile(
        path.join(outputDir, "lighthouse-report.html"),
        htmlReport
      );
    }

    const score = (cat) =>
      Math.round((lhr.categories[cat]?.score ?? 0) * 100);

    const metric = (key) => {
      const a = lhr.audits[key];
      if (!a) return null;
      const s = a.score ?? 0;
      return {
        value: a.displayValue ?? String(a.numericValue ?? ""),
        numericValue: a.numericValue ?? 0,
        score: s,
        rating: s >= 0.9 ? "good" : s >= 0.5 ? "needs-improvement" : "poor",
      };
    };

    const opportunities = Object.values(lhr.audits)
      .filter((a) => a.type === "opportunity" && a.score !== null && a.score < 1)
      .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
      .slice(0, 8)
      .map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        displayValue: a.displayValue ?? "",
        score: a.score ?? 0,
      }));

    const summary = {
      scores: {
        performance: score("performance"),
        accessibility: score("accessibility"),
        bestPractices: score("best-practices"),
        seo: score("seo"),
      },
      cwv: {
        lcp: metric("largest-contentful-paint"),
        cls: metric("cumulative-layout-shift"),
        tbt: metric("total-blocking-time"),
        fcp: metric("first-contentful-paint"),
        si: metric("speed-index"),
        tti: metric("interactive"),
      },
      opportunities,
    };

    return {
      summary,
      full: lhr,
      text: buildLighthouseTextReport(lhr, summary),
    };
  } catch (err) {
    console.error("[worker] lighthouse failed:", err.message);
    return null;
  }
}

function buildLighthouseTextReport(lhr, summary) {
  const lines = [];
  const categoryLabel = {
    performance: "Performance",
    accessibility: "Accessibility",
    "best-practices": "Best Practices",
    seo: "SEO",
  };

  lines.push(`# Lighthouse Report`);
  lines.push(`URL: ${lhr.finalUrl ?? lhr.requestedUrl ?? "unknown"}`);
  if (lhr.fetchTime) lines.push(`Fetch time: ${lhr.fetchTime}`);
  lines.push("");
  lines.push("## Scores");
  lines.push(`- Performance: ${summary.scores.performance}/100`);
  lines.push(`- Accessibility: ${summary.scores.accessibility}/100`);
  lines.push(`- Best Practices: ${summary.scores.bestPractices}/100`);
  lines.push(`- SEO: ${summary.scores.seo}/100`);
  lines.push("");
  lines.push("## Key Metrics");
  lines.push(`- LCP: ${summary.cwv.lcp?.value ?? "N/A"}`);
  lines.push(`- CLS: ${summary.cwv.cls?.value ?? "N/A"}`);
  lines.push(`- TBT: ${summary.cwv.tbt?.value ?? "N/A"}`);
  lines.push(`- FCP: ${summary.cwv.fcp?.value ?? "N/A"}`);
  lines.push(`- Speed Index: ${summary.cwv.si?.value ?? "N/A"}`);
  lines.push(`- TTI: ${summary.cwv.tti?.value ?? "N/A"}`);
  lines.push("");
  lines.push("## Top Opportunities");
  if (summary.opportunities.length === 0) {
    lines.push("- None");
  } else {
    for (const opp of summary.opportunities) {
      lines.push(
        `- ${opp.title}${opp.displayValue ? ` (${opp.displayValue})` : ""}`
      );
    }
  }

  const categories = ["performance", "accessibility", "best-practices", "seo"];
  for (const cat of categories) {
    const category = lhr.categories?.[cat];
    if (!category?.auditRefs?.length) continue;
    const failing = category.auditRefs
      .filter((ref) => typeof ref.weight === "number" && ref.weight > 0)
      .map((ref) => lhr.audits?.[ref.id])
      .filter((audit) => audit && audit.scoreDisplayMode !== "notApplicable")
      .filter((audit) => audit.score !== null && audit.score < 0.9)
      .sort((a, b) => (a.score ?? 1) - (b.score ?? 1));

    if (failing.length === 0) continue;

    lines.push("");
    lines.push(`## ${categoryLabel[cat]} Audits To Improve`);
    for (const audit of failing) {
      const display = audit.displayValue ? ` - ${audit.displayValue}` : "";
      lines.push(`- ${audit.title}${display}`);
      if (audit.description) lines.push(`  ${audit.description}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalizeViewports(viewports) {
  if (!Array.isArray(viewports) || viewports.length === 0) {
    return DEFAULT_VIEWPORTS;
  }
  return viewports
    .filter(
      (v) =>
        v &&
        Number.isInteger(v.width) &&
        Number.isInteger(v.height) &&
        v.width > 0 &&
        v.height > 0
    )
    .map((v) => ({
      name:
        typeof v.name === "string" && v.name
          ? v.name
          : `${v.width}x${v.height}`,
      width: v.width,
      height: v.height,
      ...(v.deviceScaleFactor ? { deviceScaleFactor: v.deviceScaleFactor } : {}),
    }));
}

function sanitizeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

async function shutdown(code) {
  try {
    if (browser) await browser.close();
    await redis.quit();
  } catch {
    // noop
  } finally {
    process.exit(code);
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start().catch((err) => {
  console.error("[worker] fatal error", err);
  shutdown(1);
});
