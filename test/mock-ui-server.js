"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { startServer } = require("../bin/skill-sync-ui");

const scenario = process.argv[2] || "onboarding";
const port = Number(process.argv[3] || 17322);
let showOnboarding = false;
let authenticated = scenario === "dashboard";
let deviceLoginActive = false;

if (scenario === "dashboard") prepareDashboardFixture();

const desktopState = {
  settings: {
    autoSync: true,
    syncOnStart: true,
    syncIntervalSeconds: 30,
    launchAtLogin: true,
    closeToTray: true,
    showOnboarding: false
  },
  state: {
    configured: scenario === "dashboard",
    phase: scenario === "dashboard" ? "idle" : "setup",
    running: false,
    paused: false,
    lastSuccessAt: scenario === "dashboard" ? new Date().toISOString() : "",
    lastError: ""
  },
  app: {
    name: "Agent Skills 同步器",
    version: "0.4.0",
    platform: "darwin",
    launchAtLogin: true,
    canLaunchAtLogin: true,
    releasePageUrl: "https://github.com/gityuanbao/codex-skills-sync-app/releases/latest"
  }
};

const bridge = {
  getStatus: async () => desktopState,
  getOnboardingStatus: async () => ({
    configured: scenario === "dashboard",
    showOnboarding,
    skillsDir: process.env.SKILL_SYNC_SKILLS_DIR || "/Users/test/.agents/skills",
    skillTargets: [
      { id: "agents", label: "Codex + MiniMax Code", path: "/Users/test/.agents/skills", clients: ["codex", "minimax-code"], skillCount: 3 },
      { id: "claude-code", label: "Claude Code", path: "/Users/test/.claude/skills", clients: ["claude-code"], skillCount: 3 },
      { id: "workbuddy", label: "WorkBuddy", path: "/Users/test/.workbuddy/skills", clients: ["workbuddy"], skillCount: 3 }
    ],
    localSkillCount: scenario === "dashboard" ? 3 : 8,
    gitAvailable: true,
    github: {
      available: true,
      authenticated,
      login: authenticated ? "octocat" : "",
      name: authenticated ? "Octocat" : "",
      error: ""
    }
  }),
  connectGitHub: async () => {
    deviceLoginActive = true;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    deviceLoginActive = false;
    authenticated = true;
    return { available: true, authenticated: true, login: "octocat", name: "Octocat" };
  },
  getGitHubDeviceInfo: async () => ({
    active: deviceLoginActive,
    code: deviceLoginActive ? "ABCD-EFGH" : "",
    url: "https://github.com/login/device?user_code=ABCD-EFGH"
  }),
  openGitHubDevice: async () => ({ opened: true }),
  diagnoseGitHub: async () => ({
    online: true,
    latencyMs: 186,
    viaProxy: true,
    proxySource: "local",
    message: "GitHub 连接正常。"
  }),
  reconnectGitHub: async () => {
    authenticated = false;
    showOnboarding = true;
    return bridge.getOnboardingStatus();
  },
  startOnboarding: async () => {
    showOnboarding = true;
    return bridge.getOnboardingStatus();
  },
  finishOnboarding: async () => {
    showOnboarding = false;
    return bridge.getOnboardingStatus();
  },
  checkForUpdate: async () => ({
    currentVersion: "0.4.0",
    latestVersion: "0.4.0",
    updateAvailable: false
  }),
  openReleasePage: async () => ({ opened: true }),
  simpleSetup: async () => ({ ok: true }),
  updateSettings: async (patch) => {
    Object.assign(desktopState.settings, patch);
    return desktopState;
  },
  syncNow: async () => ({ ok: true, data: { changed: false } }),
  selectDirectory: async () => "",
  installHook: async () => ({ ok: true }),
  openPath: async () => ""
};

startServer({ port, desktopBridge: bridge, log: true });

function prepareDashboardFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sync-dashboard-"));
  const config = path.join(root, "config.json");
  const repo = path.join(root, "repo");
  const targets = [
    { id: "agents", label: "Codex + MiniMax Code", path: path.join(root, ".agents", "skills"), clients: ["codex", "minimax-code"] },
    { id: "claude-code", label: "Claude Code", path: path.join(root, ".claude", "skills"), clients: ["claude-code"] },
    { id: "workbuddy", label: "WorkBuddy", path: path.join(root, ".workbuddy", "skills"), clients: ["workbuddy"] }
  ];
  const skills = targets[0].path;
  for (const name of ["research-helper", "video-writer", "meeting-notes"]) {
    const directory = path.join(skills, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`);
  }
  process.env.SKILL_SYNC_CONFIG = config;
  process.env.SKILL_SYNC_REPO = repo;
  process.env.SKILL_SYNC_TARGETS_JSON = JSON.stringify(targets);
  const cli = path.join(__dirname, "..", "bin", "skill-sync.js");
  const result = childProcess.spawnSync(process.execPath, [
    cli,
    "init",
    "--repo",
    repo,
    "--targets-json",
    JSON.stringify(targets),
    "--import-existing"
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "无法准备界面测试数据。");
  }
}
