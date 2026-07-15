"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const CLI = path.join(__dirname, "..", "bin", "skill-sync.js");

test("prints the CLI version for the long and short version flags", () => {
  for (const flag of ["--version", "-v"]) {
    const result = childProcess.spawnSync(process.execPath, [CLI, flag], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "0.4.0");
  }
});

test("syncs additions, edits, and deletions across all client directories", (context) => {
  const fixture = createFixture(context);
  writeSkill(fixture.targets[0].path, "shared-skill", "version one");

  initFixture(fixture);
  runCli(fixture, ["sync", "--json"]);

  for (const target of fixture.targets) {
    assert.equal(readSkill(target.path, "shared-skill"), "version one");
  }

  writeSkill(fixture.targets[1].path, "shared-skill", "edited in Claude Code");
  runCli(fixture, ["sync", "--json"]);
  for (const target of fixture.targets) {
    assert.equal(readSkill(target.path, "shared-skill"), "edited in Claude Code");
  }

  writeSkill(fixture.targets[2].path, "workbuddy-created", "created in WorkBuddy");
  runCli(fixture, ["sync", "--json"]);
  for (const target of fixture.targets) {
    assert.equal(readSkill(target.path, "workbuddy-created"), "created in WorkBuddy");
  }

  fs.rmSync(path.join(fixture.targets[0].path, "shared-skill"), { recursive: true, force: true });
  runCli(fixture, ["sync", "--json"]);
  for (const target of fixture.targets) {
    assert.equal(fs.existsSync(path.join(target.path, "shared-skill")), false);
  }

  const status = runCli(fixture, ["status", "--json"]).data;
  assert.equal(status.skillTargets.length, 3);
  assert.deepEqual(status.skills.map((skill) => skill.name), ["workbuddy-created"]);
  assert.equal(status.skills[0].state, "same");
});

test("pauses when two clients edit the same skill differently", (context) => {
  const fixture = createFixture(context);
  writeSkill(fixture.targets[0].path, "shared-skill", "base version");
  initFixture(fixture);
  runCli(fixture, ["sync", "--json"]);

  writeSkill(fixture.targets[0].path, "shared-skill", "edited in Codex");
  writeSkill(fixture.targets[1].path, "shared-skill", "edited in Claude Code");
  const result = runCli(fixture, ["sync", "--json"], { allowFail: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /多个客户端中存在同名但内容不同的技能/);
  assert.equal(readSkill(fixture.targets[0].path, "shared-skill"), "edited in Codex");
  assert.equal(readSkill(fixture.targets[1].path, "shared-skill"), "edited in Claude Code");

  const conflictRoot = path.join(fixture.root, "state", "conflicts");
  const conflictFiles = listFiles(conflictRoot);
  assert.ok(conflictFiles.some((file) => file.endsWith(path.join("agents", "SKILL.md"))));
  assert.ok(conflictFiles.some((file) => file.endsWith(path.join("claude-code", "SKILL.md"))));
});

test("migrates a legacy single-directory config to the supported clients", (context) => {
  const fixture = createFixture(context);
  const legacy = path.join(fixture.home, ".codex", "skills");
  fs.mkdirSync(path.dirname(fixture.config), { recursive: true });
  fs.writeFileSync(fixture.config, `${JSON.stringify({
    repoDir: fixture.repo,
    skillsDir: legacy,
    branch: "main"
  }, null, 2)}\n`);

  const doctor = runCli(fixture, ["doctor", "--json"], { allowFail: true }).data;
  assert.deepEqual(
    doctor.settings.skillTargets.map((target) => target.id),
    ["codex-legacy", "agents", "claude-code", "workbuddy"]
  );
});

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-sync-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const targets = [
    { id: "agents", label: "Codex + MiniMax Code", path: path.join(home, ".agents", "skills"), clients: ["codex", "minimax-code"] },
    { id: "claude-code", label: "Claude Code", path: path.join(home, ".claude", "skills"), clients: ["claude-code"] },
    { id: "workbuddy", label: "WorkBuddy", path: path.join(home, ".workbuddy", "skills"), clients: ["workbuddy"] }
  ];
  return {
    root,
    home,
    targets,
    repo: path.join(root, "repo"),
    config: path.join(root, "state", "config.json")
  };
}

function initFixture(fixture) {
  runCli(fixture, [
    "init",
    "--repo",
    fixture.repo,
    "--targets-json",
    JSON.stringify(fixture.targets),
    "--import-existing",
    "--json"
  ]);
}

function runCli(fixture, args, options = {}) {
  const result = childProcess.spawnSync(process.execPath, [CLI, ...args, "--config", fixture.config], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      CODEX_HOME: "",
      SKILL_SYNC_CONFIG: fixture.config
    }
  });
  if (!options.allowFail && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `skill-sync exited with ${result.status}`);
  }
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    data: parseJson(result.stdout)
  };
}

function writeSkill(root, name, body) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}\n`);
}

function readSkill(root, name) {
  const value = fs.readFileSync(path.join(root, name, "SKILL.md"), "utf8");
  return value.trim().split("\n").at(-1);
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    return null;
  }
}
