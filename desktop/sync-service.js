"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_SETTINGS = Object.freeze({
  autoSync: true,
  syncOnStart: true,
  syncIntervalSeconds: 30,
  launchAtLogin: false,
  closeToTray: true,
  showOnboarding: false
});

class SyncService {
  constructor(options) {
    if (!options || typeof options.runCommand !== "function") {
      throw new Error("SyncService 需要 runCommand。");
    }

    this.runCommand = options.runCommand;
    this.onStateChange = options.onStateChange || (() => {});
    this.settingsPath = options.settingsPath || process.env.SKILL_SYNC_DESKTOP_CONFIG
      || path.join(os.homedir(), ".codex-skill-sync", "desktop.json");
    this.settings = this.loadSettings();
    this.state = {
      configured: false,
      phase: "setup",
      running: false,
      paused: false,
      watchedDirectory: "",
      lastTrigger: "",
      lastStartedAt: "",
      lastSuccessAt: "",
      lastErrorAt: "",
      lastError: "",
      nextSyncAt: "",
      lastSummary: null
    };
    this.started = false;
    this.pending = false;
    this.intervalTimer = null;
    this.debounceTimer = null;
    this.startupTimer = null;
    this.queuedTimer = null;
    this.watcher = null;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.refreshConfiguration();
    this.configureInterval();
    if (this.settings.autoSync && this.settings.syncOnStart && this.state.configured) {
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        this.syncNow("startup").catch(() => {});
      }, 900);
    }
  }

  stop() {
    this.started = false;
    this.pending = false;
    this.clearInterval();
    this.clearDebounce();
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.queuedTimer) clearTimeout(this.queuedTimer);
    this.startupTimer = null;
    this.queuedTimer = null;
    this.closeWatcher();
  }

  getStatus() {
    return {
      settingsPath: this.settingsPath,
      settings: { ...this.settings },
      state: { ...this.state }
    };
  }

  async updateSettings(patch = {}) {
    const previous = this.settings;
    const next = { ...this.settings };
    for (const key of ["autoSync", "syncOnStart", "launchAtLogin", "closeToTray", "showOnboarding"]) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        next[key] = Boolean(patch[key]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "syncIntervalSeconds")) {
      const value = Number(patch.syncIntervalSeconds);
      if (!Number.isFinite(value)) {
        throw new Error("同步间隔必须是数字。");
      }
      next.syncIntervalSeconds = Math.min(3600, Math.max(15, Math.round(value)));
    }

    this.settings = next;
    this.saveSettings();
    this.configureInterval();
    this.emitState();

    if (!previous.autoSync && this.settings.autoSync && this.state.configured && !this.state.running) {
      this.syncNow("settings").catch(() => {});
    }
    return this.getStatus();
  }

  async configurationChanged() {
    this.state.paused = false;
    this.state.lastError = "";
    await this.refreshConfiguration();
    this.configureInterval();
    return this.getStatus();
  }

  async syncNow(trigger = "manual") {
    const manual = trigger === "manual" || trigger === "user" || trigger === "setup";
    if (this.state.running) {
      this.pending = true;
      return {
        ok: true,
        queued: true,
        data: { message: "已有同步正在运行，已加入下一轮。" }
      };
    }
    if (this.state.paused && !manual) {
      return {
        ok: false,
        paused: true,
        error: this.state.lastError || "自动同步已暂停，等待处理。"
      };
    }
    if (!this.state.configured) {
      await this.refreshConfiguration();
      if (!this.state.configured) {
        return { ok: false, error: "请先完成同步配置。" };
      }
    }

    this.state.running = true;
    this.state.phase = "syncing";
    this.state.lastTrigger = trigger;
    this.state.lastStartedAt = new Date().toISOString();
    this.state.nextSyncAt = "";
    this.emitState();

    let result;
    try {
      result = await this.runCommand(["sync", "--json"]);
      if (result.ok) {
        this.state.phase = "idle";
        this.state.paused = false;
        this.state.lastError = "";
        this.state.lastSuccessAt = new Date().toISOString();
        this.state.lastSummary = result.data || null;
        await this.refreshConfiguration();
      } else {
        this.recordError(result.error || result.stderr || "同步失败。");
      }
      return result;
    } catch (error) {
      this.recordError(error.message);
      return { ok: false, error: error.message };
    } finally {
      this.state.running = false;
      this.configureInterval();
      this.emitState();
      if (this.pending && this.started) {
        this.pending = false;
        this.queuedTimer = setTimeout(() => {
          this.queuedTimer = null;
          this.syncNow("queued").catch(() => {});
        }, 500);
      }
    }
  }

  recordError(message) {
    const text = String(message || "同步失败。").trim();
    const needsAttention = /自动合并失败|首次同步发现|未处理的改动|冲突/.test(text);
    const needsSetup = /没有找到配置文件|请先运行 skill-sync init|同步仓库不存在/.test(text);
    this.state.lastError = text;
    this.state.lastErrorAt = new Date().toISOString();
    this.state.paused = needsAttention;
    this.state.configured = needsSetup ? false : this.state.configured;
    this.state.phase = needsSetup ? "setup" : needsAttention ? "attention" : "error";
  }

  async refreshConfiguration() {
    const result = await this.runCommand(["status", "--json"]);
    if (!result.ok || !result.data) {
      this.state.configured = false;
      if (!this.state.running) this.state.phase = "setup";
      this.state.watchedDirectory = "";
      this.closeWatcher();
      this.emitState();
      return false;
    }

    this.state.configured = true;
    if (!this.state.running && !this.state.paused && this.state.phase === "setup") {
      this.state.phase = "idle";
    }
    this.watchDirectory(result.data.skillsDir || "");
    this.emitState();
    return true;
  }

  watchDirectory(directory) {
    if (!directory || !fs.existsSync(directory)) {
      this.closeWatcher();
      this.state.watchedDirectory = "";
      return;
    }
    if (this.watcher && this.state.watchedDirectory === directory) return;

    this.closeWatcher();
    try {
      this.watcher = fs.watch(directory, { recursive: true }, (_event, filename) => {
        if (!this.settings.autoSync || this.state.paused) return;
        const value = String(filename || "");
        if (/(^|[/\\])(\.DS_Store|\.git)([/\\]|$)/.test(value)) return;
        this.clearDebounce();
        this.debounceTimer = setTimeout(() => {
          this.syncNow("file-change").catch(() => {});
        }, 2500);
      });
      this.watcher.on("error", (error) => {
        this.state.lastError = `技能目录监听失败：${error.message}`;
        this.state.phase = "error";
        this.closeWatcher();
        this.emitState();
      });
      this.state.watchedDirectory = directory;
    } catch (error) {
      this.state.lastError = `技能目录监听失败：${error.message}`;
      this.state.phase = "error";
      this.state.watchedDirectory = "";
    }
  }

  configureInterval() {
    this.clearInterval();
    if (!this.started || !this.settings.autoSync || !this.state.configured || this.state.paused) {
      this.state.nextSyncAt = "";
      return;
    }
    const intervalMs = this.settings.syncIntervalSeconds * 1000;
    this.state.nextSyncAt = new Date(Date.now() + intervalMs).toISOString();
    this.intervalTimer = setInterval(() => {
      this.state.nextSyncAt = new Date(Date.now() + intervalMs).toISOString();
      this.syncNow("interval").catch(() => {});
    }, intervalMs);
  }

  clearInterval() {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.intervalTimer = null;
  }

  clearDebounce() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  closeWatcher() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  loadSettings() {
    try {
      if (!fs.existsSync(this.settingsPath)) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings() {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    const temp = `${this.settingsPath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(this.settings, null, 2)}\n`);
    fs.renameSync(temp, this.settingsPath);
  }

  emitState() {
    this.onStateChange(this.getStatus());
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  SyncService
};
