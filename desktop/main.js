"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  session,
  shell,
  Tray
} = require("electron");
const { runSkillSyncAsync, startServer } = require("../bin/skill-sync-ui");
const { SyncService } = require("./sync-service");
const { GitHubService } = require("./github-service");
const { applyProxyEnvironment, detectNetworkProxy } = require("./proxy-service");

const APP_NAME = "Codex 技能同步器";
const syncOnceRequested = process.argv.includes("--sync-once");

let mainWindow = null;
let tray = null;
let server = null;
let syncService = null;
let githubService = null;
let networkProxy = null;
let proxyCheckPromise = null;
let lastProxyCheckAt = 0;
let isQuitting = false;

const hasSingleInstanceLock = syncOnceRequested || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app.whenReady().then(startDesktopApp).catch((error) => {
    dialog.showErrorBox(`${APP_NAME}启动失败`, error.message);
    app.quit();
  });
}

async function startDesktopApp() {
  app.setName(APP_NAME);
  if (syncOnceRequested && process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
  if (process.platform === "win32") {
    app.setAppUserModelId("com.codexskillsync.desktop");
  }

  await configureNetworkProxy();

  syncService = new SyncService({
    runCommand: runSkillSyncAsync,
    onStateChange: () => rebuildTrayMenu()
  });
  githubService = new GitHubService({
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    prepareNetwork: configureNetworkProxy,
    openExternal: (url) => shell.openExternal(url)
  });

  if (syncOnceRequested) {
    await syncService.configurationChanged();
    const result = await syncService.syncNow("codex-start");
    if (!result.ok && result.error) console.error(result.error);
    syncService.stop();
    app.exit(result.ok ? 0 : 1);
    return;
  }

  const desktopBridge = createDesktopBridge();
  const started = await startServer({
    host: "127.0.0.1",
    port: 0,
    desktopBridge
  });
  server = started.server;

  createMainWindow(started.url);
  createTray();
  await syncService.start();

  app.on("activate", showMainWindow);
  app.on("before-quit", () => {
    isQuitting = true;
  });
  app.on("will-quit", () => {
    if (syncService) syncService.stop();
    if (server) server.close();
  });
}

function createMainWindow(url) {
  const icon = loadAppIcon();
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 920,
    minHeight: 660,
    show: false,
    title: APP_NAME,
    backgroundColor: "#f6f7f4",
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(url);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    if (isQuitting || !syncService || !syncService.settings.closeToTray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (target !== url && !target.startsWith(`${url}/`)) {
      event.preventDefault();
    }
  });
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.setToolTip(APP_NAME);
  tray.on("click", showMainWindow);
  rebuildTrayMenu();
}

function createTrayImage() {
  const image = loadAppIcon();
  return image.resize({ width: 18, height: 18, quality: "best" });
}

function loadAppIcon() {
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  if (!fs.existsSync(iconPath)) return nativeImage.createEmpty();
  return nativeImage.createFromBuffer(fs.readFileSync(iconPath));
}

function rebuildTrayMenu() {
  if (!tray || !syncService) return;
  const status = syncService.getStatus();
  const label = trayStatusLabel(status.state);
  const menu = Menu.buildFromTemplate([
    { label: "打开技能同步器", click: showMainWindow },
    { label, enabled: false },
    { type: "separator" },
    {
      label: "立即同步",
      enabled: status.state.configured && !status.state.running,
      click: () => syncService.syncNow("manual").catch(() => {})
    },
    {
      label: "自动同步",
      type: "checkbox",
      checked: status.settings.autoSync,
      click: (item) => syncService.updateSettings({ autoSync: item.checked }).catch(() => {})
    },
    {
      label: "开机自动启动",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        setLaunchAtLogin(item.checked);
        syncService.updateSettings({ launchAtLogin: item.checked }).catch(() => {});
      }
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`${APP_NAME} - ${label}`);
}

function trayStatusLabel(state) {
  if (state.running) return "正在同步";
  if (!state.configured) return "等待配置";
  if (state.paused || state.phase === "attention") return "需要处理冲突";
  if (state.phase === "error") return "同步遇到问题";
  return "自动同步已开启";
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createDesktopBridge() {
  return {
    getStatus: async () => withAppStatus(syncService.getStatus()),
    updateSettings: async (patch) => {
      if (Object.prototype.hasOwnProperty.call(patch, "launchAtLogin")) {
        setLaunchAtLogin(Boolean(patch.launchAtLogin));
      }
      const updated = await syncService.updateSettings(patch);
      return withAppStatus(updated);
    },
    syncNow: async (trigger) => syncService.syncNow(trigger === "manual" ? "manual" : String(trigger || "manual")),
    configurationChanged: async () => {
      await syncService.configurationChanged();
      return syncService.syncNow("setup");
    },
    selectDirectory: chooseDirectory,
    installHook: installCodexHook,
    openPath: openConfiguredPath,
    getOnboardingStatus,
    connectGitHub: () => githubService.login(),
    openGitHubDevice: async () => {
      await githubService.openPendingDevicePage();
      return { opened: true };
    },
    simpleSetup: runSimpleSetup
  };
}

async function getOnboardingStatus() {
  const [statusResult, doctorResult, github] = await Promise.all([
    runSkillSyncAsync(["status", "--json"]),
    runSkillSyncAsync(["doctor", "--json"]),
    githubService.getStatus()
  ]);
  const doctor = doctorResult.data || {};
  const checks = Object.fromEntries((doctor.checks || []).map((item) => [item.name, item]));
  const status = statusResult.ok ? statusResult.data : null;
  const localSkillCount = status
    ? (status.skills || []).filter((skill) => skill.state !== "missing-local").length
    : Number(checks.localSkillCount && checks.localSkillCount.detail || 0);

  return {
    configured: Boolean(status),
    skillsDir: status && status.skillsDir || doctor.settings && doctor.settings.skillsDir || "",
    localSkillCount,
    remote: status && status.remote || "",
    gitAvailable: Boolean(checks.git && checks.git.ok),
    proxy: networkProxy ? { enabled: true, source: networkProxy.source } : { enabled: false, source: "" },
    github
  };
}

async function runSimpleSetup(options = {}) {
  const role = options.role === "receiver" ? "receiver" : "source";
  const onboarding = await getOnboardingStatus();
  if (!onboarding.gitAvailable) {
    throw new Error("这台电脑没有可用的 Git。请先安装 Git，再重新打开技能同步器。");
  }
  if (!onboarding.github.authenticated) {
    throw new Error("请先使用浏览器连接 GitHub。");
  }
  if (role === "source" && onboarding.localSkillCount < 1) {
    throw new Error("这台电脑没有发现技能，请选择“从其他电脑获取”。");
  }

  await githubService.configureGitCredentials();
  const repository = await githubService.ensurePrivateRepository(options.repositoryName);
  const initArgs = [
    "init",
    repository.cloneUrl,
    "--skills-dir",
    onboarding.skillsDir
  ];
  if (role === "source") initArgs.push("--import-existing");
  initArgs.push("--json");

  const initialized = await runSkillSyncAsync(initArgs);
  if (!initialized.ok) {
    throw new Error(initialized.error || initialized.stderr || "无法完成同步配置。");
  }

  setLaunchAtLogin(options.launchAtLogin !== false);
  await syncService.updateSettings({
    autoSync: true,
    syncOnStart: true,
    launchAtLogin: options.launchAtLogin !== false,
    closeToTray: true,
    syncIntervalSeconds: 30
  });
  await syncService.configurationChanged();
  const synced = await syncService.syncNow("setup");
  if (!synced.ok) {
    throw new Error(synced.error || synced.stderr || "首次同步没有完成。");
  }

  let hookInstalled = false;
  let hookWarning = "";
  if (options.installHook !== false) {
    const hook = await installCodexHook();
    hookInstalled = Boolean(hook.ok);
    hookWarning = hook.ok ? "" : String(hook.error || hook.stderr || "Codex 启动同步安装失败。");
  }

  return {
    ok: true,
    role,
    repository,
    initialized: initialized.data,
    synced: synced.data,
    hookInstalled,
    hookWarning,
    status: await getOnboardingStatus()
  };
}

function withAppStatus(status) {
  return {
    ...status,
    app: {
      name: APP_NAME,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      launchAtLogin: app.getLoginItemSettings().openAtLogin,
      canLaunchAtLogin: process.platform === "darwin" || process.platform === "win32",
      proxy: networkProxy ? { enabled: true, source: networkProxy.source } : { enabled: false, source: "" }
    }
  };
}

async function configureNetworkProxy() {
  if (networkProxy) return networkProxy;
  if (proxyCheckPromise) return proxyCheckPromise;
  if (Date.now() - lastProxyCheckAt < 10000) return null;
  lastProxyCheckAt = Date.now();
  proxyCheckPromise = detectNetworkProxy({
    resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url)
  }).then((proxy) => {
    if (proxy) {
      networkProxy = proxy;
      applyProxyEnvironment(proxy, process.env);
    }
    return proxy;
  }).finally(() => {
    proxyCheckPromise = null;
  });
  return proxyCheckPromise;
}

function setLaunchAtLogin(enabled) {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  rebuildTrayMenu();
}

async function chooseDirectory(kind) {
  const titles = {
    repo: "选择本地同步仓库目录",
    skills: "选择 Codex 技能目录"
  };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: titles[kind] || "选择文件夹",
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled ? "" : result.filePaths[0] || "";
}

async function installCodexHook() {
  const target = path.join(os.homedir(), ".codex", "hooks.json");
  const executable = shellQuote(process.execPath);
  const appArgument = app.isPackaged ? "" : ` ${shellQuote(app.getAppPath())}`;
  const runnerCommand = `${executable}${appArgument} --sync-once`;
  return runSkillSyncAsync([
    "install-hook",
    "--target",
    target,
    "--runner-command",
    runnerCommand,
    "--write",
    "--json"
  ]);
}

async function openConfiguredPath(kind) {
  const result = await runSkillSyncAsync(["status", "--json"]);
  if (!result.ok || !result.data) {
    throw new Error("请先完成同步配置。");
  }
  const targets = {
    repo: result.data.repoDir,
    skills: result.data.skillsDir,
    conflicts: path.join(path.dirname(result.data.configPath), "conflicts")
  };
  const target = targets[kind];
  if (!target) throw new Error("不支持的目录类型。");
  if (kind === "conflicts") fs.mkdirSync(target, { recursive: true });
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return target;
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (!syncService || !syncService.settings.closeToTray) app.quit();
});
