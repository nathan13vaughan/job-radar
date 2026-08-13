// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: broadcast-tower;
//
// Job Radar — shows your top job matches, refreshed daily by GitHub Actions.
//
// SETUP (one-time):
//   1. Fill in TOKEN below with a fine-grained GitHub token (Contents: Read-only,
//      scoped to only the job-radar repo). See the repo README for exact steps.
//   2. Add a Scriptable widget to your home screen and pick this script.
// The script keeps itself up to date from the repo after that.

const GITHUB_USER = "nathan13vaughan";
const REPO = "job-radar";
const BRANCH = "main";
const TOKEN = ""; // <-- paste your fine-grained GitHub token here

const API_URL = `https://api.github.com/repos/${GITHUB_USER}/${REPO}/contents/data/jobs.json?ref=${BRANCH}`;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const ACCENT = Color.dynamic(new Color("#2563eb"), new Color("#60a5fa"));
const SALARY = Color.dynamic(new Color("#15803d"), new Color("#4ade80"));
const PRIMARY = Color.dynamic(new Color("#111827"), new Color("#f3f4f6"));
const SECONDARY = Color.dynamic(new Color("#6b7280"), new Color("#9ca3af"));
const BG_TOP = Color.dynamic(new Color("#ffffff"), new Color("#1c2030"));
const BG_BOTTOM = Color.dynamic(new Color("#eef1f7"), new Color("#0f1118"));

function badgeColor(score) {
  if (score >= 80) return new Color("#16a34a");
  if (score >= 60) return new Color("#d97706");
  return new Color("#64748b");
}

// ---------------------------------------------------------------------------
// Data loading (network with on-disk fallback so the widget works offline)
// ---------------------------------------------------------------------------

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "job-radar-cache.json");

async function loadData() {
  try {
    const req = new Request(API_URL);
    req.headers = {
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN.trim()}` } : {}),
    };
    const data = await req.loadJSON();
    const status = req.response ? req.response.statusCode : 0;
    if (status === 401) {
      throw new Error("GitHub rejected the token — re-paste it into the TOKEN line");
    }
    if (status === 404) {
      throw new Error(
        TOKEN
          ? "Token can't see the repo — it needs Contents: Read-only on job-radar"
          : "TOKEN is empty — paste your GitHub token into the script",
      );
    }
    if (!data || !Array.isArray(data.jobs)) {
      throw new Error(`GitHub error ${status}: ${data?.message || "unexpected response"}`);
    }
    fm.writeString(cachePath, JSON.stringify(data));
    return data;
  } catch (err) {
    if (fm.fileExists(cachePath)) {
      return JSON.parse(fm.readString(cachePath));
    }
    return { updated: null, message: `⚠️ ${err.message || err}`, jobs: [] };
  }
}

function updatedLabel(iso) {
  if (!iso) return "";
  const df = new DateFormatter();
  df.dateFormat = "EEE h:mma";
  return df.string(new Date(iso));
}

function ageLabel(posted) {
  if (!posted) return null;
  const days = Math.floor((Date.now() - new Date(posted).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function shortLocation(location) {
  return (location || "").split(",")[0].trim();
}

// ---------------------------------------------------------------------------
// Widget rendering
// ---------------------------------------------------------------------------

function addHeader(widget, data, family) {
  const small = family === "small";
  const header = widget.addStack();
  header.centerAlignContent();

  const sym = SFSymbol.named("dot.radiowaves.left.and.right");
  sym.applyFont(Font.boldSystemFont(small ? 11 : 13));
  const icon = header.addImage(sym.image);
  icon.tintColor = ACCENT;
  icon.imageSize = new Size(small ? 12 : 15, small ? 12 : 15);
  header.addSpacer(4);

  const title = header.addText("JOB RADAR");
  title.font = Font.heavySystemFont(small ? 10 : 11);
  title.textColor = ACCENT;

  header.addSpacer();
  const stamp = header.addText(updatedLabel(data.updated));
  stamp.font = Font.mediumSystemFont(8);
  stamp.textColor = SECONDARY;
}

function addJobRow(widget, job, opts) {
  const row = widget.addStack();
  row.centerAlignContent();
  if (job.url) row.url = job.url;

  const left = row.addStack();
  left.layoutVertically();

  const titleText = left.addText(job.title);
  titleText.font = Font.semiboldSystemFont(opts.titleSize);
  titleText.textColor = PRIMARY;
  titleText.lineLimit = 1;

  left.addSpacer(1);
  const sub = left.addStack();
  sub.centerAlignContent();
  if (job.salary) {
    const salaryText = sub.addText(job.salary);
    salaryText.font = Font.semiboldSystemFont(opts.subSize);
    salaryText.textColor = SALARY;
    salaryText.lineLimit = 1;
    const dot = sub.addText("  ·  ");
    dot.font = Font.systemFont(opts.subSize);
    dot.textColor = SECONDARY;
  }
  const companyText = sub.addText(job.company);
  companyText.font = Font.systemFont(opts.subSize);
  companyText.textColor = SECONDARY;
  companyText.lineLimit = 1;

  if (opts.thirdLine) {
    const extra =
      job.reason ||
      [job.experience, shortLocation(job.location), ageLabel(job.posted)].filter(Boolean).join("  ·  ");
    if (extra) {
      left.addSpacer(1);
      const extraText = left.addText(extra);
      extraText.font = job.reason ? Font.italicSystemFont(opts.subSize - 1) : Font.systemFont(opts.subSize - 1);
      extraText.textColor = job.reason ? ACCENT : SECONDARY;
      extraText.lineLimit = 1;
    }
  }

  row.addSpacer();

  if (opts.badge && job.score != null) {
    const badge = row.addStack();
    badge.backgroundColor = badgeColor(job.score);
    badge.cornerRadius = 7;
    badge.setPadding(2, 6, 2, 6);
    const badgeText = badge.addText(String(job.score));
    badgeText.font = Font.boldSystemFont(10);
    badgeText.textColor = Color.white();
  }
}

function addEmptyState(widget, message) {
  widget.addSpacer();
  const stack = widget.addStack();
  stack.addSpacer();
  const inner = stack.addStack();
  inner.layoutVertically();
  inner.centerAlignContent();
  const msg = inner.addText(message);
  msg.font = Font.mediumSystemFont(11);
  msg.textColor = SECONDARY;
  msg.centerAlignText();
  msg.lineLimit = 3;
  stack.addSpacer();
  widget.addSpacer();
}

function buildWidget(data) {
  const widget = new ListWidget();
  widget.refreshAfterDate = new Date(Date.now() + 4 * 60 * 60 * 1000);

  const gradient = new LinearGradient();
  gradient.colors = [BG_TOP, BG_BOTTOM];
  gradient.locations = [0, 1];
  widget.backgroundGradient = gradient;

  const family = config.widgetFamily || "medium";
  widget.setPadding(12, 14, 10, 14);

  addHeader(widget, data, family);
  widget.addSpacer(family === "small" ? 5 : 8);

  if (data.jobs.length === 0) {
    addEmptyState(widget, data.message || "No matching jobs today");
    return widget;
  }

  const layouts = {
    small: { rows: 2, titleSize: 10.5, subSize: 9, badge: false, thirdLine: false, gap: 5 },
    medium: { rows: 4, titleSize: 11.5, subSize: 9.5, badge: true, thirdLine: false, gap: 5 },
    large: { rows: 6, titleSize: 12, subSize: 10, badge: true, thirdLine: true, gap: 6 },
    extraLarge: { rows: 6, titleSize: 13, subSize: 11, badge: true, thirdLine: true, gap: 8 },
  };
  const opts = layouts[family] || layouts.medium;

  const jobs = data.jobs.slice(0, opts.rows);
  for (let i = 0; i < jobs.length; i++) {
    addJobRow(widget, jobs[i], opts);
    if (i < jobs.length - 1) widget.addSpacer(opts.gap);
  }
  if (family === "small" && jobs[0]?.url) widget.url = jobs[0].url;

  widget.addSpacer();
  if (data.message) {
    const note = widget.addText(data.message);
    note.font = Font.italicSystemFont(8.5);
    note.textColor = SECONDARY;
    note.lineLimit = 1;
  }
  return widget;
}

// ---------------------------------------------------------------------------
// In-app view: full tappable list of all matches
// ---------------------------------------------------------------------------

function presentTable(data) {
  const table = new UITable();
  table.showSeparators = true;

  const headerRow = new UITableRow();
  headerRow.isHeader = true;
  headerRow.addText(
    "📡 Job Radar",
    [data.jobs.length ? `${data.jobs.length} matches` : null, data.updated ? `updated ${updatedLabel(data.updated)}` : null]
      .filter(Boolean)
      .join(" · "),
  );
  table.addRow(headerRow);

  if (data.message) {
    const msgRow = new UITableRow();
    msgRow.addText(data.message);
    table.addRow(msgRow);
  }

  for (const job of data.jobs) {
    const row = new UITableRow();
    row.height = job.reason ? 84 : 64;
    const subParts = [job.salary, job.experience, job.company, shortLocation(job.location), ageLabel(job.posted)].filter(Boolean);
    const sub = job.reason ? `${subParts.join("  ·  ")}\n${job.reason}` : subParts.join("  ·  ");
    const cell = row.addText(job.title, sub);
    cell.titleFont = Font.semiboldSystemFont(15);
    cell.subtitleFont = Font.systemFont(12);
    cell.subtitleColor = Color.gray();
    if (job.score != null) {
      const scoreCell = row.addText(String(job.score));
      scoreCell.rightAligned();
      scoreCell.titleFont = Font.boldSystemFont(15);
      scoreCell.titleColor = badgeColor(job.score);
      scoreCell.widthWeight = 12;
      cell.widthWeight = 88;
    }
    row.onSelect = () => Safari.open(job.url);
    table.addRow(row);
  }
  table.present(false);
}

// ---------------------------------------------------------------------------
// Self-update: fetch the latest widget script from the repo and replace this
// file, preserving the TOKEN configured above. Never breaks the widget — any
// failure just means "no update this time".
// ---------------------------------------------------------------------------

async function selfUpdate() {
  try {
    const req = new Request(
      `https://api.github.com/repos/${GITHUB_USER}/${REPO}/contents/widget/JobRadar.js?ref=${BRANCH}`,
    );
    req.headers = {
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN.trim()}` } : {}),
    };
    let remote = await req.loadString();
    if (req.response?.statusCode !== 200) return;
    if (!remote.includes("Job Radar") || remote.length < 1000) return; // sanity check

    if (TOKEN) {
      const withToken = remote.replace(/const TOKEN = "[^"]*";/, () => `const TOKEN = "${TOKEN.trim()}";`);
      if (!withToken.includes(TOKEN.trim())) return; // pattern changed — don't risk wiping the token
      remote = withToken;
    }

    // Scripts may live in iCloud Drive or local storage; pick the right FileManager.
    let sfm = FileManager.local();
    try {
      const icloud = FileManager.iCloud();
      if (icloud.fileExists(module.filename)) {
        sfm = icloud;
        await sfm.downloadFileFromiCloud(module.filename);
      }
    } catch (e) {}

    const current = sfm.readString(module.filename);
    if (current !== remote) {
      sfm.writeString(module.filename, remote);
      console.log("Job Radar: updated to the latest version from GitHub.");
    }
  } catch (e) {
    console.log(`Job Radar: self-update skipped (${e})`);
  }
}

// ---------------------------------------------------------------------------

const data = await loadData();

if (config.runsInWidget) {
  Script.setWidget(buildWidget(data));
} else {
  presentTable(data);
}
await selfUpdate();
Script.complete();
