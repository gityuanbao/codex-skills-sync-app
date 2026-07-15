"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SyncService } = require("../desktop/sync-service");

test("persists the safe onboarding display flag independently of sync data", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skill-sync-test-"));
  const settingsPath = path.join(directory, "desktop.json");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = new SyncService({ runCommand: async () => ({ ok: false }), settingsPath });
  await first.updateSettings({ showOnboarding: true });

  const reloaded = new SyncService({ runCommand: async () => ({ ok: false }), settingsPath });
  assert.equal(reloaded.settings.showOnboarding, true);
  assert.equal(reloaded.settings.autoSync, true);

  await reloaded.updateSettings({ showOnboarding: false });
  const finished = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(finished.showOnboarding, false);
});

test("pauses automatic sync for cross-client skill conflicts", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-sync-conflict-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = new SyncService({
    settingsPath: path.join(directory, "desktop.json"),
    runCommand: async (args) => {
      if (args[0] === "status") {
        return { ok: true, data: { skillsDirs: [] } };
      }
      return { ok: false, error: "多个客户端中存在同名但内容不同的技能，自动同步已暂停。" };
    }
  });

  await service.configurationChanged();
  const result = await service.syncNow("manual");

  assert.equal(result.ok, false);
  assert.equal(service.getStatus().state.paused, true);
  assert.equal(service.getStatus().state.phase, "attention");
});
