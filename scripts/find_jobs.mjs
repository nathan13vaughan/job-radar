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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "job-radar (github.com job widget)" },
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const delay = 8000 * (attempt + 1);
      console.log(`  ${res.status} — retrying in ${delay / 1000}s...`);
      await sleep(delay);
      continue;
    }
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
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

// Pull a salary out of the ad text when the API doesn't provide one.
// Returns { min, max, unit: "year" | "hour" | "day" } or null.
function extractSalary(text) {
  if (!text) return null;
  const t = text.replace(/,/g, "");
  let m;

  // Hourly: "$65 - $75 per hour", "$70/hr"
  m = t.match(/\$(\d{2,3})(?:\.\d{2})?\s*(?:-|–|to)\s*\$?(\d{2,3})(?:\.\d{2})?\s*(?:per hour|an hour|\/\s?hr|p\.?\s?h\b)/i) ||
      t.match(/\$(\d{2,3})(?:\.\d{2})?\s*(?:per hour|an hour|\/\s?hr|p\.?\s?h\b)/i);
  if (m) {
    const min = +m[1];
    const max = m[2] ? +m[2] : min;
    if (min >= 20 && max <= 250 && min <= max) return { min, max, unit: "hour" };
  }

  // Daily: "$800 - $950 per day", "$900/day"
  m = t.match(/\$(\d{3,4})\s*(?:-|–|to)\s*\$?(\d{3,4})\s*(?:per day|a day|\/\s?day|daily)/i) ||
      t.match(/\$(\d{3,4})\s*(?:per day|a day|\/\s?day|daily)/i);
  if (m) {
    const min = +m[1];
    const max = m[2] ? +m[2] : min;
    if (min >= 300 && max <= 3000 && min <= max) return { min, max, unit: "day" };
  }

  // Annual range: "$120k - $140k" or "$120000 - $140000"
  m = t.match(/\$?(\d{2,3})k\s*(?:-|–|to)\s*\$?(\d{2,3})k/i);
  if (m) {
    const min = +m[1] * 1000;
    const max = +m[2] * 1000;
    if (min >= 40000 && max <= 400000 && min <= max) return { min, max, unit: "year" };
  }
  m = t.match(/\$(\d{5,6})\s*(?:-|–|to)\s*\$?(\d{5,6})/);
  if (m) {
    const min = +m[1];
    const max = +m[2];
    if (min >= 40000 && max <= 400000 && min <= max) return { min, max, unit: "year" };
  }

  // Single figure — only with clear salary context, to avoid picking up
  // project budgets or contract values.
  m = t.match(/(?:salary|package|remuneration|circa|up to|earn)\D{0,12}\$(\d{5,6})/i) ||
      t.match(/\$(\d{5,6})\s*(?:per annum|pa\b|p\.a\.|a year|annually|\+\s?super)/i);
  if (m) {
    const v = +m[1];
    if (v >= 40000 && v <= 400000) return { min: v, max: v, unit: "year" };
  }
  m = t.match(/\$(\d{2,3})k\b/i);
  if (m) {
    const v = +m[1] * 1000;
    if (v >= 60000 && v <= 400000) return { min: v, max: v, unit: "year" };
  }

  return null;
}

// Human-readable salary for the widget, e.g. "$110k–$130k", "$85/hr", "$120k est."
function formatSalary(j) {
  if (!j.salaryMin && !j.salaryMax) return null;
  const lo = j.salaryMin || j.salaryMax;
  const hi = j.salaryMax || j.salaryMin;
  if (j.salaryUnit === "hour" || j.salaryUnit === "day") {
    const suffix = j.salaryUnit === "hour" ? "/hr" : "/day";
    return lo === hi ? `$${lo}${suffix}` : `$${lo}–$${hi}${suffix}`;
  }
  const fmt = (v) => `$${Math.round(v / 1000)}k`;
  const range = fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
  return j.salaryPredicted ? `${range} est.` : range;
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
  const baseParams = {
    app_id: appId,
    app_key: appKey,
    where: prefs.location.city,
    distance: String(prefs.location.maxDistanceKm),
    max_days_old: "28",
    sort_by: "date",
  };

  function collect(data) {
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
    return data.results?.length ?? 0;
  }

  let successes = 0;
  let failures = 0;

  // Targeted searches for each preferred role title.
  for (const role of prefs.roles) {
    const params = new URLSearchParams({ ...baseParams, results_per_page: "30", what: role });
    try {
      const n = collect(await fetchJson(`https://api.adzuna.com/v1/api/jobs/${prefs.location.country}/search/1?${params}`));
      console.log(`Adzuna: "${role}" -> ${n} results`);
      successes++;
    } catch (err) {
      console.error(`Adzuna: query "${role}" failed: ${err.message}`);
      failures++;
    }
    await sleep(400); // stay well inside the free-tier rate limit
  }

  // Broad sweep: any "engineer" listing that mentions one of the domain
  // keywords anywhere — catches titles the targeted searches miss
  // (e.g. "Field Services Engineer" on a radio network).
  for (const page of [1, 2]) {
    const params = new URLSearchParams({
      ...baseParams,
      results_per_page: "50",
      what_and: "engineer",
      what_or: prefs.titleKeywords.join(" "),
    });
    try {
      const n = collect(await fetchJson(`https://api.adzuna.com/v1/api/jobs/${prefs.location.country}/search/${page}?${params}`));
      console.log(`Adzuna: broad sweep page ${page} -> ${n} results`);
      successes++;
      if (n < 50) break;
    } catch (err) {
      console.error(`Adzuna: broad sweep page ${page} failed: ${err.message}`);
      failures++;
      break;
    }
    await sleep(400);
  }

  return { jobs, available: true, successes, failures };
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

function titleHasDomainKeyword(title) {
  const t = title.toLowerCase();
  return prefs.titleKeywords.some((kw) => (kw === "rf" ? /\brf\b/.test(t) : t.includes(kw)));
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
  for (const w of prefs.penaltyTitleWords || []) {
    if (title.includes(w)) score -= 25; // wrong engineering discipline
  }

  // Description relevance.
  let descHits = 0;
  for (const kw of prefs.descriptionKeywords) {
    if (desc.includes(kw)) descHits++;
  }
  job.descHits = descHits;
  score += Math.min(descHits * 3, 21);

  // Salary fit (annual figures only — hourly/daily rates aren't comparable).
  if (job.salaryUnit === "year") {
    if (job.salaryMax && job.salaryMax < prefs.salaryMin * 0.85) score -= 40;
    if (job.salaryMin && job.salaryMin >= prefs.salaryMin) score += 15;
    else if (job.salaryMax && job.salaryMax >= prefs.salaryMin) score += 8;
  }

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

// Fill in salary: API-provided figures are annual; otherwise mine the ad text.
for (const job of candidates) {
  if (job.salaryMin || job.salaryMax) {
    job.salaryUnit = "year";
  } else {
    const found = extractSalary(job.description);
    if (found) {
      job.salaryMin = found.min;
      job.salaryMax = found.max;
      job.salaryUnit = found.unit;
      job.salaryPredicted = false;
    }
  }
}

// Two-tier relevance gate:
//  - a telecom/radio word in the title qualifies a job at a low score bar;
//  - a generic "engineer" title must prove itself with several distinct
//    domain keywords in the description (stops pre-cast/software/production
//    engineer roles that mention one buzzword from sneaking in).
for (const job of candidates) job.score = scoreJob(job);
candidates = candidates
  .filter((j) => {
    if (titleHasDomainKeyword(j.title)) return j.score >= 15;
    if (j.title.toLowerCase().includes("engineer")) return j.descHits >= 3 && j.score >= 25;
    return false;
  })
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

let output = {
  updated: new Date().toISOString(),
  setupNeeded: !adzuna.available,
  message,
  jobs: top.map((j) => ({
    title: j.title,
    company: j.company,
    location: j.location,
    salary: formatSalary(j),
    url: j.url,
    score: j.score,
    reason: j.reason,
    source: j.source,
    posted: j.posted,
  })),
};

// If the fetch degraded (Adzuna configured but every query failed) and we'd be
// publishing an empty list, keep the previous results rather than blanking the
// widget over a transient outage.
if (output.jobs.length === 0 && adzuna.available && adzuna.successes === 0 && adzuna.failures > 0) {
  try {
    const previous = JSON.parse(readFileSync(join(root, "data", "jobs.json"), "utf8"));
    if (previous.jobs?.length) {
      output = {
        ...previous,
        message: "Job source temporarily unavailable — showing previous results",
      };
      console.log(`Sources down — keeping ${previous.jobs.length} previous jobs.`);
    }
  } catch {}
}

mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "jobs.json"), JSON.stringify(output, null, 2) + "\n");
console.log(`Wrote data/jobs.json with ${output.jobs.length} jobs.`);
