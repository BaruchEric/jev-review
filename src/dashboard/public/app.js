// Mirrors SCREEN_THRESHOLD in src/domain/config.ts: signals at or above it are followed.
const THRESHOLD = 0.7;
// Severity is an expected score on the 0–3 rubric in src/domain/config.ts.
const SEVERITY_MAX = 3;

const DIMENSIONS = [
  ["correctness", "Correctness", "Corr"],
  ["security", "Security", "Sec"],
  ["reliability", "Reliability", "Rel"],
  ["compatibility", "Compatibility", "Compat"],
  ["testGap", "Test gap", "Tests"],
];
const DIMENSION_LABEL = Object.fromEntries(DIMENSIONS.map(([key, label]) => [key, label]));

const app = document.getElementById("app");
const meta = document.getElementById("meta");
let showValues = false;
let lastState = null;
let lastKey = "";

// All untrusted text goes through text nodes, never innerHTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "style") {
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    } else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const fixed = (value, digits = 2) => (isNum(value) ? value.toFixed(digits) : "–");

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return "just now";
}

function splitPath(path) {
  const text = String(path ?? "");
  const cut = text.lastIndexOf("/") + 1;
  return [text.slice(0, cut), text.slice(cut)];
}

// Sequential single-hue ramp, theme-aware through CSS custom properties.
function fill(p) {
  const x = Math.min(1, Math.max(0, p));
  return x <= 0.5
    ? `color-mix(in oklab, var(--seq-mid) ${(x * 200).toFixed(1)}%, var(--seq-lo))`
    : `color-mix(in oklab, var(--seq-hi) ${((x - 0.5) * 200).toFixed(1)}%, var(--seq-mid))`;
}

function section(label, aside, ...content) {
  return h(
    "section",
    { class: "block" },
    h("div", { class: "block-head" }, h("h2", {}, label), aside),
    ...content,
  );
}

function quiet(title, detail, command) {
  return h(
    "div",
    { class: "quiet" },
    h("p", { class: "quiet-title" }, title),
    detail && h("p", { class: "quiet-detail" }, detail),
    command && h("code", { class: "quiet-command" }, command),
  );
}

function summary(report) {
  const findings = report.findings;
  const blocking = findings.filter((f) => f.action === "request_changes").length;
  const tests = report.changedTestFiles;
  const stats = [
    { value: report.screenedFiles, label: "files" },
    { value: tests.length, label: "tests", title: tests.join("\n") || null },
    { value: report.followedSignals, label: "followed", title: `signals ≥ ${THRESHOLD.toFixed(2)} inspected` },
    { value: findings.length, label: "findings", cls: "lead" },
    { value: blocking, label: "request changes", cls: blocking > 0 ? "alert" : "" },
  ];
  return h(
    "dl",
    { class: "stats" },
    stats.map((stat) =>
      h(
        "div",
        { class: `stat ${stat.cls ?? ""}`, title: stat.title },
        h("dt", {}, stat.label),
        h("dd", {}, isNum(stat.value) ? stat.value : "–"),
      ),
    ),
  );
}

function workflow(report) {
  const flow = report.workflow;
  if (!flow) return null;

  const steps = [
    [flow.screenedCells, "cells"],
    [flow.thresholdSignals, "signals"],
    [flow.followedSignals, "inspected"],
    [flow.locatedFindings, "located"],
    [flow.routedFindings, "routed"],
  ];

  return section(
    "Workflow",
    h("span", { class: "count" }, `${flow.profiledFiles ?? 0} profiled`),
    h(
      "ol",
      { class: "flow" },
      steps.map(([value, label], index) =>
        h(
          "li",
          {},
          index > 0 && h("span", { class: "flow-arrow", "aria-hidden": "true" }, "→"),
          h("strong", {}, isNum(value) ? value : "–"),
          h("span", {}, label),
        ),
      ),
    ),
  );
}

function profiles(report) {
  const list = report.profiles;
  if (!Array.isArray(list) || list.length === 0) return null;

  const table = h(
    "table",
    { class: "profiles" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        ["File", "Change", "Priority"].map((label) => h("th", { scope: "col" }, label)),
      ),
    ),
    h(
      "tbody",
      {},
      list.map((profile) => {
        const [dir, base] = splitPath(profile.file);
        return h(
          "tr",
          {
            title: `change confidence ${fixed(profile.changeTypeConfidence)} · priority confidence ${fixed(profile.reviewPriorityConfidence)}`,
          },
          h(
            "td",
            { class: "profile-file" },
            h("code", { title: profile.file }, h("span", { class: "dir" }, dir), h("span", { class: "base" }, base)),
          ),
          h("td", { class: "profile-type" }, String(profile.changeType ?? "–")),
          h("td", { class: "profile-priority" }, severityMeter(profile.reviewPriority)),
        );
      }),
    ),
  );

  return section(
    "File profiles",
    h("span", { class: "count" }, list.length),
    h("div", { class: "profiles-wrap" }, table),
  );
}

function matrix(report) {
  const rows = [...report.matrix].sort((a, b) => maxP(b) - maxP(a));

  const toggle = h(
    "button",
    {
      class: "toggle",
      type: "button",
      "aria-pressed": String(showValues),
      title: "Show every probability",
      onclick: () => {
        showValues = !showValues;
        render(lastState);
      },
    },
    "0.00",
  );

  const legend = h(
    "div",
    { class: "legend" },
    h("span", { class: "legend-end" }, "0"),
    h(
      "span",
      { class: "legend-ramp", role: "img", "aria-label": `Probability scale, threshold ${THRESHOLD}` },
      h("i", { class: "legend-tick", style: { left: `${THRESHOLD * 100}%` } }),
    ),
    h("span", { class: "legend-end" }, "1"),
    toggle,
  );

  if (rows.length === 0) {
    return section("Noul matrix", null, quiet("No source files screened"));
  }

  const table = h(
    "table",
    { class: `matrix${showValues ? " show-values" : ""}` },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { scope: "col", class: "file-col" }, h("span", { class: "sr" }, "File")),
        DIMENSIONS.map(([key, label, short]) =>
          h(
            "th",
            { scope: "col", title: label },
            h("span", { class: "long" }, label),
            h("abbr", { class: "short", title: label }, short),
          ),
        ),
      ),
    ),
    h(
      "tbody",
      {},
      rows.map((row) => {
        const [dir, base] = splitPath(row.file);
        return h(
          "tr",
          {},
          h(
            "th",
            { scope: "row", class: "file", title: row.file },
            h("span", { class: "path" }, h("span", { class: "dir" }, dir), h("span", { class: "base" }, base)),
          ),
          DIMENSIONS.map(([key, label]) => {
            const p = row[key];
            if (!isNum(p)) return h("td", { class: "cell missing" }, h("span", { class: "v" }, "–"));
            const hot = p >= THRESHOLD;
            return h(
              "td",
              {
                class: `cell${hot ? " hot" : ""}${p >= 0.55 ? " deep" : ""}`,
                style: { "--fill": fill(p) },
                title: `${row.file}\n${label} ${fixed(p)}`,
              },
              h("span", { class: "v" }, fixed(p)),
            );
          }),
        );
      }),
    ),
  );

  return section("Noul matrix", legend, h("div", { class: "matrix-wrap" }, table));
}

function maxP(row) {
  return Math.max(0, ...DIMENSIONS.map(([key]) => (isNum(row[key]) ? row[key] : 0)));
}

function severityMeter(severity) {
  const segments = Array.from({ length: SEVERITY_MAX }, (_, i) => {
    const amount = isNum(severity) ? Math.min(1, Math.max(0, severity - i)) : 0;
    return h("i", { style: { "--amount": `${(amount * 100).toFixed(0)}%` } });
  });
  return h(
    "span",
    { class: "severity" },
    h("span", { class: "meter", "aria-hidden": "true" }, segments),
    h("span", { class: "num" }, fixed(severity, 1)),
  );
}

function findings(report) {
  const list = report.findings;
  const count = h("span", { class: "count" }, list.length);

  if (list.length === 0) {
    const followed = report.followedSignals;
    const detail =
      followed > 0
        ? `${followed} ${followed === 1 ? "signal" : "signals"} followed · none located`
        : `No signal reached ${THRESHOLD.toFixed(2)}`;
    return section("Findings", count, quiet("No findings", detail));
  }

  const table = h(
    "table",
    { class: "findings" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        ["Location", "Concern", "Severity", "Owner", "Action"].map((label) => h("th", { scope: "col" }, label)),
      ),
    ),
    h(
      "tbody",
      {},
      list.map((finding) => {
        const [dir, base] = splitPath(finding.file);
        const blocking = finding.action === "request_changes";
        return h(
          "tr",
          {
            title: `location confidence ${fixed(finding.locationConfidence)} · severity confidence ${fixed(finding.severityConfidence)}`,
          },
          h(
            "td",
            { class: "loc" },
            h(
              "code",
              { title: `${finding.file}:${finding.line}` },
              h("span", { class: "dir" }, dir),
              h("span", { class: "base" }, base),
              h("span", { class: "line" }, `:${finding.line ?? "?"}`),
            ),
          ),
          h(
            "td",
            { class: "dim" },
            h("span", {}, DIMENSION_LABEL[finding.dimension] ?? String(finding.dimension)),
            finding.mechanism && h("small", {}, String(finding.mechanism)),
          ),
          h("td", { class: "sev" }, h("span", { class: "sr" }, "severity "), severityMeter(finding.severity)),
          h("td", { class: "owner" }, finding.owner ? String(finding.owner) : "–"),
          h(
            "td",
            { class: `act ${blocking ? "blocking" : "comment"}` },
            h("span", { class: "glyph", "aria-hidden": "true" }),
            blocking ? "Request changes" : finding.action === "comment" ? "Comment" : String(finding.action),
          ),
        );
      }),
    ),
  );

  return section("Findings", count, table);
}

function renderMeta(state) {
  meta.replaceChildren();
  if (state?.status !== "ok") return;
  const scope = state.report.scope;
  const name = scope.split("/").filter(Boolean).pop() ?? scope;
  meta.append(
    h("span", { class: "scope", title: scope }, name),
    h("span", { class: "sep", "aria-hidden": "true" }, "·"),
    h("time", { datetime: state.savedAt, title: new Date(state.savedAt).toLocaleString() }, ago(state.savedAt)),
  );
}

function render(state) {
  lastState = state;
  renderMeta(state);
  document.body.dataset.status = state?.status ?? "offline";

  switch (state?.status) {
    case "ok":
      app.replaceChildren(
        ...[
          summary(state.report),
          workflow(state.report),
          profiles(state.report),
          matrix(state.report),
          findings(state.report),
        ].filter(Boolean),
      );
      break;
    case "empty":
      app.replaceChildren(quiet("No review yet", null, "npm run review:save -- <path>"));
      break;
    case "error":
      app.replaceChildren(quiet("Unreadable report", `${state.message} · ${state.source}`));
      break;
    default:
      app.replaceChildren(quiet("Server unavailable", null, "npm run dashboard"));
  }
}

async function load() {
  let state;
  try {
    const res = await fetch("/api/review", { cache: "no-store" });
    state = res.ok ? await res.json() : { status: "offline" };
  } catch {
    state = { status: "offline" };
  }
  const key = JSON.stringify(state);
  if (key === lastKey) return renderMeta(state);
  lastKey = key;
  render(state);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});
window.addEventListener("focus", load);
load();
