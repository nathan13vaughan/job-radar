// Job Radar — daily job finder.
// Pulls listings from Adzuna (AU) and The Muse, scores them against
// preferences.json, optionally re-ranks with Claude, and writes data/jobs.json
// for the Scriptable widget to consume.
//
// Env vars (all optional — the script degrades gracefully without them):
//   ADZUNA_APP_ID / ADZUNA_APP_KEY  — free keys from https://developer.adzuna.com
//   ANTHROPIC_API_KEY               — enables Claude re-ranking with per-job reasons

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prefs = JSON.parse(readFileSync(join(root, "preferences.json"), "utf8"));

const MAX_CANDIDATES_FOR_RANKING = 25;
const TOP_N = 10;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "job-radar (github.com job widget)" },
    ...options,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function fetchAdzuna() {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    console.log("Adzuna: no ADZUNA_APP_ID/ADZUNA_APP_KEY secrets set — skipping.");
    return { jobs: [], available: false };
  }

  const jobs = [];
  for (const role of prefs.roles) {
    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      results_per_page: "30",
      what: role,
      where: prefs.location.city,
      distance: String(prefs.location.maxDistanceKm),
      max_days_old: "28",
      sort_by: "date",
    });
    const url = `https://api.adzuna.com/v1/api/jobs/${prefs.location.country}/search/1?${params}`;
    try {
      const data = await fetchJson(url);
      for (const r of data.results || []) {
        jobs.push({
          id: `adzuna-${r.id}`,
          title: r.title?.replace(/<\/?[^>]+>/g, "") || "Untitled",
          company: r.company?.display_name || "Unknown",
          location: r.location?.display_name || prefs.location.city,
          salaryMin: r.salary_min || null,
          salaryMax: r.salary_max || null,
          salaryPredicted: r.salary_is_predicted === "1",
          description: stripHtml(r.description),
          url: r.redirect_url,
          posted: r.created,
          source: "Adzuna",
        });
      }
      console.log(`Adzuna: "${role}" -> ${data.results?.length ?? 0} results`);
    } catch (err) {
      console.error(`Adzuna: query "${role}" failed: ${err.message}`);
    }
  }
  return { jobs, available: true };
}

async function fetchTheMuse() {
  const jobs = [];
  const wantedLocation = `${prefs.location.city}, Australia`;
  for (const page of [1, 2]) {
    const url = `https://www.themuse.com/api/public/jobs?page=${page}&location=${encodeURIComponent(wantedLocation)}`;
    try {
      const data = await fetchJson(url);
      for (const r of data.results || []) {
        jobs.push({
          id: `muse-${r.id}`,
          title: r.name || "Untitled",
          company: r.company?.name || "Unknown",
          location: r.locations?.map((l) => l.name).join(", ") || wantedLocation,
          salaryMin: null,
          salaryMax: null,
          salaryPredicted: false,
          description: stripHtml(r.contents).slice(0, 2000),
          url: r.refs?.landing_page,
          posted: r.publication_date,
          source: "The Muse",
        });
      }
      if ((data.results || []).length === 0) break;
    } catch (err) {
      console.error(`The Muse: page ${page} failed: ${err.message}`);
      break;
    }
  }
  console.log(`The Muse: ${jobs.length} results for ${wantedLocation}`);
  return jobs;
}

// ---------------------------------------------------------------------------
// Filtering and heuristic scoring
// ---------------------------------------------------------------------------

function dedupe(jobs) {
  const seen = new Map();
  for (const job of jobs) {
    const key = `${job.title}|${job.company}`.toLowerCase().replace(/\s+/g, " ");
    if (!seen.has(key)) seen.set(key, job);
  }
  return [...seen.values()];
}

function isExcluded(job) {
  const title = job.title.toLowerCase();
  return prefs.excludeTitleWords.some((w) => title.includes(w));
}

function daysOld(job) {
  if (!job.posted) return 999;
  return (Date.now() - new Date(job.posted).getTime()) / 86400000;
}

function scoreJob(job) {
  const title = job.title.toLowerCase();
  const desc = (job.description || "").toLowerCase();
  let score = 0;

  // Title relevance (the strongest signal).
  for (const kw of prefs.titleKeywords) {
    if (kw === "rf" ? /\brf\b/.test(title) : title.includes(kw)) score += 12;
  }
  if (title.includes("engineer")) score += 8;
  if (title.includes("senior")) score -= 5; // mid-level target; senior is borderline

  // Description relevance.
  let descHits = 0;
  for (const kw of prefs.descriptionKeywords) {
    if (desc.includes(kw)) descHits++;
  }
  score += Math.min(descHits * 3, 21);

  // Salary fit.
  if (job.salaryMax && job.salaryMax < prefs.salaryMin * 0.85) score -= 40;
  if (job.salaryMin && job.salaryMin >= prefs.salaryMin) score += 15;
  else if (job.salaryMax && job.salaryMax >= prefs.salaryMin) score += 8;

  // Recency.
  const age = daysOld(job);
  if (age <= 7) score += 10;
  else if (age <= 14) score += 5;

  return score;
}

// ---------------------------------------------------------------------------
// Optional Claude re-ranking
// ---------------------------------------------------------------------------

async function rankWithClaude(candidates) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    console.error("Claude ranking: @anthropic-ai/sdk not installed — using heuristic ranking.");
    return null;
  }

  const client = new Anthropic();
  const jobList = candidates.map((j) => ({
    id: j.id,
    title: j.title,
    company: j.company,
    location: j.location,
    salary: j.salaryMin || j.salaryMax
      ? `${j.salaryMin ?? "?"}-${j.salaryMax ?? "?"} ${j.salaryPredicted ? "(estimated)" : ""}`
      : "not listed",
    posted: j.posted,
    snippet: (j.description || "").slice(0, 500),
  }));

  const schema = {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            score: { type: "integer" },
            reason: { type: "string" },
          },
          required: ["id", "score", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["jobs"],
    additionalProperties: false,
  };

  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      system:
        "You are a job-matching assistant for a candidate looking for their next role. " +
        "Rank the provided job listings by fit and return only genuinely relevant matches.",
      output_config: { format: { type: "json_schema", schema } },
      messages: [
        {
          role: "user",
          content:
            `Candidate profile:\n${JSON.stringify(
              {
                targetRoles: prefs.roles,
                experience: `${prefs.experienceYears} years (mid-level)`,
                minimumSalary: `${prefs.salaryMin} ${prefs.currency}`,
                location: `${prefs.location.city}, Australia (on-site/hybrid)`,
              },
              null,
              2,
            )}\n\nJob listings:\n${JSON.stringify(jobList, null, 2)}\n\n` +
            `Select the best matches (at most ${TOP_N}), scored 0-100 for fit with a one-line ` +
            "reason each. Prioritise radio/RF/telecommunications relevance, then salary fit, " +
            "then seniority fit (mid-level: exclude graduate and executive roles). Omit jobs " +
            "that are clearly irrelevant, clearly below the salary floor, or at the wrong level.",
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      console.error("Claude ranking: request refused — using heuristic ranking.");
      return null;
    }
    const text = response.content.find((b) => b.type === "text")?.text;
    const ranked = JSON.parse(text).jobs;
    const byId = new Map(candidates.map((j) => [j.id, j]));
    const result = [];
    for (const r of ranked) {
      const job = byId.get(r.id);
      if (job) result.push({ ...job, score: r.score, reason: r.reason });
    }
    result.sort((a, b) => b.score - a.score);
    console.log(`Claude ranking: kept ${result.length} of ${candidates.length} candidates.`);
    return result.slice(0, TOP_N);
  } catch (err) {
    console.error(`Claude ranking failed: ${err.message} — using heuristic ranking.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [adzuna, museJobs] = await Promise.all([fetchAdzuna(), fetchTheMuse()]);

let candidates = dedupe([...adzuna.jobs, ...museJobs]).filter((j) => !isExcluded(j) && j.url);

for (const job of candidates) job.score = scoreJob(job);
candidates = candidates
  .filter((j) => j.score >= 15) // must show some real relevance
  .sort((a, b) => b.score - a.score)
  .slice(0, MAX_CANDIDATES_FOR_RANKING);

console.log(`${candidates.length} candidates after filtering.`);

let top = await rankWithClaude(candidates);
if (!top) {
  top = candidates.slice(0, TOP_N).map((j) => ({
    ...j,
    score: Math.max(0, Math.min(100, Math.round(j.score * 1.4))),
    reason: null,
  }));
}

let message = null;
if (!adzuna.available) {
  message = "Add Adzuna API keys for full AU job coverage — see README";
} else if (top.length === 0) {
  message = "No matching jobs found today — check back tomorrow";
}

const output = {
  updated: new Date().toISOString(),
  setupNeeded: !adzuna.available,
  message,
  jobs: top.map((j) => ({
    title: j.title,
    company: j.company,
    location: j.location,
    salary:
      j.salaryMin || j.salaryMax
        ? `$${Math.round((j.salaryMin || j.salaryMax) / 1000)}k–$${Math.round((j.salaryMax || j.salaryMin) / 1000)}k${j.salaryPredicted ? " est." : ""}`
        : null,
    url: j.url,
    score: j.score,
    reason: j.reason,
    source: j.source,
    posted: j.posted,
  })),
};

mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "jobs.json"), JSON.stringify(output, null, 2) + "\n");
console.log(`Wrote data/jobs.json with ${output.jobs.length} jobs.`);
