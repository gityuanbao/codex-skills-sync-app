"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { startServer } = require("../bin/skill-sync-ui");

const scenario = process.argv[2] || "onboarding";
const port = Number(process.argv[3] || 17322);

if (scenario === "dashboard") prepareDashboardFixture();

const desktopState = {
  settings: {
    autoSync: true,
    syncOnStart: true,
    syncIntervalSeconds: 30,
    launchAtLogin: true,
    closeToTray: true
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
    launchAtLogin: true,
    canLaunchAtLogin: true
  }
};

const bridge = {
  getStatus: async () => desktopState,
  getOnboardingStatus: async () => ({
    configured: scenario === "dashboard",
    skillsDir: process.env.SKILL_SYNC_SKILLS_DIR || "/Users/test/.codex/skills",
    localSkillCount: scenario === "dashboard" ? 3 : 8,
    gitAvailable: true,
    github: {
      available: true,
      authenticated: scenario === "dashboard",
      login: scenario === "dashboard" ? "octocat" : "",
      name: scenario === "dashboard" ? "Octocat" : "",
      error: ""
    }
  }),
  connectGitHub: async () => ({ available: true, authenticated: true, login: "octocat", name: "Octocat" }),
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
  const skills = path.join(root, "skills");
  for (const name of ["research-helper", "video-writer", "meeting-notes"]) {
    const directory = path.join(skills, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`);
  }
  process.env.SKILL_SYNC_CONFIG = config;
  process.env.SKILL_SYNC_REPO = repo;
  process.env.SKILL_SYNC_SKILLS_DIR = skills;
  const cli = path.join(__dirname, "..", "bin", "skill-sync.js");
  const result = childProcess.spawnSync(process.execPath, [
    cli,
    "init",
    "--repo",
    repo,
    "--skills-dir",
    skills,
    "--import-existing"
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "无法准备界面测试数据。");
  }
}
