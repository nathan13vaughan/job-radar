// Job Radar — daily job finder.
// Pulls listings from Adzuna (AU) and The Muse, scores them against
// preferences.json, optionally re-ranks with Claude, and writes data/jobs.json
// for the Scriptable widget to consume.
//
// Env vars (all optional — the script degrades gracefully without them):
//   ADZUNA_APP_ID / ADZUNA_APP_KEY  — free keys from https://developer.adzuna.com
//   ANTHROPIC_API_KEY               — enables Claude re-ranking with per-job reasons

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

// Find a stated experience requirement in the ad text.
// Returns { min, max } in years (max null for open-ended "5+ years") or null.
function extractRequiredYears(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  // Scan every "N years" / "N-M years" mention, but only trust ones that talk
  // about experience — not "25 years in business" or "5 year warranty".
  const re = /(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s*\+?\s*(?:years?|yrs?)([^.]{0,50})/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const after = m[3] || "";
    const before = t.slice(Math.max(0, m.index - 45), m.index);
    const contextOk =
      /experience|exp\b|in a similar|in the (?:role|field|industry)|working (?:in|with)/.test(after) ||
      /experience|require|minimum|at least|demonstrated/.test(before);
    if (!contextOk) continue;
    const min = +m[1];
    const max = m[2] ? +m[2] : /\+/.test(m[0]) || /minimum|at least|require/.test(t.slice(Math.max(0, m.index - 25), m.index)) ? null : +m[1];
    if (min < 1 || min > 15) continue; // company-history blurbs, not requirements
    if (max !== null && max < min) continue;
    return { min, max };
  }
  return null;
}

// Rough Melbourne-market expected salary (AUD/year) when the ad states nothing
// and no better estimate is available. Always displayed with a leading "~".
function heuristicEstimate(job) {
  const t = job.title.toLowerCase();
  if (/technician|technologist|rigger/.test(t)) return "~$80–100k";
  if (/senior|lead|specialist|principal/.test(t)) return "~$125–155k";
  if (/project engineer/.test(t)) return "~$105–135k";
  return "~$95–125k";
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
    max_days_old: "35",
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
      what_or: prefs.titleKeywords.filter((k) => !k.includes(" ")).join(" "),
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

// Word-boundary keyword matching: "radio" must not match "radiologist",
// while "telecom" should still match "telecommunications".
function keywordInTitle(kw, titleLower) {
  if (kw === "rf") return /\brf\b/.test(titleLower);
  if (kw.startsWith("telecom")) return /\btelecom\w*/.test(titleLower);
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}s?\\b`).test(titleLower);
}

function titleHasDomainKeyword(title) {
  const t = title.toLowerCase();
  return prefs.titleKeywords.some((kw) => keywordInTitle(kw, t));
}

function scoreJob(job) {
  const title = job.title.toLowerCase();
  const desc = (job.description || "").toLowerCase();
  let score = 0;

  // Title relevance (the strongest signal).
  for (const kw of prefs.titleKeywords) {
    if (keywordInTitle(kw, title)) score += 12;
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

  // A stated experience requirement squarely at the candidate's level is a
  // strong signal the role is pitched right (out-of-band ones are excluded
  // upstream before scoring).
  if (job.requiredYears && job.requiredYears.min >= 2) score += 10;

  return score;
}

// ---------------------------------------------------------------------------
// Optional Claude re-ranking
// ---------------------------------------------------------------------------

function buildRankingInput(candidates) {
  const jobList = candidates.map((j) => ({
    id: j.id,
    title: j.title,
    company: j.company,
    location: j.location,
    salary: j.salaryMin || j.salaryMax
      ? `${j.salaryMin ?? "?"}-${j.salaryMax ?? "?"} ${j.salaryPredicted ? "(estimated)" : ""}`
      : "not listed",
    statedExperience: j.requiredYears
      ? `${j.requiredYears.min}${j.requiredYears.max === null ? "+" : `-${j.requiredYears.max}`} years`
      : "not stated",
    posted: j.posted,
    snippet: (j.description || "").slice(0, 500),
  }));

  const profile = {
    targetRoles: prefs.roles,
    experience: `${prefs.experienceYears} years (mid-level, strict)`,
    minimumSalary: `${prefs.salaryMin} ${prefs.currency}`,
    location: `${prefs.location.city}, Australia (on-site/hybrid)`,
  };

  const instruction =
    `Select the best matches (at most ${TOP_N}), scored 0-100 for fit with a one-line ` +
    "reason each. Prioritise radio/RF/telecommunications relevance, then salary fit, " +
    "then experience fit. Systems engineering roles are relevant when connected to " +
    "radio, RF, communications, defence, or mission systems — exclude pure IT " +
    "infrastructure 'systems engineer' roles (Windows/cloud/sysadmin). The experience " +
    `band is strict: the candidate has ${prefs.experienceYears} years, so exclude ` +
    "roles that state a requirement above that band (e.g. 7+ years), roles pitched at " +
    "principal/leadership level, and junior/graduate roles. A plain 'Senior' title is " +
    "acceptable only if the ad suggests it suits someone with ~5 years. Omit jobs that " +
    "are clearly irrelevant or clearly below the salary floor. For every selected job " +
    'also provide salaryEstimate: the stated salary if the ad gives one, otherwise a ' +
    'realistic annual AUD range for this role at this level in Melbourne, formatted ' +
    'exactly like "$120–140k".';

  return { jobList, profile, instruction };
}

function applyRanking(ranked, candidates, label) {
  const byId = new Map(candidates.map((j) => [j.id, j]));
  const result = [];
  for (const r of ranked) {
    const job = byId.get(r.id);
    if (!job) continue;
    const est = (r.salaryEstimate || "").trim();
    if (est) job.claudeEstimate = est.startsWith("~") ? est : `~${est}`;
    result.push({ ...job, score: r.score, reason: r.reason });
  }
  result.sort((a, b) => b.score - a.score);
  console.log(`${label}: kept ${result.length} of ${candidates.length} candidates.`);
  return result.slice(0, TOP_N);
}

// Backend 1: Anthropic API (ANTHROPIC_API_KEY secret) with structured outputs.
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
  const { jobList, profile, instruction } = buildRankingInput(candidates);

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
            salaryEstimate: { type: "string" },
          },
          required: ["id", "score", "reason", "salaryEstimate"],
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
            `Candidate profile:\n${JSON.stringify(profile, null, 2)}\n\n` +
            `Job listings:\n${JSON.stringify(jobList, null, 2)}\n\n${instruction}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      console.error("Claude ranking: request refused — trying next backend.");
      return null;
    }
    const text = response.content.find((b) => b.type === "text")?.text;
    return applyRanking(JSON.parse(text).jobs, candidates, "Claude API ranking");
  } catch (err) {
    console.error(`Claude API ranking failed: ${err.message} — trying next backend.`);
    return null;
  }
}

// Backend 2: Claude Code CLI using a Claude Pro/Max subscription
// (CLAUDE_CODE_OAUTH_TOKEN secret from `claude setup-token`). No API billing —
// usage comes out of the subscription's quota.
function rankWithClaudeCode(candidates) {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) return null;

  const { jobList, profile, instruction } = buildRankingInput(candidates);
  const stdinPayload = JSON.stringify({ candidateProfile: profile, jobListings: jobList }, null, 2);
  const prompt =
    "You are ranking job listings for a candidate. The JSON on stdin contains " +
    `the candidate profile and the listings. ${instruction} ` +
    'Respond with ONLY a JSON object of the form {"jobs":[{"id":"...","score":0,"reason":"...","salaryEstimate":"$120–140k"}]} — no prose, no code fences.';

  try {
    const proc = spawnSync("claude", ["-p", prompt, "--output-format", "json", "--allowedTools", ""], {
      input: stdinPayload,
      encoding: "utf8",
      timeout: 240000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (proc.error) throw proc.error;
    if (proc.status !== 0) {
      let detail = "";
      try {
        detail = JSON.parse(proc.stdout).result || "";
      } catch {}
      if (!detail) {
        detail = [proc.stderr, proc.stdout]
          .map((s) => (s || "").trim())
          .filter(Boolean)
          .join(" | ")
          .slice(0, 400);
      }
      throw new Error(`claude exited ${proc.status}: ${detail || "(no output)"}`);
    }

    const envelope = JSON.parse(proc.stdout);
    const text = envelope.result || "";
    const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) throw new Error("no JSON found in response");
    return applyRanking(JSON.parse(jsonText).jobs, candidates, "Claude subscription ranking");
  } catch (err) {
    console.error(`Claude subscription ranking failed: ${err.message} — trying next backend.`);
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

// Strict experience gate: when an ad states a requirement, it must fit a
// candidate with 3-5 years — exclude roles demanding more than the candidate
// has, or capped below their level. Ads that don't state years pass through.
const [candMin, candMax] = prefs.experienceYears.split("-").map(Number);
for (const job of candidates) job.requiredYears = extractRequiredYears(job.description);
if (prefs.experienceStrict) {
  const before = candidates.length;
  candidates = candidates.filter((j) => {
    if (!j.requiredYears) return true;
    if (j.requiredYears.min > candMax) return false; // e.g. "7+ years"
    if (j.requiredYears.max !== null && j.requiredYears.max < candMin - 1) return false; // junior-capped
    return true;
  });
  if (candidates.length < before) {
    console.log(`Experience gate: excluded ${before - candidates.length} jobs outside ${prefs.experienceYears} years.`);
  }
}

// Two-tier relevance gate:
//  - a telecom/radio word in the title qualifies a job at a low score bar;
//  - a generic "engineer" title must show domain keywords in the description
//    (stops pre-cast/software/production engineer roles that mention one
//    buzzword from sneaking in).
// When Claude ranking is available the bars drop, since borderline candidates
// get properly judged before publishing; Adzuna truncates descriptions, so
// keyword counting alone underrates genuinely relevant listings.
const claudeEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
for (const job of candidates) job.score = scoreJob(job);

const strictPass = (j) =>
  titleHasDomainKeyword(j.title)
    ? j.score >= 15
    : j.title.toLowerCase().includes("engineer") && j.descHits >= 3 && j.score >= 25;
const loosePass = (j) =>
  titleHasDomainKeyword(j.title)
    ? j.score >= 8
    : j.title.toLowerCase().includes("engineer") && j.descHits >= 1 && j.score >= 15;

candidates = candidates
  .filter(claudeEnabled ? loosePass : strictPass)
  .sort((a, b) => b.score - a.score)
  .slice(0, MAX_CANDIDATES_FOR_RANKING);

console.log(`${candidates.length} candidates after filtering.`);

let top = null;
let rankedBy = "keyword";
if (candidates.length > 0) {
  top = await rankWithClaude(candidates);
  if (top) {
    rankedBy = "claude-api";
  } else {
    top = rankWithClaudeCode(candidates);
    if (top) rankedBy = "claude-subscription";
  }
}
if (!top) {
  // Heuristic fallback publishes only strict-gate candidates — the loosened
  // pool exists solely for Claude to judge, and Claude didn't run.
  top = candidates
    .filter(strictPass)
    .slice(0, TOP_N)
    .map((j) => ({
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
  rankedBy,
  criteria: `${prefs.experienceYears} yrs · $${Math.round(prefs.salaryMin / 1000)}k+ · ${prefs.location.city}`,
  jobs: top.map((j) => ({
    title: j.title,
    company: j.company,
    location: j.location,
    salary: formatSalary(j) || j.claudeEstimate || heuristicEstimate(j),
    salaryEstimated: !formatSalary(j),
    experience: j.requiredYears
      ? j.requiredYears.max !== null && j.requiredYears.max !== j.requiredYears.min
        ? `${j.requiredYears.min}-${j.requiredYears.max} yrs`
        : `${j.requiredYears.min}${j.requiredYears.max === null ? "+" : ""} yrs`
      : null,
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
