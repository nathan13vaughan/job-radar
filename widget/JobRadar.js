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

const GITHUB_USER = "nathan13vaughan";
const REPO = "job-radar";
const BRANCH = "main";
const TOKEN = ""; // <-- paste your fine-grained GitHub token here

const API_URL = `https://api.github.com/repos/${GITHUB_USER}/${REPO}/contents/data/jobs.json?ref=${BRANCH}`;

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
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    };
    const data = await req.loadJSON();
    if (!data || !Array.isArray(data.jobs)) throw new Error("Bad payload");
    fm.writeString(cachePath, JSON.stringify(data));
    return data;
  } catch (err) {
    if (fm.fileExists(cachePath)) {
      return JSON.parse(fm.readString(cachePath));
    }
    return { updated: null, message: `Setup needed: ${err}`, jobs: [] };
  }
}

function updatedLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const df = new DateFormatter();
  df.dateFormat = "EEE h:mma";
  return df.string(d);
}

// ---------------------------------------------------------------------------
// Widget rendering
// ---------------------------------------------------------------------------

const ACCENT = new Color("#2f81f7");
const PRIMARY = Color.dynamic(new Color("#1c1c1e"), new Color("#ffffff"));
const SECONDARY = Color.dynamic(new Color("#6e6e73"), new Color("#98989d"));

function addJobRow(widget, job, opts) {
  const row = widget.addStack();
  row.layoutVertically();
  if (job.url) row.url = job.url;

  const titleText = row.addText(job.title);
  titleText.font = Font.semiboldSystemFont(opts.titleSize);
  titleText.textColor = PRIMARY;
  titleText.lineLimit = 1;

  const subParts = [job.company];
  if (job.salary) subParts.push(job.salary);
  const subText = row.addText(subParts.join("  ·  "));
  subText.font = Font.systemFont(opts.subSize);
  subText.textColor = SECONDARY;
  subText.lineLimit = 1;

  if (opts.showReason && job.reason) {
    const reasonText = row.addText(job.reason);
    reasonText.font = Font.systemFont(opts.subSize - 1);
    reasonText.textColor = ACCENT;
    reasonText.lineLimit = 1;
  }
}

function buildWidget(data) {
  const widget = new ListWidget();
  widget.refreshAfterDate = new Date(Date.now() + 4 * 60 * 60 * 1000);
  widget.setPadding(14, 14, 12, 14);

  const family = config.widgetFamily || "medium";

  // Header
  const header = widget.addStack();
  header.centerAlignContent();
  const icon = header.addText("📡 ");
  icon.font = Font.systemFont(family === "small" ? 11 : 13);
  const title = header.addText("Job Radar");
  title.font = Font.boldSystemFont(family === "small" ? 11 : 13);
  title.textColor = ACCENT;
  header.addSpacer();
  const stamp = header.addText(updatedLabel(data.updated));
  stamp.font = Font.systemFont(9);
  stamp.textColor = SECONDARY;
  widget.addSpacer(6);

  if (data.message && data.jobs.length === 0) {
    const msg = widget.addText(data.message);
    msg.font = Font.systemFont(12);
    msg.textColor = SECONDARY;
    widget.addSpacer();
    return widget;
  }

  const layouts = {
    small: { rows: 2, titleSize: 11, subSize: 9, showReason: false },
    medium: { rows: 3, titleSize: 13, subSize: 11, showReason: false },
    large: { rows: 6, titleSize: 13, subSize: 11, showReason: true },
    extraLarge: { rows: 6, titleSize: 14, subSize: 12, showReason: true },
  };
  const opts = layouts[family] || layouts.medium;

  const jobs = data.jobs.slice(0, opts.rows);
  for (let i = 0; i < jobs.length; i++) {
    addJobRow(widget, jobs[i], opts);
    if (i < jobs.length - 1) widget.addSpacer(family === "small" ? 4 : 7);
  }
  if (family === "small" && jobs[0]?.url) widget.url = jobs[0].url;

  widget.addSpacer();
  if (data.message) {
    const note = widget.addText(data.message);
    note.font = Font.italicSystemFont(9);
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
  headerRow.addText("📡 Job Radar", data.updated ? `Updated ${updatedLabel(data.updated)}` : "");
  table.addRow(headerRow);

  if (data.message) {
    const msgRow = new UITableRow();
    msgRow.addText(data.message);
    table.addRow(msgRow);
  }

  for (const job of data.jobs) {
    const row = new UITableRow();
    row.height = job.reason ? 80 : 60;
    const sub = [job.company, job.salary, job.reason].filter(Boolean).join("  ·  ");
    const cell = row.addText(job.title, sub);
    cell.titleFont = Font.semiboldSystemFont(15);
    cell.subtitleFont = Font.systemFont(12);
    cell.subtitleColor = Color.gray();
    if (job.score != null) {
      const scoreCell = row.addText(String(job.score));
      scoreCell.rightAligned();
      scoreCell.widthWeight = 12;
      cell.widthWeight = 88;
    }
    row.onSelect = () => Safari.open(job.url);
    table.addRow(row);
  }
  table.present(false);
}

// ---------------------------------------------------------------------------

const data = await loadData();

if (config.runsInWidget) {
  Script.setWidget(buildWidget(data));
} else {
  presentTable(data);
}
Script.complete();
