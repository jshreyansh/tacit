import fs from "fs";
import path from "path";
import { TERMCANVAS_DIR } from "./state-persistence.ts";
import type {
  AggregatedStats,
  InsightsAchievement,
  InsightsAtAGlanceSection,
  InsightsCodingStorySection,
  InsightsFrictionSection,
  InsightsInteractionStyleSection,
  InsightsOnTheHorizonSection,
  InsightsProjectAreasSection,
  InsightsResult,
  InsightsSuggestionsSection,
  InsightsToolComparisonCard,
  InsightsWhatWorksSection,
} from "./insights-shared.ts";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number): string {
  return `${value}%`;
}

function formatLabel(label: string): string {
  return label
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCliLabel(cliTool: "claude" | "codex"): string {
  return cliTool === "claude" ? "Claude Code" : "Codex";
}

function topEntries(data: Record<string, number>, limit = 6): Array<[string, number]> {
  return Object.entries(data)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function stackedBars(
  title: string,
  data: Record<string, number>,
  tone: "amber" | "mint" | "rose" | "slate",
  limit = 6,
): string {
  const entries = topEntries(data, limit);
  const maxValue = Math.max(...entries.map(([, value]) => value), 0);
  if (maxValue === 0) return "";

  const rows = entries
    .map(([label, value]) => {
      const width = Math.max(8, Math.round((value / maxValue) * 100));
      return `<div class="metric-row">
        <div class="metric-label">${escapeHtml(formatLabel(label))}</div>
        <div class="metric-track">
          <div class="metric-fill ${tone}" style="width:${width}%"></div>
        </div>
        <div class="metric-value">${formatNumber(value)}</div>
      </div>`;
    })
    .join("");

  return `<section class="panel">
    <div class="panel-kicker">Distribution</div>
    <h2>${escapeHtml(title)}</h2>
    <div class="metric-list">${rows}</div>
  </section>`;
}

function heatmap(data: Record<string, number>): string {
  const values = Array.from({ length: 24 }, (_, hour) => {
    const key = String(hour).padStart(2, "0");
    return { key, value: data[key] ?? 0 };
  });
  const maxValue = Math.max(...values.map((entry) => entry.value), 0);
  if (maxValue === 0) return "";

  const cells = values
    .map(({ key, value }) => {
      const intensity = value === 0 ? 0 : Math.max(0.14, value / maxValue);
      return `<div class="heat-cell" title="${escapeHtml(`${key}:00 - ${value} messages`)}">
        <span class="heat-cell-fill" style="opacity:${intensity}"></span>
        <span class="heat-hour">${key}</span>
      </div>`;
    })
    .join("");

  return `<section class="panel">
    <div class="panel-kicker">Rhythm</div>
    <h2>Time Of Day</h2>
    <p class="panel-copy">Message density across the day, aggregated from every eligible session, including metrics-only coverage.</p>
    <div class="heat-grid">${cells}</div>
  </section>`;
}

function statCards(insights: InsightsResult): string {
  const { stats } = insights;
  const totalHours = (stats.totalDurationMinutes / 60).toFixed(1);
  const analysisCoverage = 8 - Object.keys(insights.sectionErrors).length;
  const cards = [
    ["Sessions", formatNumber(stats.totalSessions)],
    ["Facet-backed", formatNumber(stats.facetBackedSessions)],
    ["Hours", `${totalHours}h`],
    ["Input Tokens", formatNumber(stats.totalInputTokens)],
    ["Output Tokens", formatNumber(stats.totalOutputTokens)],
    ["Lines Added", formatNumber(stats.totalLinesAdded)],
    ["Files Touched", formatNumber(stats.totalFilesModified)],
    ["Analysis Sections", `${analysisCoverage}/8`],
  ]
    .map(
      ([label, value]) => `<div class="stat-card">
        <div class="stat-value">${escapeHtml(value)}</div>
        <div class="stat-label">${escapeHtml(label)}</div>
      </div>`,
    )
    .join("");

  return `<section class="stats-grid">${cards}</section>`;
}

function coveragePanel(insights: InsightsResult): string {
  const { stats } = insights;
  const failures = Object.entries(insights.sectionErrors);
  const issues =
    failures.length === 0
      ? `<p>No AI synthesis sections failed. ${formatNumber(stats.cachedFacetSessions)} facet results came from cache, ${formatNumber(stats.metricsOnlySessions)} eligible sessions stayed metrics-only because of time decay, and ${formatNumber(stats.failedFacetSessions)} facet calls failed.</p>`
      : `<ul>${failures
          .map(
            ([key, error]) =>
              `<li><strong>${escapeHtml(formatLabel(key))}:</strong> ${escapeHtml(error ?? "Unknown error")}</li>`,
          )
          .join("")}</ul>`;

  return `<section class="panel notice-panel">
    <div class="panel-kicker">Coverage</div>
    <h2>What This Run Included</h2>
    <p class="panel-copy">This report scanned ${formatNumber(stats.totalScannedSessions)} files across Claude Code and Codex, kept ${formatNumber(stats.totalEligibleSessions)} sessions inside the 90-day eligibility window, and extracted rich facets for ${formatNumber(stats.facetBackedSessions)} of them. The remaining ${formatNumber(stats.metricsOnlySessions)} eligible sessions still contribute metrics to charts, pacing, tool usage, and trend lines.</p>
    ${issues}
  </section>`;
}

function atAGlance(section: InsightsAtAGlanceSection): string {
  return `<section class="hero-panel">
    <div class="hero-kicker">At A Glance</div>
    <h2>${escapeHtml(section.headline)}</h2>
    <ul class="hero-list">
      ${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}
    </ul>
  </section>`;
}

function timeTrends(stats: AggregatedStats): string {
  const entries = stats.dailyBreakdown.slice(-14);
  if (entries.length === 0) return "";

  const maxSessions = Math.max(...entries.map((entry) => entry.sessions), 0);
  const maxTokens = Math.max(...entries.map((entry) => entry.tokens), 0);
  const maxLines = Math.max(...entries.map((entry) => entry.linesAdded), 0);
  const columns = entries
    .map((entry) => {
      const sessionHeight =
        maxSessions === 0
          ? 6
          : Math.max(6, Math.round((entry.sessions / maxSessions) * 100));
      const tokenHeight =
        maxTokens === 0
          ? 6
          : Math.max(6, Math.round((entry.tokens / maxTokens) * 100));
      const lineHeight =
        maxLines === 0
          ? 6
          : Math.max(6, Math.round((entry.linesAdded / maxLines) * 100));
      return `<div class="trend-day">
        <div class="trend-day-bars">
          <div class="trend-bar amber" style="height:${sessionHeight}%"></div>
          <div class="trend-bar mint" style="height:${tokenHeight}%"></div>
          <div class="trend-bar rose" style="height:${lineHeight}%"></div>
        </div>
        <div class="trend-label">${escapeHtml(entry.date.slice(5))}</div>
      </div>`;
    })
    .join("");
  const totals = entries
    .map(
      (entry) => `<div class="trend-stat">
        <span>${escapeHtml(entry.date)}</span>
        <span>${formatNumber(entry.sessions)} sessions</span>
        <span>${formatNumber(entry.tokens)} tokens</span>
        <span>${formatNumber(entry.linesAdded)} lines</span>
      </div>`,
    )
    .join("");

  return `<section class="panel">
    <div class="panel-kicker">Time Trends</div>
    <h2>Time Trends</h2>
    <p class="panel-copy">A 14-day read on activity volume, token load, and code output. Each column is pure CSS, no charting library involved.</p>
    <div class="trend-legend">
      <span><i class="legend-dot amber"></i> Sessions</span>
      <span><i class="legend-dot mint"></i> Tokens</span>
      <span><i class="legend-dot rose"></i> Lines Added</span>
    </div>
    <div class="trend-chart">${columns}</div>
    <div class="trend-stats">${totals}</div>
  </section>`;
}

function renderTopList(title: string, entries: Array<[string, number]>): string {
  if (entries.length === 0) {
    return `<div class="tool-list"><strong>${escapeHtml(title)}:</strong> None</div>`;
  }
  return `<div class="tool-list"><strong>${escapeHtml(title)}:</strong> ${entries
    .map(([label, value]) => `${escapeHtml(formatLabel(label))} (${formatNumber(value)})`)
    .join(", ")}</div>`;
}

function toolComparisonCard(
  cliTool: "claude" | "codex",
  card: InsightsToolComparisonCard,
): string {
  return `<article class="tool-card tool-${cliTool}">
    <div class="mini-eyebrow">${escapeHtml(formatCliLabel(cliTool))}</div>
    <h3>${escapeHtml(formatCliLabel(cliTool))}</h3>
    <div class="tool-stat-grid">
      <div>
        <div class="tool-stat-value">${formatNumber(card.sessionCount)}</div>
        <div class="tool-stat-label">Sessions</div>
      </div>
      <div>
        <div class="tool-stat-value">${formatPercent(card.successRate)}</div>
        <div class="tool-stat-label">Success Rate</div>
      </div>
    </div>
    ${renderTopList("Top tools", card.topTools)}
    ${renderTopList("Top languages", card.topLanguages)}
  </article>`;
}

function toolComparison(stats: AggregatedStats): string {
  return `<section class="panel">
    <div class="panel-kicker">Tool Comparison</div>
    <h2>Tool Comparison</h2>
    <p class="panel-copy">Side-by-side signals for Claude Code and Codex across all eligible sessions, with success rates derived from facet-backed outcomes only.</p>
    <div class="tool-columns">
      ${toolComparisonCard("claude", stats.toolComparison.claude)}
      ${toolComparisonCard("codex", stats.toolComparison.codex)}
    </div>
  </section>`;
}

function projectAreas(section: InsightsProjectAreasSection | null): string {
  if (!section) return "";
  return `<section class="panel">
    <div class="panel-kicker">What You Work On</div>
    <h2>Project Areas</h2>
    <p class="panel-copy">${escapeHtml(section.summary)}</p>
    <div class="card-grid">
      ${section.areas
        .map(
          (area) => `<article class="mini-card">
            <div class="mini-eyebrow">${escapeHtml(area.share)}</div>
            <h3>${escapeHtml(area.name)}</h3>
            <p>${escapeHtml(area.evidence)}</p>
            <div class="mini-footer">${escapeHtml(area.opportunities)}</div>
          </article>`,
        )
        .join("")}
    </div>
  </section>`;
}

function interactionStyle(section: InsightsInteractionStyleSection | null): string {
  if (!section) return "";
  return `<section class="panel">
    <div class="panel-kicker">How You Collaborate</div>
    <h2>Interaction Style</h2>
    <p class="panel-copy">${escapeHtml(section.summary)}</p>
    <div class="stacked-cards">
      ${section.patterns
        .map(
          (pattern) => `<article class="detail-card">
            <h3>${escapeHtml(pattern.title)}</h3>
            <p><strong>Signal:</strong> ${escapeHtml(pattern.signal)}</p>
            <p><strong>Impact:</strong> ${escapeHtml(pattern.impact)}</p>
            <p><strong>Coaching:</strong> ${escapeHtml(pattern.coaching)}</p>
          </article>`,
        )
        .join("")}
    </div>
  </section>`;
}

function whatWorks(section: InsightsWhatWorksSection | null): string {
  if (!section) return "";
  return `<section class="panel">
    <div class="panel-kicker">Strengths</div>
    <h2>What Works Well</h2>
    <p class="panel-copy">${escapeHtml(section.summary)}</p>
    <div class="stacked-cards">
      ${section.wins
        .map(
          (win) => `<article class="detail-card success-card">
            <h3>${escapeHtml(win.title)}</h3>
            <p><strong>Evidence:</strong> ${escapeHtml(win.evidence)}</p>
            <p><strong>Why It Works:</strong> ${escapeHtml(win.whyItWorks)}</p>
            <p><strong>Do More Of:</strong> ${escapeHtml(win.doMoreOf)}</p>
          </article>`,
        )
        .join("")}
    </div>
  </section>`;
}

function frictionAnalysis(section: InsightsFrictionSection | null): string {
  if (!section) return "";
  return `<section class="panel">
    <div class="panel-kicker">Risks</div>
    <h2>Where The Workflow Slips</h2>
    <p class="panel-copy">${escapeHtml(section.summary)}</p>
    <div class="stacked-cards">
      ${section.issues
        .map(
          (issue) => `<article class="detail-card warning-card">
            <div class="severity-pill severity-${escapeHtml(issue.severity)}">${escapeHtml(issue.severity)}</div>
            <h3>${escapeHtml(issue.title)}</h3>
            <p><strong>Evidence:</strong> ${escapeHtml(issue.evidence)}</p>
            <p><strong>Likely Cause:</strong> ${escapeHtml(issue.likelyCause)}</p>
            <p><strong>Mitigation:</strong> ${escapeHtml(issue.mitigation)}</p>
          </article>`,
        )
        .join("")}
    </div>
  </section>`;
}

function suggestions(section: InsightsSuggestionsSection | null): string {
  if (!section) return "";
  return `<section class="panel">
    <div class="panel-kicker">Next Moves</div>
    <h2>Actionable Suggestions</h2>
    <p class="panel-copy">${escapeHtml(section.summary)}</p>
    <div class="stacked-cards">
      ${section.actions
        .map(
          (action, index) => `<article class="detail-card action-card">
            <div class="severity-pill severity-${escapeHtml(action.priority)}">${escapeHtml(action.priority)}</div>
            <h3>${escapeHtml(action.title)}</h3>
            <p><strong>Why:</strong> ${escapeHtml(action.rationale)}</p>
            <p><strong>Playbook:</strong> ${escapeHtml(action.playbook)}</p>
            <div class="copy-wrap">
              <pre class="copy-box" id="copy-${index}">${escapeHtml(action.copyablePrompt)}</pre>
              <button class="copy-button" data-copy-target="copy-${index}">Copy Prompt</button>
            </div>
          </article>`,
        )
        .join("")}
    </div>
  </section>`;
}

function horizon(section: InsightsOnTheHorizonSection | null): string {
  if (!section) return "";
  return `<section class="panel">
    <div class="panel-kicker">Ahead</div>
    <h2>On The Horizon</h2>
    <p class="panel-copy">${escapeHtml(section.summary)}</p>
    <div class="stacked-cards">
      ${section.bets
        .map(
          (bet, index) => `<article class="detail-card horizon-card">
            <h3>${escapeHtml(bet.title)}</h3>
            <p><strong>Why Now:</strong> ${escapeHtml(bet.whyNow)}</p>
            <p><strong>Experiment:</strong> ${escapeHtml(bet.experiment)}</p>
            <div class="copy-wrap">
              <pre class="copy-box" id="horizon-${index}">${escapeHtml(bet.copyablePrompt)}</pre>
              <button class="copy-button" data-copy-target="horizon-${index}">Copy Experiment</button>
            </div>
          </article>`,
        )
        .join("")}
    </div>
  </section>`;
}

function achievementCard(achievement: InsightsAchievement): string {
  return `<article class="achievement-card">
    <div class="mini-eyebrow">${escapeHtml(achievement.title)}</div>
    <h3>${escapeHtml(achievement.title)}</h3>
    <p>${escapeHtml(achievement.detail)}</p>
  </article>`;
}

function codingStory(section: InsightsCodingStorySection | null, stats: AggregatedStats): string {
  const achievementGrid =
    stats.achievements.length > 0
      ? `<div class="achievement-grid">${stats.achievements
          .map(achievementCard)
          .join("")}</div>`
      : `<p class="panel-copy">No achievement thresholds fired in this window.</p>`;

  const moments =
    section && section.moments.length > 0
      ? section.moments
          .map(
            (moment) => `<blockquote class="story-quote">
              <strong>${escapeHtml(moment.title)}</strong>
              <span>${escapeHtml(moment.narrative)}</span>
            </blockquote>`,
          )
          .join("")
      : `<p class="panel-copy">Memorable Moments were unavailable for this run.</p>`;

  return `<section class="panel story-panel">
    <div class="panel-kicker">Your Coding Story</div>
    <h2>Your Coding Story</h2>
    <div class="two-col section-two-col">
      <div>
        <h3 class="subhead">Achievement Wall</h3>
        ${achievementGrid}
      </div>
      <div>
        <h3 class="subhead">Memorable Moments</h3>
        ${section ? `<p class="panel-copy">${escapeHtml(section.summary)}</p>` : ""}
        ${moments}
      </div>
    </div>
  </section>`;
}

export function generateReport(insights: InsightsResult): string {
  const reportsDir = path.join(TERMCANVAS_DIR, "insights-reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const { stats } = insights;
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tacit Insights Report</title>
<style>
  :root {
    --bg: #101412;
    --panel: rgba(17, 27, 24, 0.88);
    --panel-alt: rgba(12, 19, 17, 0.92);
    --border: rgba(172, 214, 192, 0.14);
    --text: #edf4ee;
    --muted: #b9c9bc;
    --faint: #7f9487;
    --accent: #d3a86c;
    --mint: #63c7a6;
    --rose: #ff9472;
    --shadow: 0 28px 80px rgba(0, 0, 0, 0.34);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(circle at top left, rgba(211, 168, 108, 0.18), transparent 28%),
      radial-gradient(circle at right center, rgba(99, 199, 166, 0.10), transparent 34%),
      linear-gradient(180deg, #0d100f 0%, var(--bg) 40%, #0b0e0d 100%);
    color: var(--text);
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    line-height: 1.6;
  }
  .wrap {
    width: min(1180px, calc(100vw - 24px));
    margin: 0 auto;
    padding: 24px 0 60px;
  }
  .masthead,
  .panel,
  .hero-panel,
  .stat-card {
    border: 1px solid var(--border);
    background: var(--panel);
    border-radius: 22px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(18px);
  }
  .masthead {
    position: relative;
    overflow: hidden;
    padding: 28px;
    margin-bottom: 20px;
  }
  .masthead::after {
    content: "";
    position: absolute;
    inset: auto -60px -90px auto;
    width: 240px;
    height: 240px;
    background: radial-gradient(circle, rgba(211, 168, 108, 0.22), transparent 68%);
    pointer-events: none;
  }
  .eyebrow,
  .hero-kicker,
  .panel-kicker,
  .mini-eyebrow {
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-size: 11px;
  }
  .masthead h1,
  .hero-panel h2,
  .panel h2,
  .panel h3,
  .story-quote,
  .tool-card h3 {
    font-family: "Iowan Old Style", "Palatino Linotype", serif;
  }
  .masthead h1 {
    margin: 10px 0 0;
    font-size: clamp(30px, 6vw, 56px);
    line-height: 1.02;
    max-width: 12ch;
  }
  .masthead p,
  .panel-copy,
  .mini-card p,
  .detail-card p,
  .notice-panel li {
    color: var(--muted);
  }
  .meta-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 18px;
  }
  .meta-pill {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.03);
    color: var(--muted);
    font-size: 13px;
  }
  .stats-grid,
  .two-col,
  .three-col,
  .card-grid,
  .stacked-cards,
  .achievement-grid,
  .tool-columns {
    display: grid;
    gap: 16px;
  }
  .stats-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-bottom: 20px;
  }
  .two-col {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-bottom: 20px;
  }
  .three-col {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-bottom: 20px;
  }
  .hero-panel,
  .panel,
  .stat-card {
    padding: 20px;
  }
  .hero-panel {
    margin-bottom: 20px;
    background: linear-gradient(135deg, rgba(24, 39, 34, 0.96), rgba(16, 24, 21, 0.92));
  }
  .hero-panel h2,
  .panel h2 {
    margin: 8px 0 12px;
    font-size: clamp(26px, 4vw, 34px);
    line-height: 1.08;
  }
  .hero-list {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 10px;
    color: var(--muted);
  }
  .stat-value,
  .metric-label,
  .metric-value,
  .tool-stat-value {
    font-family: "SF Mono", "Geist Mono", monospace;
  }
  .stat-value,
  .tool-stat-value {
    font-size: 28px;
    font-weight: 700;
  }
  .stat-label,
  .tool-stat-label {
    margin-top: 8px;
    color: var(--faint);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 11px;
  }
  .card-grid {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
  .mini-card,
  .detail-card,
  .tool-card,
  .achievement-card {
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 18px;
    padding: 16px;
    background: var(--panel-alt);
  }
  .mini-card h3,
  .detail-card h3,
  .tool-card h3,
  .achievement-card h3 {
    margin: 8px 0;
    font-size: 18px;
  }
  .mini-footer {
    color: var(--accent);
    font-size: 13px;
  }
  .metric-list {
    display: grid;
    gap: 12px;
  }
  .metric-row {
    display: grid;
    grid-template-columns: minmax(120px, 1.2fr) minmax(0, 4fr) auto;
    gap: 12px;
    align-items: center;
  }
  .metric-label,
  .metric-value {
    font-size: 13px;
  }
  .metric-track {
    height: 12px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 999px;
    overflow: hidden;
  }
  .metric-fill,
  .trend-bar {
    border-radius: inherit;
  }
  .amber { background: linear-gradient(180deg, rgba(211, 168, 108, 0.26), var(--accent)); }
  .mint { background: linear-gradient(180deg, rgba(99, 199, 166, 0.24), var(--mint)); }
  .rose { background: linear-gradient(180deg, rgba(255, 148, 114, 0.26), var(--rose)); }
  .slate { background: linear-gradient(180deg, rgba(116, 150, 136, 0.24), #7ca18f); }
  .heat-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 10px;
  }
  .heat-cell {
    position: relative;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    background: rgba(255, 255, 255, 0.03);
    height: 58px;
    overflow: hidden;
  }
  .heat-cell-fill {
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, var(--mint), var(--accent));
  }
  .heat-hour {
    position: absolute;
    left: 10px;
    bottom: 8px;
    z-index: 1;
    font-family: "SF Mono", "Geist Mono", monospace;
    font-size: 12px;
  }
  .trend-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    color: var(--muted);
    margin-bottom: 14px;
  }
  .legend-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 999px;
    margin-right: 8px;
    vertical-align: middle;
  }
  .trend-chart {
    display: grid;
    grid-template-columns: repeat(14, minmax(0, 1fr));
    gap: 10px;
    align-items: end;
    min-height: 220px;
  }
  .trend-day {
    display: grid;
    gap: 10px;
  }
  .trend-day-bars {
    height: 180px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    align-items: end;
  }
  .trend-bar {
    width: 100%;
    min-height: 6px;
  }
  .trend-label {
    color: var(--faint);
    font-size: 11px;
    text-align: center;
    font-family: "SF Mono", "Geist Mono", monospace;
  }
  .trend-stats {
    display: grid;
    gap: 8px;
    margin-top: 16px;
  }
  .trend-stat {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .tool-columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .tool-card.tool-claude {
    background: linear-gradient(180deg, rgba(211, 168, 108, 0.08), rgba(17, 27, 24, 0.9));
  }
  .tool-card.tool-codex {
    background: linear-gradient(180deg, rgba(99, 199, 166, 0.08), rgba(17, 27, 24, 0.9));
  }
  .tool-stat-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin: 16px 0;
  }
  .tool-list {
    color: var(--muted);
    margin-top: 8px;
  }
  .severity-pill {
    display: inline-flex;
    margin-bottom: 10px;
    padding: 4px 8px;
    border-radius: 999px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }
  .severity-high, .severity-now {
    background: rgba(255, 148, 114, 0.14);
    color: var(--rose);
  }
  .severity-medium, .severity-next {
    background: rgba(211, 168, 108, 0.16);
    color: var(--accent);
  }
  .severity-low, .severity-later {
    background: rgba(99, 199, 166, 0.14);
    color: var(--mint);
  }
  .success-card { border-color: rgba(99, 199, 166, 0.2); }
  .warning-card { border-color: rgba(255, 148, 114, 0.2); }
  .action-card { border-color: rgba(211, 168, 108, 0.2); }
  .horizon-card { border-color: rgba(99, 199, 166, 0.2); }
  .copy-wrap {
    display: grid;
    gap: 10px;
    margin-top: 12px;
  }
  .copy-box {
    margin: 0;
    white-space: pre-wrap;
    background: rgba(0, 0, 0, 0.28);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 14px;
    padding: 12px;
    color: #f6efe4;
    font-family: "SF Mono", "Geist Mono", monospace;
    font-size: 12px;
  }
  .copy-button {
    justify-self: start;
    border: 0;
    border-radius: 999px;
    padding: 10px 14px;
    background: linear-gradient(90deg, #7b5c39, var(--accent));
    color: #111;
    cursor: pointer;
    font-weight: 700;
  }
  .notice-panel ul {
    padding-left: 18px;
    margin: 10px 0 0;
  }
  .subhead {
    margin: 0 0 12px;
    font-size: 22px;
  }
  .achievement-grid {
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }
  .achievement-card {
    position: relative;
    background:
      linear-gradient(180deg, rgba(17, 27, 24, 0.92), rgba(10, 15, 13, 0.9)) padding-box,
      linear-gradient(135deg, rgba(211, 168, 108, 0.8), rgba(99, 199, 166, 0.55)) border-box;
    border: 1px solid transparent;
    box-shadow: inset 0 0 18px rgba(211, 168, 108, 0.08);
  }
  .story-quote {
    display: grid;
    gap: 8px;
    margin: 0 0 14px;
    padding-left: 16px;
    border-left: 3px solid var(--accent);
    color: #f5e8d8;
    font-size: 20px;
  }
  .story-panel .section-two-col {
    margin-bottom: 0;
  }
  .footer {
    color: var(--faint);
    text-align: center;
    margin-top: 18px;
    font-size: 13px;
  }
  @media (max-width: 980px) {
    .stats-grid, .two-col, .three-col, .tool-columns {
      grid-template-columns: 1fr 1fr;
    }
    .trend-chart { grid-template-columns: repeat(${Math.max(stats.dailyBreakdown.slice(-14).length, 1)}, minmax(0, 1fr)); }
  }
  @media (max-width: 720px) {
    .wrap { width: min(100vw - 16px, 100%); padding-top: 16px; }
    .stats-grid, .two-col, .three-col, .tool-columns { grid-template-columns: 1fr; }
    .metric-row, .trend-stat { grid-template-columns: 1fr; }
    .heat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .trend-chart { gap: 6px; }
  }
  @media (max-width: 420px) {
    .masthead, .panel, .hero-panel, .stat-card { padding: 16px; border-radius: 18px; }
    .masthead h1 { font-size: 30px; }
    .story-quote { font-size: 18px; }
    .heat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header class="masthead">
      <div class="eyebrow">Tacit Intelligence Report</div>
      <h1>Cross-session guidance for how you actually code across Claude Code and Codex</h1>
      <p>Generated ${escapeHtml(dateStr)} using ${escapeHtml(formatCliLabel(stats.analyzerCli))} for synthesis. Session scanning is always unified across both CLIs, while tiered facet extraction prioritizes the freshest and highest-signal work.</p>
      <div class="meta-strip">
        <div class="meta-pill">Facet-backed sessions: ${formatNumber(stats.facetBackedSessions)}</div>
        <div class="meta-pill">Eligible sessions: ${formatNumber(stats.totalEligibleSessions)}</div>
        <div class="meta-pill">Scanned files: ${formatNumber(stats.totalScannedSessions)}</div>
      </div>
    </header>

    ${statCards(insights)}
    ${atAGlance(insights.atAGlance)}
    ${coveragePanel(insights)}
    ${timeTrends(stats)}
    ${toolComparison(stats)}

    <div class="two-col">
      ${stackedBars("Outcome Mix", stats.outcomeBreakdown, "mint")}
      ${stackedBars("Top Tools", stats.toolBreakdown, "slate")}
    </div>

    <div class="three-col">
      ${stackedBars("Languages", stats.languageBreakdown, "mint")}
      ${stackedBars("Friction Signals", stats.frictionCounts, "rose")}
      ${stackedBars("Assistant Response Times", stats.responseTimeBreakdown, "amber")}
    </div>

    <div class="two-col">
      ${stackedBars("User Follow-up Times", stats.userReplyBreakdown, "slate")}
      ${heatmap(stats.messageHourBreakdown)}
    </div>

    <div class="two-col">
      ${projectAreas(insights.projectAreas)}
      ${interactionStyle(insights.interactionStyle)}
    </div>

    <div class="two-col">
      ${whatWorks(insights.whatWorks)}
      ${frictionAnalysis(insights.frictionAnalysis)}
    </div>

    ${suggestions(insights.suggestions)}
    ${horizon(insights.onTheHorizon)}
    ${codingStory(insights.codingStory, stats)}

    <div class="footer">Generated by Tacit · unified cross-CLI scanning, tiered facet extraction, and self-contained HTML reporting.</div>
  </div>
  <script>
    for (const button of document.querySelectorAll(".copy-button")) {
      button.addEventListener("click", async () => {
        const id = button.getAttribute("data-copy-target");
        const node = id ? document.getElementById(id) : null;
        if (!node) return;
        const text = node.textContent || "";
        try {
          await navigator.clipboard.writeText(text);
          const old = button.textContent;
          button.textContent = "Copied";
          setTimeout(() => { button.textContent = old; }, 1200);
        } catch {
          button.textContent = "Copy failed";
        }
      });
    }
  </script>
</body>
</html>`;

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
  const filename = `insights-${timestamp}.html`;
  const filePath = path.join(reportsDir, filename);
  fs.writeFileSync(filePath, html, "utf-8");
  return filePath;
}
