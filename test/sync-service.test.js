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
