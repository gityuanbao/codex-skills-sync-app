"use strict";

const state = {
  meta: null,
  onboarding: null,
  status: null,
  desktop: null,
  currentStep: 1,
  role: "source",
  busy: false,
  dashboardReady: false
};

const elements = Object.fromEntries([
  "loadingView",
  "onboardingView",
  "dashboardView",
  "skillDetection",
  "detectedSkillTitle",
  "detectedSkillText",
  "detectedSkillsPath",
  "environmentError",
  "toGitHubButton",
  "githubAccount",
  "githubAccountName",
  "githubAccountText",
  "githubError",
  "proxyStatus",
  "connectGitHubButton",
  "toRoleButton",
  "githubLoginHelp",
  "openGitHubDeviceButton",
  "sourceRoleOption",
  "sourceRoleHelp",
  "toFinishButton",
  "summaryAccount",
  "summarySkills",
  "summaryRole",
  "setupLaunchAtLogin",
  "setupInstallHook",
  "setupError",
  "startSyncButton",
  "setupProgressText",
  "accountLabel",
  "headerState",
  "refreshButton",
  "syncStatusBand",
  "largeStatusIcon",
  "mainStatusTitle",
  "mainStatusText",
  "syncNowButton",
  "sameCount",
  "differentCount",
  "localOnlyCount",
  "missingLocalCount",
  "skillListSummary",
  "skillsList",
  "openSkillsButton",
  "autoSyncState",
  "autoSyncInput",
  "syncOnStartInput",
  "launchAtLoginInput",
  "closeToTrayInput",
  "desktopError",
  "remoteInput",
  "repoInput",
  "skillsDirInput",
  "selectRepoButton",
  "selectSkillsButton",
  "importExistingInput",
  "initButton",
  "installHookButton",
  "openRepoButton",
  "openConflictsButton",
  "syncIntervalInput",
  "commandLine",
  "clearLogButton",
  "logOutput"
].map((id) => [id, document.getElementById(id)]));

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  bootstrap();
  setInterval(() => {
    if (state.dashboardReady && !state.busy) refreshDashboard({ quiet: true });
  }, 5000);
});

function bindEvents() {
  elements.toGitHubButton.addEventListener("click", () => setStep(2));
  elements.connectGitHubButton.addEventListener("click", connectGitHub);
  elements.openGitHubDeviceButton.addEventListener("click", openGitHubDevice);
  elements.toRoleButton.addEventListener("click", () => setStep(3));
  elements.toFinishButton.addEventListener("click", () => setStep(4));
  elements.startSyncButton.addEventListener("click", startSimpleSetup);

  document.querySelectorAll("[data-back-step]").forEach((button) => {
    button.addEventListener("click", () => setStep(Number(button.dataset.backStep)));
  });
  document.querySelectorAll('input[name="computerRole"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      state.role = input.value;
      renderRoleSelection();
    });
  });

  elements.refreshButton.addEventListener("click", () => refreshDashboard());
  elements.syncNowButton.addEventListener("click", runSync);
  elements.clearLogButton.addEventListener("click", () => {
    elements.commandLine.textContent = "尚未执行命令";
    elements.logOutput.textContent = "";
  });
  elements.autoSyncInput.addEventListener("change", () => updateSettings({ autoSync: elements.autoSyncInput.checked }));
  elements.syncOnStartInput.addEventListener("change", () => updateSettings({ syncOnStart: elements.syncOnStartInput.checked }));
  elements.launchAtLoginInput.addEventListener("change", () => updateSettings({ launchAtLogin: elements.launchAtLoginInput.checked }));
  elements.closeToTrayInput.addEventListener("change", () => updateSettings({ closeToTray: elements.closeToTrayInput.checked }));
  elements.syncIntervalInput.addEventListener("change", () => updateSettings({ syncIntervalSeconds: Number(elements.syncIntervalInput.value) }));

  elements.openSkillsButton.addEventListener("click", () => openPath("skills"));
  elements.openRepoButton.addEventListener("click", () => openPath("repo"));
  elements.openConflictsButton.addEventListener("click", () => openPath("conflicts"));
  elements.installHookButton.addEventListener("click", installHook);
  elements.selectRepoButton.addEventListener("click", () => selectDirectory("repo", elements.repoInput));
  elements.selectSkillsButton.addEventListener("click", () => selectDirectory("skills", elements.skillsDirInput));
  elements.initButton.addEventListener("click", saveAdvancedConfiguration);

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runAdvancedAction(button.dataset.action));
  });
}

async function bootstrap() {
  try {
    state.meta = await request("/api/meta");
    if (!state.meta.desktop) {
      throw new Error("请从桌面应用打开技能同步器。");
    }
    const result = await request("/api/desktop/onboarding");
    state.onboarding = result.data;
    if (state.onboarding.configured) {
      showDashboard();
      await refreshDashboard();
    } else {
      showOnboarding();
    }
  } catch (error) {
    showOnboarding();
    showError(elements.environmentError, error.message);
    elements.toGitHubButton.disabled = true;
  } finally {
    elements.loadingView.hidden = true;
  }
}

function showOnboarding() {
  state.dashboardReady = false;
  elements.loadingView.hidden = true;
  elements.dashboardView.hidden = true;
  elements.onboardingView.hidden = false;
  renderOnboarding();
  setStep(state.currentStep || 1);
}

function renderOnboarding() {
  const onboarding = state.onboarding || {};
  const count = Number(onboarding.localSkillCount || 0);
  elements.detectedSkillsPath.textContent = onboarding.skillsDir || "没有找到技能文件夹";
  elements.detectedSkillTitle.textContent = count > 0 ? `发现 ${count} 个 Codex 技能` : "暂时没有发现本机技能";
  elements.detectedSkillText.textContent = count > 0
    ? "这些技能可以作为第一份版本，也可以先与其他电脑合并。"
    : "如果技能保存在另一台电脑，后面选择从其他电脑获取即可。";
  elements.skillDetection.classList.toggle("warning", count < 1);

  const gitReady = onboarding.gitAvailable !== false;
  elements.toGitHubButton.dataset.permanentlyDisabled = gitReady ? "false" : "true";
  elements.toGitHubButton.disabled = !gitReady;
  showError(elements.environmentError, gitReady ? "" : "这台电脑缺少 Git。当前版本需要先安装 Git 才能同步。");

  const proxy = onboarding.proxy || {};
  elements.proxyStatus.hidden = !proxy.enabled;
  elements.proxyStatus.textContent = proxy.source === "local"
    ? "已自动使用本机网络代理"
    : "已自动使用系统网络代理";

  renderGitHubAccount();
  if (count < 1 && state.role === "source") state.role = "receiver";
  const sourceInput = document.querySelector('input[name="computerRole"][value="source"]');
  sourceInput.disabled = count < 1;
  elements.sourceRoleOption.classList.toggle("disabled", count < 1);
  elements.sourceRoleHelp.textContent = count > 0
    ? `把本机发现的 ${count} 个技能作为第一份版本保存到 GitHub`
    : "本机没有技能，不能把它作为第一份版本";
  document.querySelector(`input[name="computerRole"][value="${state.role}"]`).checked = true;
  renderRoleSelection();
  renderSetupSummary();
}

function renderGitHubAccount() {
  const github = state.onboarding && state.onboarding.github || {};
  const connected = Boolean(github.authenticated);
  elements.githubAccount.hidden = !connected;
  elements.connectGitHubButton.hidden = connected;
  elements.toRoleButton.hidden = !connected;
  if (connected) {
    elements.githubAccountName.textContent = github.name || github.login || "GitHub 用户";
    elements.githubAccountText.textContent = github.login ? `@${github.login}` : "授权有效";
    elements.accountLabel.textContent = github.login ? `GitHub · @${github.login}` : "GitHub 已连接";
  }
  showError(elements.githubError, github.available === false ? github.error : "");
}

function setStep(step) {
  state.currentStep = Math.min(4, Math.max(1, Number(step || 1)));
  document.querySelectorAll("[data-step]").forEach((section) => {
    section.classList.toggle("active", Number(section.dataset.step) === state.currentStep);
  });
  document.querySelectorAll("[data-step-marker]").forEach((marker) => {
    const markerStep = Number(marker.dataset.stepMarker);
    marker.classList.toggle("active", markerStep === state.currentStep);
    marker.classList.toggle("done", markerStep < state.currentStep);
  });
  if (state.currentStep === 4) renderSetupSummary();
}

async function connectGitHub() {
  setBusy(true);
  showError(elements.githubError, "");
  elements.githubLoginHelp.hidden = false;
  elements.connectGitHubButton.textContent = "等待 GitHub 授权...";
  try {
    const result = await request("/api/desktop/github-login", {
      method: "POST",
      body: JSON.stringify({})
    });
    state.onboarding.github = result.data;
    renderGitHubAccount();
    renderSetupSummary();
  } catch (error) {
    showError(elements.githubError, friendlyError(error.message));
  } finally {
    elements.githubLoginHelp.hidden = true;
    elements.connectGitHubButton.textContent = "使用浏览器连接 GitHub";
    setBusy(false);
  }
}

async function openGitHubDevice() {
  try {
    await request("/api/desktop/open-github-device", {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch (error) {
    showError(elements.githubError, friendlyError(error.message));
  }
}

function renderRoleSelection() {
  document.querySelectorAll(".role-option").forEach((option) => {
    const input = option.querySelector('input[name="computerRole"]');
    option.classList.toggle("selected", input.checked);
  });
}

function renderSetupSummary() {
  const onboarding = state.onboarding || {};
  const github = onboarding.github || {};
  elements.summaryAccount.textContent = github.login ? `@${github.login}` : "未连接";
  elements.summarySkills.textContent = `${Number(onboarding.localSkillCount || 0)} 个`;
  elements.summaryRole.textContent = state.role === "source" ? "使用这台电脑的版本" : "先从其他电脑获取";
}

async function startSimpleSetup() {
  setBusy(true);
  showError(elements.setupError, "");
  elements.setupProgressText.hidden = false;
  elements.startSyncButton.textContent = "正在设置...";
  try {
    await request("/api/desktop/simple-setup", {
      method: "POST",
      body: JSON.stringify({
        role: state.role,
        launchAtLogin: elements.setupLaunchAtLogin.checked,
        installHook: elements.setupInstallHook.checked
      })
    });
    showDashboard();
    await refreshDashboard();
  } catch (error) {
    showError(elements.setupError, friendlyError(error.message));
  } finally {
    elements.setupProgressText.hidden = true;
    elements.startSyncButton.textContent = "开始同步";
    setBusy(false);
  }
}

function showDashboard() {
  elements.loadingView.hidden = true;
  elements.onboardingView.hidden = true;
  elements.dashboardView.hidden = false;
  state.dashboardReady = true;
}

async function refreshDashboard(options = {}) {
  if (!options.quiet) setBusy(true);
  try {
    const [statusResult, desktopResult, onboardingResult] = await Promise.all([
      request("/api/status"),
      request("/api/desktop/status"),
      request("/api/desktop/onboarding")
    ]);
    if (!statusResult.ok || !statusResult.data) {
      state.onboarding = onboardingResult.data;
      showOnboarding();
      return;
    }
    state.status = statusResult.data;
    state.desktop = desktopResult.data;
    state.onboarding = onboardingResult.data;
    renderDashboard();
  } catch (error) {
    if (!options.quiet) {
      showError(elements.desktopError, friendlyError(error.message));
      logResult("刷新", { ok: false, error: error.message });
    }
  } finally {
    if (!options.quiet) setBusy(false);
  }
}

function renderDashboard() {
  renderGitHubAccount();
  renderSyncState();
  renderSkills();
  renderSettings();
  renderAdvancedValues();
}

function renderSyncState() {
  const service = state.desktop && state.desktop.state || {};
  const phase = service.running ? "syncing" : service.phase || "idle";
  const copy = {
    setup: ["还需要完成一次设置", "请重新运行首次设置。", "!"],
    syncing: ["正在同步技能", "正在比较本机和 GitHub 上的最新版本...", "↻"],
    idle: ["技能已是最新版本", service.lastSuccessAt ? `上次同步：${formatDateTime(service.lastSuccessAt)}` : "自动同步已经开启。", "✓"],
    attention: ["有一项内容需要你确认", "检测到两台电脑修改了同一个位置，已暂停自动覆盖。", "!"],
    error: ["这次同步没有完成", service.lastError || "请检查网络后再次同步。", "!"]
  }[phase] || ["正在检查技能", "请稍候...", "↻"];

  elements.syncStatusBand.className = `sync-status-band ${phase}`;
  elements.mainStatusTitle.textContent = copy[0];
  elements.mainStatusText.textContent = copy[1];
  elements.largeStatusIcon.textContent = copy[2];
  elements.headerState.textContent = copy[0];
  elements.syncNowButton.textContent = service.running ? "正在同步..." : "立即同步";
  elements.syncNowButton.disabled = Boolean(service.running || state.busy);
}

function renderSkills() {
  const skills = state.status && state.status.skills || [];
  const counts = { same: 0, different: 0, "local-only": 0, "missing-local": 0 };
  skills.forEach((skill) => {
    counts[skill.state] = (counts[skill.state] || 0) + 1;
  });
  elements.sameCount.textContent = counts.same;
  elements.differentCount.textContent = counts.different;
  elements.localOnlyCount.textContent = counts["local-only"];
  elements.missingLocalCount.textContent = counts["missing-local"];
  elements.skillListSummary.textContent = skills.length ? `共 ${skills.length} 个技能` : "还没有同步技能";

  if (!skills.length) {
    elements.skillsList.innerHTML = '<p class="empty-state">暂无技能</p>';
    return;
  }
  elements.skillsList.innerHTML = skills.map((skill) => {
    const same = skill.state === "same";
    const label = {
      same: "已同步",
      different: "等待合并",
      "local-only": "等待上传",
      "missing-local": "等待下载"
    }[skill.state] || "待检查";
    return `<div class="skill-item"><strong>${escapeHtml(skill.name)}</strong><span class="skill-state${same ? "" : " waiting"}">${label}</span></div>`;
  }).join("");
}

function renderSettings() {
  const desktop = state.desktop || {};
  const settings = desktop.settings || {};
  const service = desktop.state || {};
  elements.autoSyncInput.checked = Boolean(settings.autoSync);
  elements.syncOnStartInput.checked = Boolean(settings.syncOnStart);
  elements.launchAtLoginInput.checked = Boolean(desktop.app && desktop.app.launchAtLogin);
  elements.closeToTrayInput.checked = Boolean(settings.closeToTray);
  elements.syncIntervalInput.value = Number(settings.syncIntervalSeconds || 30);
  elements.autoSyncState.textContent = settings.autoSync ? (service.paused ? "已暂停" : "已开启") : "已关闭";
  elements.autoSyncState.className = `state-pill ${settings.autoSync && !service.paused ? "ok" : "warn"}`;
  showError(elements.desktopError, service.lastError || "");
}

function renderAdvancedValues() {
  const status = state.status || {};
  elements.remoteInput.value = status.remote || "";
  elements.repoInput.value = status.repoDir || "";
  elements.skillsDirInput.value = status.skillsDir || "";
}

async function runSync() {
  setBusy(true);
  try {
    const result = await request("/api/desktop/sync", {
      method: "POST",
      body: JSON.stringify({ trigger: "manual" })
    });
    logResult("立即同步", result);
    await refreshDashboard({ quiet: true });
  } catch (error) {
    showError(elements.desktopError, friendlyError(error.message));
    logResult("立即同步", { ok: false, error: error.message });
  } finally {
    setBusy(false);
    renderSyncState();
  }
}

async function updateSettings(patch) {
  try {
    const result = await request("/api/desktop/settings", {
      method: "POST",
      body: JSON.stringify(patch)
    });
    state.desktop = result.data;
    renderSettings();
  } catch (error) {
    showError(elements.desktopError, friendlyError(error.message));
  }
}

async function saveAdvancedConfiguration() {
  await runRequestWithLog("保存配置", "/api/init", {
    remote: elements.remoteInput.value.trim(),
    repo: elements.repoInput.value.trim(),
    skillsDir: elements.skillsDirInput.value.trim(),
    importExisting: elements.importExistingInput.checked
  });
  await refreshDashboard();
}

async function runAdvancedAction(action) {
  if (action === "doctor") {
    try {
      const result = await request("/api/doctor");
      logResult("检查环境", result);
    } catch (error) {
      logResult("检查环境", { ok: false, error: error.message });
    }
    return;
  }
  const bodies = {
    pull: {},
    import: { prune: true },
    publish: { push: true, message: "从 Codex 技能同步器上传" }
  };
  await runRequestWithLog(action, `/api/${action}`, bodies[action] || {});
  await refreshDashboard();
}

async function runRequestWithLog(label, url, body) {
  setBusy(true);
  try {
    const result = await request(url, { method: "POST", body: JSON.stringify(body || {}) });
    logResult(label, result);
    return result;
  } catch (error) {
    logResult(label, { ok: false, error: error.message });
    throw error;
  } finally {
    setBusy(false);
  }
}

async function installHook() {
  try {
    const result = await request("/api/desktop/install-hook", { method: "POST", body: "{}" });
    logResult("安装 Codex 启动同步", result);
  } catch (error) {
    logResult("安装 Codex 启动同步", { ok: false, error: error.message });
  }
}

async function openPath(kind) {
  try {
    await request("/api/desktop/open-path", {
      method: "POST",
      body: JSON.stringify({ kind })
    });
  } catch (error) {
    showError(elements.desktopError, friendlyError(error.message));
  }
}

async function selectDirectory(kind, input) {
  try {
    const result = await request("/api/desktop/select-directory", {
      method: "POST",
      body: JSON.stringify({ kind })
    });
    if (result.path) input.value = result.path;
  } catch (error) {
    logResult("选择文件夹", { ok: false, error: error.message });
  }
}

function setBusy(busy) {
  state.busy = Boolean(busy);
  document.querySelectorAll("button").forEach((button) => {
    const allowedWhileBusy = button.dataset.allowWhileBusy === "true";
    button.disabled = (!allowedWhileBusy && Boolean(busy)) || button.dataset.permanentlyDisabled === "true";
  });
}

function showError(element, message) {
  const text = String(message || "").trim();
  element.hidden = !text;
  element.textContent = text;
}

function logResult(label, result) {
  elements.commandLine.textContent = label;
  const text = [
    result.ok === false ? "操作未完成" : "操作完成",
    result.error || "",
    result.stderr || "",
    result.stdout || "",
    result.data ? JSON.stringify(result.data, null, 2) : ""
  ].filter(Boolean).join("\n\n");
  elements.logOutput.textContent = text;
}

function friendlyError(message) {
  const text = String(message || "发生了未知问题。");
  if (/failed to authenticate via web browser|dial tcp|i\/o timeout|connection timed out/i.test(text)) {
    return "连接 GitHub 超时。请确认 ClashX 或其他代理软件正在运行，然后关闭并重新打开技能同步器再试。";
  }
  return text
    .replace(/^Error:\s*/i, "")
    .replace(/git@github\.com:/g, "GitHub：")
    .trim();
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}
