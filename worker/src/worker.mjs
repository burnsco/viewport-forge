import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import Redis from "ioredis";

const REDIS_ADDR = process.env.REDIS_ADDR ?? "localhost:6379";
const QUEUE_KEY = process.env.QUEUE_KEY ?? "vf:capture_jobs";
const STATUS_PREFIX = process.env.STATUS_PREFIX ?? "vf:capture_status:";
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "../artifacts";

const DEFAULT_VIEWPORTS = [
  { name: "iphone", width: 390, height: 844 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "laptop", width: 1440, height: 900 },
  { name: "ultrawide", width: 2560, height: 1080 },
  { name: "4k", width: 3840, height: 2160 }
];

const [host, portString] = REDIS_ADDR.split(":");
const redis = new Redis({
  host,
  port: Number(portString ?? 6379),
  maxRetriesPerRequest: null
});

let browser;

async function start() {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  console.log(`[worker] connected; waiting on queue ${QUEUE_KEY}`);

  while (true) {
    const result = await redis.brpop(QUEUE_KEY, 0);
    if (!result || result.length < 2) {
      continue;
    }

    const rawJob = result[1];
    let job;

    try {
      job = JSON.parse(rawJob);
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
      started_at: new Date().toISOString()
    });

    const outputDir = path.resolve(process.cwd(), OUTPUT_DIR, job.id);
    await fs.mkdir(outputDir, { recursive: true });

    const viewports = normalizeViewports(job.viewports);

    for (const viewport of viewports) {
      await captureViewport(job.url, viewport, outputDir);
    }

    await redis.hset(statusKey, {
      state: "completed",
      finished_at: new Date().toISOString(),
      output_dir: outputDir,
      screenshots: String(viewports.length)
    });

    console.log(`[worker] completed ${job.id} (${viewports.length} screenshots)`);
  } catch (err) {
    await redis.hset(statusKey, {
      state: "failed",
      finished_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : "unknown error"
    });

    console.error(`[worker] failed ${job.id}`, err);
  }
}

async function captureViewport(url, viewport, outputDir) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  // Brief settle for JS-driven content after network quiet
  await new Promise((r) => setTimeout(r, 800));
  const filePath = path.join(outputDir, `${sanitizeName(viewport.name)}.png`);
  await page.screenshot({ path: filePath, fullPage: false });

  await context.close();
}

function normalizeViewports(viewports) {
  if (!Array.isArray(viewports) || viewports.length === 0) {
    return DEFAULT_VIEWPORTS;
  }

  return viewports
    .filter((v) => v && Number.isInteger(v.width) && Number.isInteger(v.height) && v.width > 0 && v.height > 0)
    .map((v) => ({
      name: typeof v.name === "string" && v.name ? v.name : `${v.width}x${v.height}`,
      width: v.width,
      height: v.height
    }));
}

function sanitizeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

async function shutdown(code) {
  try {
    if (browser) {
      await browser.close();
    }
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
