import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildCliInvocationArgs } from "../electron/insights-cli.ts";
import { generateReport } from "../electron/insights-report.ts";
import {
  aggregateFacets,
  buildDeterministicAtAGlance,
  buildTranscriptWindow,
  buildSessionFingerprint,
  isSelfInsightSession,
  parseStructuredSection,
  type SessionFacet,
  type SessionInfo,
} from "../electron/insights-shared.ts";

test("buildCliInvocationArgs keeps Claude insights invocations unchanged", () => {
  const result = buildCliInvocationArgs([], "claude", "Reply with exactly: OK");
  assert.deepEqual(result.args, ["-p", "Reply with exactly: OK"]);
  assert.equal(result.stdin, null);
});

test("buildCliInvocationArgs skips the git repo check for Codex insights runs", () => {
  const result = buildCliInvocationArgs([], "codex", "Reply with exactly: OK");
  assert.deepEqual(result.args, ["exec", "--skip-git-repo-check", "Reply with exactly: OK"]);
  assert.equal(result.stdin, null);
});

test("buildCliInvocationArgs uses stdin for long prompts", () => {
  const longPrompt = "x".repeat(200_001);
  const claudeResult = buildCliInvocationArgs([], "claude", longPrompt);
  assert.deepEqual(claudeResult.args, ["-p", "-"]);
  assert.equal(claudeResult.stdin, longPrompt);

  const codexResult = buildCliInvocationArgs([], "codex", longPrompt);
  assert.deepEqual(codexResult.args, ["exec", "--skip-git-repo-check", "-"]);
  assert.equal(codexResult.stdin, longPrompt);
});

test("buildCliInvocationArgs preserves launcher wrapper args", () => {
  const result = buildCliInvocationArgs(
    ["/d", "/s", "/c", "codex.cmd"],
    "codex",
    "Reply with exactly: OK",
  );
  assert.deepEqual(result.args, [
    "/d",
    "/s",
    "/c",
    "codex.cmd",
    "exec",
    "--skip-git-repo-check",
    "Reply with exactly: OK",
  ]);
  assert.equal(result.stdin, null);
});

test("buildSessionFingerprint changes when source metadata changes", () => {
  const base = {
    id: "session-1",
    filePath: "/tmp/session-1.jsonl",
    cliTool: "codex" as const,
    projectPath: "/tmp/project",
    messageCount: 4,
    durationMinutes: 3,
    contentSummary: "user: hello",
    mtimeMs: 1000,
    fileSize: 200,
  };

  const first = buildSessionFingerprint(base);
  const changedMtime = buildSessionFingerprint({ ...base, mtimeMs: 2000 });
  const changedCli = buildSessionFingerprint({ ...base, cliTool: "claude" });

  assert.notEqual(first, changedMtime);
  assert.notEqual(first, changedCli);
});

test("isSelfInsightSession detects insight control prompts", () => {
  assert.equal(
    isSelfInsightSession(
      "Analyze this AI coding session and return a JSON object with exactly these fields:",
    ),
    true,
  );
  assert.equal(
    isSelfInsightSession("RESPOND WITH ONLY A VALID JSON OBJECT matching this schema:"),
    true,
  );
  assert.equal(isSelfInsightSession("user: fix the login bug"), false);
});

test("aggregateFacets reports analyzed totals and preserves pipeline counts", () => {
  const sessions: SessionInfo[] = [
    {
      id: "a",
      filePath: "/tmp/a.jsonl",
      cliTool: "codex",
      projectPath: "/tmp/project-a",
      startTimeMs: 1_000,
      endTimeMs: 721_000,
      messageCount: 10,
      durationMinutes: 12,
      contentSummary: "",
      analysisText: "",
      mtimeMs: 30,
      fileSize: 300,
      metrics: {
        toolCounts: { exec_command: 5, apply_patch: 2 },
        languages: { typescript: 3 },
        modelCounts: { "gpt-5.2": 1 },
        inputTokens: 1_000,
        outputTokens: 400,
        cachedInputTokens: 100,
        reasoningTokens: 80,
        gitCommits: 1,
        gitPushes: 0,
        filesModified: 4,
        linesAdded: 80,
        linesRemoved: 20,
        toolErrorCategories: { shell: 1 },
        assistantResponseSeconds: [30, 45],
        userReplySeconds: [120],
        userInterruptions: 1,
        messageHours: { "09": 6, "10": 4 },
        featureUsage: { apply_patch: 1, plan_updates: 1 },
      },
    },
    {
      id: "b",
      filePath: "/tmp/b.jsonl",
      cliTool: "codex",
      projectPath: "/tmp/project-b",
      startTimeMs: 2_000,
      endTimeMs: 362_000,
      messageCount: 4,
      durationMinutes: 6,
      contentSummary: "",
      analysisText: "",
      mtimeMs: 20,
      fileSize: 200,
      metrics: {
        toolCounts: { exec_command: 2 },
        languages: { markdown: 1, json: 1 },
        modelCounts: { "gpt-5.2": 1 },
        inputTokens: 600,
        outputTokens: 250,
        cachedInputTokens: 0,
        reasoningTokens: 40,
        gitCommits: 0,
        gitPushes: 1,
        filesModified: 2,
        linesAdded: 10,
        linesRemoved: 3,
        toolErrorCategories: {},
        assistantResponseSeconds: [20],
        userReplySeconds: [90, 60],
        userInterruptions: 0,
        messageHours: { "11": 4 },
        featureUsage: { shell: 1 },
      },
    },
    {
      id: "c",
      filePath: "/tmp/c.jsonl",
      cliTool: "codex",
      projectPath: "/tmp/project-c",
      startTimeMs: 3_000,
      endTimeMs: 543_000,
      messageCount: 8,
      durationMinutes: 9,
      contentSummary: "",
      analysisText: "",
      mtimeMs: 10,
      fileSize: 100,
      metrics: {
        toolCounts: {},
        languages: {},
        modelCounts: {},
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        gitCommits: 0,
        gitPushes: 0,
        filesModified: 0,
        linesAdded: 0,
        linesRemoved: 0,
        toolErrorCategories: {},
        assistantResponseSeconds: [],
        userReplySeconds: [],
        userInterruptions: 0,
        messageHours: {},
        featureUsage: {},
      },
    },
  ];

  const facets: SessionFacet[] = [
    {
      session_id: "a",
      cli_tool: "codex",
      underlying_goal: "Fix auth",
      brief_summary: "Fixed auth issue.",
      goal_categories: { bug_fix: 1 },
      outcome: "fully_achieved",
      session_type: "single_task",
      friction_counts: {},
      user_satisfaction: "high",
      project_path: "/tmp/project-a",
      project_area: "product_surface",
      notable_tools: ["exec_command", "apply_patch"],
      dominant_languages: ["typescript"],
      wins: ["Fast direct edits"],
      frictions: ["One shell retry"],
      recommended_next_step: "Keep batching shell inspection before edits.",
    },
    {
      session_id: "b",
      cli_tool: "codex",
      underlying_goal: "Add report",
      brief_summary: "Added report export.",
      goal_categories: { feature: 1 },
      outcome: "mostly_achieved",
      session_type: "iterative",
      friction_counts: { retry: 1 },
      user_satisfaction: "medium",
      project_path: "/tmp/project-b",
      project_area: "delivery_ops",
      notable_tools: ["exec_command"],
      dominant_languages: ["markdown", "json"],
      wins: ["Shipped report export"],
      frictions: ["One retry on formatting"],
      recommended_next_step: "Automate release notes generation.",
    },
  ];

  const stats = aggregateFacets(facets, sessions, {
    sourceCli: "codex",
    analyzerCli: "codex",
    totalScannedSessions: 5,
    totalEligibleSessions: 3,
    cachedFacetSessions: 1,
    failedFacetSessions: 1,
    deferredFacetSessions: 0,
    metricsOnlySessions: 1,
  });

  assert.equal(stats.totalSessions, 3);
  assert.equal(stats.facetBackedSessions, 2);
  assert.equal(stats.totalMessages, 22);
  assert.equal(stats.totalDurationMinutes, 27);
  assert.equal(stats.totalScannedSessions, 5);
  assert.equal(stats.totalEligibleSessions, 3);
  assert.equal(stats.cachedFacetSessions, 1);
  assert.equal(stats.failedFacetSessions, 1);
  assert.equal(stats.metricsOnlySessions, 1);
  assert.equal(stats.sourceCli, "codex");
  assert.equal(stats.analyzerCli, "codex");
  assert.equal(stats.totalInputTokens, 1_600);
  assert.equal(stats.totalOutputTokens, 650);
  assert.equal(stats.totalCachedInputTokens, 100);
  assert.equal(stats.totalReasoningTokens, 120);
  assert.equal(stats.totalGitCommits, 1);
  assert.equal(stats.totalGitPushes, 1);
  assert.equal(stats.totalFilesModified, 6);
  assert.equal(stats.totalLinesAdded, 90);
  assert.equal(stats.totalLinesRemoved, 23);
  assert.equal(stats.totalUserInterruptions, 1);
  assert.equal(stats.toolBreakdown.exec_command, 7);
  assert.equal(stats.toolBreakdown.apply_patch, 2);
  assert.equal(stats.languageBreakdown.typescript, 3);
  assert.equal(stats.languageBreakdown.markdown, 1);
  assert.equal(stats.projectAreaBreakdown.product_surface, 1);
  assert.equal(stats.projectAreaBreakdown.delivery_ops, 1);
  assert.equal(stats.toolErrorBreakdown.shell, 1);
  assert.equal(stats.featureUsageBreakdown.apply_patch, 1);
  assert.equal(stats.featureUsageBreakdown.plan_updates, 1);
  assert.equal(stats.featureUsageBreakdown.shell, 1);
  assert.equal(stats.messageHourBreakdown["09"], 6);
  assert.equal(stats.responseTimeBreakdown["under_30s"], 1);
  assert.equal(stats.responseTimeBreakdown["30s_to_2m"], 2);
  assert.equal(stats.userReplyBreakdown["under_2m"], 2);
  assert.equal(stats.userReplyBreakdown["2m_to_10m"], 1);
  assert.equal(stats.averageAssistantResponseSeconds, 32);
  assert.equal(stats.averageUserReplySeconds, 90);
});

test("aggregateFacets includes metrics-only eligible sessions in rollups and computes v2 trend data", () => {
  const day = (value: string) => new Date(value).getTime();

  const sessions: SessionInfo[] = [
    {
      id: "s1",
      filePath: "/tmp/s1.jsonl",
      cliTool: "codex",
      projectPath: "/tmp/tacit",
      startTimeMs: day("2026-03-20T12:00:00.000Z"),
      endTimeMs: day("2026-03-20T12:30:00.000Z"),
      messageCount: 20,
      durationMinutes: 30,
      contentSummary: "",
      analysisText: "",
      mtimeMs: day("2026-03-20T12:31:00.000Z"),
      fileSize: 100,
      metrics: {
        toolCounts: { exec_command: 4, apply_patch: 1 },
        languages: { typescript: 3, javascript: 1 },
        modelCounts: { "gpt-5.2": 1 },
        inputTokens: 2_000_000,
        outputTokens: 600_000,
        cachedInputTokens: 100_000,
        reasoningTokens: 50_000,
        gitCommits: 1,
        gitPushes: 0,
        filesModified: 8,
        linesAdded: 700,
        linesRemoved: 60,
        toolErrorCategories: {},
        assistantResponseSeconds: [20, 40],
        userReplySeconds: [120],
        userInterruptions: 0,
        messageHours: { "23": 20 },
        featureUsage: { apply_patch: 1, shell: 1 },
      },
    },
    {
      id: "s2",
      filePath: "/tmp/s2.jsonl",
      cliTool: "claude",
      projectPath: "/tmp/tacit",
      startTimeMs: day("2026-03-21T12:00:00.000Z"),
      endTimeMs: day("2026-03-21T12:50:00.000Z"),
      messageCount: 25,
      durationMinutes: 50,
      contentSummary: "",
      analysisText: "",
      mtimeMs: day("2026-03-21T12:51:00.000Z"),
      fileSize: 100,
      metrics: {
        toolCounts: { Bash: 3, Edit: 1 },
        languages: { python: 2, markdown: 1 },
        modelCounts: { "claude-opus-4-6": 1 },
        inputTokens: 2_000_000,
        outputTokens: 500_000,
        cachedInputTokens: 50_000,
        reasoningTokens: 0,
        gitCommits: 0,
        gitPushes: 0,
        filesModified: 5,
        linesAdded: 400,
        linesRemoved: 20,
        toolErrorCategories: {},
        assistantResponseSeconds: [35],
        userReplySeconds: [90],
        userInterruptions: 1,
        messageHours: { "23": 25 },
        featureUsage: { shell: 1 },
      },
    },
    {
      id: "s3",
      filePath: "/tmp/s3.jsonl",
      cliTool: "codex",
      projectPath: "/tmp/tacit",
      startTimeMs: day("2026-03-22T09:00:00.000Z"),
      endTimeMs: day("2026-03-22T11:30:00.000Z"),
      messageCount: 15,
      durationMinutes: 150,
      contentSummary: "",
      analysisText: "",
      mtimeMs: day("2026-03-22T11:31:00.000Z"),
      fileSize: 100,
      metrics: {
        toolCounts: { exec_command: 2 },
        languages: { rust: 2 },
        modelCounts: { "gpt-5.2": 1 },
        inputTokens: 2_000_000,
        outputTokens: 400_000,
        cachedInputTokens: 25_000,
        reasoningTokens: 70_000,
        gitCommits: 0,
        gitPushes: 0,
        filesModified: 3,
        linesAdded: 50,
        linesRemoved: 10,
        toolErrorCategories: { shell: 1 },
        assistantResponseSeconds: [80],
        userReplySeconds: [300],
        userInterruptions: 0,
        messageHours: { "08": 15 },
        featureUsage: { shell: 1, plan_updates: 1 },
      },
    },
    {
      id: "s4",
      filePath: "/tmp/s4.jsonl",
      cliTool: "claude",
      projectPath: "/tmp/website",
      startTimeMs: day("2026-03-23T09:00:00.000Z"),
      endTimeMs: day("2026-03-23T09:30:00.000Z"),
      messageCount: 10,
      durationMinutes: 30,
      contentSummary: "",
      analysisText: "",
      mtimeMs: day("2026-03-23T09:31:00.000Z"),
      fileSize: 100,
      metrics: {
        toolCounts: { Bash: 1 },
        languages: { go: 2 },
        modelCounts: { "claude-opus-4-6": 1 },
        inputTokens: 2_000_000,
        outputTokens: 300_000,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        gitCommits: 0,
        gitPushes: 0,
        filesModified: 2,
        linesAdded: 10,
        linesRemoved: 5,
        toolErrorCategories: {},
        assistantResponseSeconds: [25],
        userReplySeconds: [200],
        userInterruptions: 0,
        messageHours: { "08": 10 },
        featureUsage: { shell: 1 },
      },
    },
    {
      id: "s5",
      filePath: "/tmp/s5.jsonl",
      cliTool: "codex",
      projectPath: "/tmp/tacit",
      startTimeMs: day("2026-03-24T10:00:00.000Z"),
      endTimeMs: day("2026-03-24T10:20:00.000Z"),
      messageCount: 5,
      durationMinutes: 20,
      contentSummary: "",
      analysisText: "",
      mtimeMs: day("2026-03-24T10:21:00.000Z"),
      fileSize: 100,
      metrics: {
        toolCounts: { exec_command: 1 },
        languages: { json: 1 },
        modelCounts: { "gpt-5.2": 1 },
        inputTokens: 2_500_000,
        outputTokens: 250_000,
        cachedInputTokens: 0,
        reasoningTokens: 30_000,
        gitCommits: 0,
        gitPushes: 0,
        filesModified: 1,
        linesAdded: 5,
        linesRemoved: 1,
        toolErrorCategories: {},
        assistantResponseSeconds: [15],
        userReplySeconds: [60],
        userInterruptions: 0,
        messageHours: { "09": 5 },
        featureUsage: { shell: 1 },
      },
    },
  ];

  const facets: SessionFacet[] = [
    {
      session_id: "s1",
      cli_tool: "codex",
      underlying_goal: "Ship a feature",
      brief_summary: "Completed a feature.",
      goal_categories: { feature: 1 },
      outcome: "fully_achieved",
      session_type: "single_task",
      friction_counts: {},
      user_satisfaction: "high",
      project_path: "/tmp/tacit",
      project_area: "product_surface",
      notable_tools: ["exec_command", "apply_patch"],
      dominant_languages: ["typescript", "javascript"],
      wins: ["Fast edits"],
      frictions: [],
      recommended_next_step: "Batch follow-up checks.",
    },
    {
      session_id: "s2",
      cli_tool: "claude",
      underlying_goal: "Update docs",
      brief_summary: "Mostly landed the docs pass.",
      goal_categories: { docs: 1 },
      outcome: "mostly_achieved",
      session_type: "iterative",
      friction_counts: { review_loop: 1 },
      user_satisfaction: "medium",
      project_path: "/tmp/tacit",
      project_area: "docs_workflow",
      notable_tools: ["Bash", "Edit"],
      dominant_languages: ["python", "markdown"],
      wins: ["Clear draft"],
      frictions: ["Needed review loops"],
      recommended_next_step: "Tighten review criteria first.",
    },
    {
      session_id: "s4",
      cli_tool: "claude",
      underlying_goal: "Fix a deployment issue",
      brief_summary: "Progressed but did not finish.",
      goal_categories: { ops: 1 },
      outcome: "partially_achieved",
      session_type: "exploratory",
      friction_counts: { tool_failure: 1 },
      user_satisfaction: "low",
      project_path: "/tmp/website",
      project_area: "delivery_ops",
      notable_tools: ["Bash"],
      dominant_languages: ["go"],
      wins: [],
      frictions: ["One blocker remained"],
      recommended_next_step: "Isolate the failing command.",
    },
    {
      session_id: "s5",
      cli_tool: "codex",
      underlying_goal: "Tidy generated data",
      brief_summary: "Quick cleanup session.",
      goal_categories: { refactor: 1 },
      outcome: "fully_achieved",
      session_type: "quick_question",
      friction_counts: {},
      user_satisfaction: "high",
      project_path: "/tmp/tacit",
      project_area: "editor_infra",
      notable_tools: ["exec_command"],
      dominant_languages: ["json"],
      wins: ["Closed quickly"],
      frictions: [],
      recommended_next_step: "Fold into a script.",
    },
  ];

  const stats = aggregateFacets(facets, sessions, {
    sourceCli: "codex",
    analyzerCli: "claude",
    totalScannedSessions: 6,
    totalEligibleSessions: 5,
    cachedFacetSessions: 2,
    failedFacetSessions: 1,
    deferredFacetSessions: 0,
  }) as Record<string, unknown>;

  assert.equal(stats.totalSessions, 5);
  assert.equal(stats.totalMessages, 75);
  assert.equal(stats.totalDurationMinutes, 280);
  assert.equal(stats.totalInputTokens, 10_500_000);
  assert.deepEqual(stats.cliBreakdown, { codex: 3, claude: 2 });
  assert.deepEqual(stats.outcomeBreakdown, {
    fully_achieved: 2,
    mostly_achieved: 1,
    partially_achieved: 1,
  });
  assert.deepEqual(stats.messageHourBreakdown, { "08": 25, "09": 5, "23": 45 });

  const dailyBreakdown = stats.dailyBreakdown as Array<Record<string, unknown>>;
  assert.equal(dailyBreakdown.length, 5);
  assert.deepEqual(dailyBreakdown[0], {
    date: "2026-03-20",
    sessions: 1,
    tokens: 2_600_000,
    linesAdded: 700,
  });

  const toolComparison = stats.toolComparison as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(toolComparison.codex.sessionCount, 3);
  assert.equal(toolComparison.codex.successRate, 100);
  assert.equal(toolComparison.claude.sessionCount, 2);
  assert.equal(toolComparison.claude.successRate, 50);

  const achievements = stats.achievements as Array<Record<string, unknown>>;
  assert.deepEqual(
    achievements.map((achievement) => achievement.id),
    ["night_owl", "marathon_runner", "polyglot", "streak", "token_whale", "zero_friction"],
  );
});

test("isSelfInsightSession detects Codex-originated insight pipeline sessions", () => {
  const selfInsightTranscript = JSON.stringify({
    originator: "codex_exec",
    prompt:
      "Write the final executive summary for an AI coding insights report. Return ONLY valid JSON.",
  });

  assert.equal(isSelfInsightSession(selfInsightTranscript), true);
});

test("generateReport renders the v2 report structure and header counts", () => {
  const reportPath = generateReport({
    stats: {
      sourceCli: "codex",
      analyzerCli: "claude",
      totalScannedSessions: 12,
      totalEligibleSessions: 9,
      cachedFacetSessions: 4,
      failedFacetSessions: 1,
      deferredFacetSessions: 0,
      facetBackedSessions: 7,
      totalSessions: 9,
      totalMessages: 90,
      totalDurationMinutes: 320,
      totalInputTokens: 1500,
      totalOutputTokens: 900,
      totalCachedInputTokens: 100,
      totalReasoningTokens: 50,
      totalGitCommits: 3,
      totalGitPushes: 1,
      totalFilesModified: 18,
      totalLinesAdded: 420,
      totalLinesRemoved: 120,
      totalUserInterruptions: 2,
      averageAssistantResponseSeconds: 41,
      averageUserReplySeconds: 180,
      cliBreakdown: { codex: 5, claude: 4 },
      outcomeBreakdown: { fully_achieved: 4, mostly_achieved: 2 },
      sessionTypeBreakdown: { iterative: 4, single_task: 3, exploratory: 2 },
      goalCategories: { feature: 4, bug_fix: 2 },
      frictionCounts: { review_loop: 2, tool_failure: 1 },
      satisfactionBreakdown: { high: 4, medium: 2, low: 1 },
      projectBreakdown: { tacit: 6, website: 3 },
      projectAreaBreakdown: { product_surface: 4, delivery_ops: 3, docs_workflow: 2 },
      toolBreakdown: { exec_command: 12, apply_patch: 6, Bash: 5 },
      languageBreakdown: { typescript: 8, python: 3, markdown: 2 },
      modelBreakdown: { "gpt-5.2": 5, "claude-opus-4-6": 4 },
      toolErrorBreakdown: { shell: 1 },
      messageHourBreakdown: { "08": 12, "23": 24 },
      responseTimeBreakdown: { under_30s: 3, "30s_to_2m": 4 },
      userReplyBreakdown: { under_2m: 1, "2m_to_10m": 6 },
      featureUsageBreakdown: { shell: 8, apply_patch: 6 },
      dailyBreakdown: [
        { date: "2026-03-20", sessions: 2, tokens: 300, linesAdded: 120 },
        { date: "2026-03-21", sessions: 3, tokens: 450, linesAdded: 200 },
      ],
      toolComparison: {
        codex: {
          sessionCount: 5,
          successRate: 80,
          topTools: [["exec_command", 8]],
          topLanguages: [["typescript", 6]],
        },
        claude: {
          sessionCount: 4,
          successRate: 50,
          topTools: [["Bash", 5]],
          topLanguages: [["python", 3]],
        },
      },
      achievements: [
        { id: "night_owl", title: "Night Owl", detail: "53% of messages landed after 22:00" },
      ],
    },
    projectAreas: {
      summary: "Most work clusters in product surface changes.",
      areas: [],
    },
    interactionStyle: {
      summary: "You iterate quickly.",
      patterns: [],
    },
    whatWorks: {
      summary: "You close well-scoped sessions efficiently.",
      wins: [],
    },
    frictionAnalysis: {
      summary: "Review loops are the main drag.",
      issues: [],
    },
    suggestions: {
      summary: "A few process tweaks would help.",
      actions: [],
    },
    onTheHorizon: {
      summary: "There is room for bigger automation bets.",
      bets: [],
    },
    codingStory: {
      summary: "A few sessions stood out.",
      moments: [
        {
          title: "The big win",
          narrative: "On March 21 you pushed a large fix across two files.",
        },
      ],
    },
    atAGlance: {
      headline: "The mix is healthy.",
      bullets: ["Most sessions land working code."],
    },
    sectionErrors: {},
  } as any);

  const html = fs.readFileSync(reportPath, "utf-8");
  fs.unlinkSync(reportPath);

  assert.match(html, /Facet-backed sessions/i);
  assert.match(html, /Eligible sessions/i);
  assert.match(html, /Scanned files/i);
  assert.match(html, /Time Trends/i);
  assert.match(html, /Tool Comparison/i);
  assert.match(html, /Achievement Wall/i);
  assert.match(html, /Memorable Moments/i);

  const coverageIndex = html.indexOf("What This Run Included");
  const timeTrendIndex = html.indexOf("Time Trends");
  const toolComparisonIndex = html.indexOf("Tool Comparison");
  const deepAnalysisIndex = html.indexOf("Project Areas");
  const codingStoryIndex = html.indexOf("Your Coding Story");

  assert.ok(coverageIndex > -1);
  assert.ok(timeTrendIndex > coverageIndex);
  assert.ok(toolComparisonIndex > timeTrendIndex);
  assert.ok(deepAnalysisIndex > toolComparisonIndex);
  assert.ok(codingStoryIndex > deepAnalysisIndex);
});

test("buildTranscriptWindow keeps head, middle, and tail context for long transcripts", () => {
  const parts = [
    "user: start bug report",
    "assistant: inspect files",
    "assistant tool: exec_command rg --files src",
    "user: try another approach",
    "assistant: applying patch",
    "assistant tool: apply_patch package.json",
    "user: please verify and release",
    "assistant: finished release notes",
  ];

  const excerpt = buildTranscriptWindow(parts, 80);

  assert.match(excerpt, /start bug report/);
  assert.match(excerpt, /try another approach|applying patch/);
  assert.match(excerpt, /finished release notes/);
  assert.match(excerpt, /\[\.\.\. transcript condensed \.\.\.\]/);
});

test("parseStructuredSection extracts JSON and validates required fields", () => {
  const parsed = parseStructuredSection(
    "atAGlance",
    "```json\n{\"headline\":\"Shipping velocity is high\",\"bullets\":[\"You batch edits well\",\"Most sessions end in working code\"]}\n```",
  );

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.headline, "Shipping velocity is high");
    assert.deepEqual(parsed.value.bullets, [
      "You batch edits well",
      "Most sessions end in working code",
    ]);
  }

  const invalid = parseStructuredSection(
    "atAGlance",
    "{\"headline\":\"Missing bullets\"}",
  );
  assert.equal(invalid.ok, false);
});

test("buildDeterministicAtAGlance summarizes stats when AI output is unavailable", () => {
  const summary = buildDeterministicAtAGlance({
    sourceCli: "claude",
    analyzerCli: "claude",
    totalScannedSessions: 8,
    totalEligibleSessions: 6,
    cachedFacetSessions: 3,
    failedFacetSessions: 1,
    deferredFacetSessions: 0,
    metricsOnlySessions: 1,
    totalSessions: 5,
    facetBackedSessions: 4,
    totalMessages: 42,
    totalDurationMinutes: 180,
    totalInputTokens: 12_000,
    totalOutputTokens: 7_500,
    totalCachedInputTokens: 3_000,
    totalReasoningTokens: 1_100,
    totalGitCommits: 2,
    totalGitPushes: 1,
    totalFilesModified: 14,
    totalLinesAdded: 320,
    totalLinesRemoved: 90,
    totalUserInterruptions: 1,
    averageAssistantResponseSeconds: 48,
    averageUserReplySeconds: 240,
    cliBreakdown: { claude: 5 },
    outcomeBreakdown: { fully_achieved: 3, mostly_achieved: 2 },
    sessionTypeBreakdown: { iterative: 3, single_task: 2 },
    goalCategories: { feature: 3, bug_fix: 2 },
    frictionCounts: { retry: 2 },
    satisfactionBreakdown: { high: 3, medium: 2 },
    projectBreakdown: { tacit: 4, website: 1 },
    projectAreaBreakdown: { product_surface: 3, release_ops: 2 },
    toolBreakdown: { Bash: 12, Edit: 6 },
    languageBreakdown: { typescript: 8, markdown: 2 },
    modelBreakdown: { "claude-opus-4-6": 5 },
    toolErrorBreakdown: { network: 1 },
    messageHourBreakdown: { "09": 10, "10": 8 },
    responseTimeBreakdown: { under_30s: 2, "30s_to_2m": 3 },
    userReplyBreakdown: { under_2m: 1, "2m_to_10m": 4 },
    featureUsageBreakdown: { web_search: 3, web_fetch: 2 },
    dailyBreakdown: [
      { date: "2026-03-20", sessions: 2, tokens: 1_000, linesAdded: 120 },
    ],
    toolComparison: {
      claude: {
        sessionCount: 5,
        successRate: 100,
        topTools: [["Bash", 12]],
        topLanguages: [["typescript", 8]],
      },
      codex: {
        sessionCount: 0,
        successRate: 0,
        topTools: [],
        topLanguages: [],
      },
    },
    achievements: [],
  });

  assert.match(summary.headline, /claude/i);
  assert.equal(summary.bullets.length, 4);
  assert.match(summary.bullets.join("\n"), /feature|bug/i);
});
