"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const DEFAULT_REPOSITORY_NAME = "codex-skill-sync";
const GITHUB_DEVICE_URL = "https://github.com/login/device";
const SOURCE_REPOSITORY = "gityuanbao/codex-skills-sync-app";
const RELEASE_PAGE_URL = `https://github.com/${SOURCE_REPOSITORY}/releases/latest`;

class GitHubService {
  constructor(options = {}) {
    this.resourcesPath = options.resourcesPath || "";
    this.appPath = options.appPath || path.resolve(__dirname, "..");
    this.isPackaged = Boolean(options.isPackaged);
    this.platform = options.platform || process.platform;
    this.runner = options.runner || runProcess;
    this.networkRunner = options.networkRunner || runProcess;
    this.gitExecutable = options.gitExecutable || "git";
    this.prepareNetwork = options.prepareNetwork || (async () => null);
    this.openExternal = options.openExternal || (async () => null);
    this.pendingDeviceUrl = GITHUB_DEVICE_URL;
    this.pendingDeviceCode = "";
  }

  async getStatus() {
    await this.prepareNetwork();
    const executable = this.resolveExecutable();
    const versionResult = await this.runner(executable, ["--version"], { timeoutMs: 10000 });
    if (!versionResult.ok) {
      return {
        available: false,
        authenticated: false,
        login: "",
        name: "",
        avatarUrl: "",
        version: "",
        error: "GitHub 登录组件不可用。请重新安装最新版技能同步器。"
      };
    }

    const authResult = await this.runner(executable, [
      "auth",
      "status",
      "--hostname",
      "github.com"
    ], { timeoutMs: 15000 });
    if (!authResult.ok) {
      const networkError = githubNetworkError(authResult);
      return {
        available: true,
        authenticated: false,
        login: "",
        name: "",
        avatarUrl: "",
        version: firstLine(versionResult.stdout),
        error: networkError
      };
    }

    const userResult = await this.runner(executable, ["api", "user"], { timeoutMs: 15000 });
    const user = parseJson(userResult.stdout) || {};
    return {
      available: true,
      authenticated: userResult.ok,
      login: String(user.login || ""),
      name: String(user.name || ""),
      avatarUrl: String(user.avatar_url || ""),
      version: firstLine(versionResult.stdout),
      error: userResult.ok ? "" : "GitHub 授权已失效，请重新连接。"
    };
  }

  async login() {
    const executable = this.resolveExecutable();
    const available = await this.runner(executable, ["--version"], { timeoutMs: 10000 });
    if (!available.ok) {
      throw new Error("GitHub 登录组件不可用。请重新安装最新版技能同步器。");
    }

    const existing = await this.getStatus();
    if (!existing.authenticated) {
      this.pendingDeviceUrl = GITHUB_DEVICE_URL;
      this.pendingDeviceCode = "";
      let result;
      try {
        result = await this.runner(executable, [
          "auth",
          "login",
          "--hostname",
          "github.com",
          "--git-protocol",
          "https",
          "--web",
          "--clipboard"
        ], {
          timeoutMs: 15 * 60 * 1000,
          interactiveGitHubLogin: true,
          onDeviceCode: (code) => {
            this.pendingDeviceCode = code;
          },
          openBrowser: async (url) => {
            this.pendingDeviceUrl = normalizeGitHubDeviceUrl(url);
            await this.openExternal(this.pendingDeviceUrl);
          },
          env: { LANG: "C", LC_ALL: "C" }
        });
      } finally {
        this.pendingDeviceUrl = GITHUB_DEVICE_URL;
        this.pendingDeviceCode = "";
      }
      if (!result.ok) {
        throw new Error(cleanGitHubError(result) || "没有完成 GitHub 授权，请重试。");
      }
    }

    await this.configureGitCredentials();
    const status = await this.getStatus();
    if (!status.authenticated) {
      throw new Error(status.error || "GitHub 授权没有完成，请重试。");
    }
    return status;
  }

  async openPendingDevicePage() {
    await this.openExternal(this.pendingDeviceUrl);
    return true;
  }

  getPendingDeviceInfo() {
    return {
      active: Boolean(this.pendingDeviceCode),
      code: this.pendingDeviceCode,
      url: this.pendingDeviceUrl
    };
  }

  async logout() {
    const executable = this.resolveExecutable();
    const login = await this.getConfiguredLogin();
    if (!login) return this.getStatus();

    const result = await this.runner(executable, [
      "auth",
      "logout",
      "--hostname",
      "github.com",
      "--user",
      login
    ], { timeoutMs: 30000 });
    if (!result.ok) {
      throw new Error(cleanGitHubError(result) || "无法退出这台电脑上的 GitHub 账号。");
    }
    this.pendingDeviceUrl = GITHUB_DEVICE_URL;
    this.pendingDeviceCode = "";
    return this.getStatus();
  }

  async getConfiguredLogin() {
    const executable = this.resolveExecutable();
    const result = await this.runner(executable, [
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--json",
      "hosts"
    ], { timeoutMs: 15000 });
    const parsed = parseJson(result.stdout) || {};
    const accounts = parsed.hosts && parsed.hosts["github.com"];
    if (!Array.isArray(accounts)) return "";
    const active = accounts.find((account) => account && account.active) || accounts[0] || {};
    return String(active.login || "");
  }

  async diagnoseNetwork() {
    const startedAt = Date.now();
    const proxy = await this.prepareNetwork();
    const result = await this.networkRunner(this.gitExecutable, [
      "ls-remote",
      "--exit-code",
      "https://github.com/cli/cli.git",
      "HEAD"
    ], {
      timeoutMs: 20000,
      env: { GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" }
    });
    const latencyMs = Date.now() - startedAt;
    return {
      online: Boolean(result.ok),
      latencyMs,
      viaProxy: Boolean(proxy && proxy.url),
      proxySource: proxy && proxy.source || "",
      message: result.ok ? "GitHub 连接正常。" : githubNetworkError(result) || "无法连接 GitHub，请检查网络或代理后重试。"
    };
  }

  async getLatestRelease() {
    await this.prepareNetwork();
    const executable = this.resolveExecutable();
    const result = await this.runner(executable, [
      "api",
      `repos/${SOURCE_REPOSITORY}/releases/latest`
    ], { timeoutMs: 20000 });
    if (!result.ok) {
      throw new Error(githubNetworkError(result) || cleanGitHubError(result) || "无法检查最新版本。");
    }
    const release = parseJson(result.stdout) || {};
    const tagName = String(release.tag_name || "");
    return {
      version: tagName.replace(/^v/i, ""),
      tagName,
      name: String(release.name || tagName),
      publishedAt: String(release.published_at || ""),
      url: trustedReleaseUrl(release.html_url)
    };
  }

  async configureGitCredentials() {
    const executable = this.resolveExecutable();
    const result = await this.runner(executable, [
      "auth",
      "setup-git",
      "--hostname",
      "github.com"
    ], { timeoutMs: 30000 });
    if (!result.ok) {
      throw new Error(cleanGitHubError(result) || "无法为 Git 配置 GitHub 授权。");
    }
    return true;
  }

  async ensurePrivateRepository(preferredName = DEFAULT_REPOSITORY_NAME) {
    const status = await this.getStatus();
    if (!status.authenticated || !status.login) {
      throw new Error("请先连接 GitHub。");
    }

    const executable = this.resolveExecutable();
    const baseName = sanitizeRepositoryName(preferredName) || DEFAULT_REPOSITORY_NAME;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const name = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
      const ownerAndName = `${status.login}/${name}`;
      const view = await this.runner(executable, [
        "repo",
        "view",
        ownerAndName,
        "--json",
        "nameWithOwner,url,isPrivate"
      ], { timeoutMs: 20000 });

      if (view.ok) {
        const repository = parseJson(view.stdout) || {};
        if (repository.isPrivate) return normalizeRepository(repository);
        continue;
      }

      const created = await this.runner(executable, [
        "repo",
        "create",
        ownerAndName,
        "--private",
        "--description",
        "由 Agent Skills 同步器自动创建的私人技能仓库"
      ], { timeoutMs: 60000 });
      if (!created.ok) {
        if (/already exists|name already exists|已存在/i.test(`${created.stderr}\n${created.stdout}`)) {
          continue;
        }
        throw new Error(cleanGitHubError(created) || "无法创建 GitHub 私有仓库。");
      }

      const confirmed = await this.runner(executable, [
        "repo",
        "view",
        ownerAndName,
        "--json",
        "nameWithOwner,url,isPrivate"
      ], { timeoutMs: 20000 });
      const repository = parseJson(confirmed.stdout) || {
        nameWithOwner: ownerAndName,
        url: `https://github.com/${ownerAndName}`,
        isPrivate: true
      };
      return normalizeRepository(repository);
    }

    throw new Error("没有找到可用的私人仓库名称，请稍后重试。");
  }

  resolveExecutable() {
    const filename = this.platform === "win32" ? "gh.exe" : "gh";
    const packaged = path.join(this.resourcesPath || "", "vendor", "gh", filename);
    const development = path.join(
      this.appPath,
      "vendor",
      "gh",
      `${this.platform}-${process.arch}`,
      filename
    );
    if (this.isPackaged && fs.existsSync(packaged)) return packaged;
    if (fs.existsSync(development)) return development;
    return filename;
  }
}

function normalizeRepository(repository) {
  const url = String(repository.url || "").replace(/\/$/, "");
  return {
    nameWithOwner: String(repository.nameWithOwner || ""),
    url,
    cloneUrl: url ? `${url}.git` : "",
    isPrivate: Boolean(repository.isPrivate)
  };
}

function sanitizeRepositoryName(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function cleanGitHubError(result) {
  return String(result.stderr || result.stdout || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[一次性授权码]")
    .replace(/^.*?error:\s*/i, "")
    .trim();
}

function githubNetworkError(result) {
  const text = String(result && (result.stderr || result.stdout || result.error) || "")
    .replace(/\x1b\[[0-9;]*m/g, "");
  if (/timed? out|timeout|i\/o timeout/i.test(text)) {
    return "连接 GitHub 超时，请确认网络或代理软件正在运行。";
  }
  if (/could not resolve host|no such host|name resolution/i.test(text)) {
    return "无法解析 GitHub 地址，请检查 DNS 或网络设置。";
  }
  if (/connection refused|failed to connect|network is unreachable|connection reset/i.test(text)) {
    return "无法连接 GitHub，请检查网络或代理设置。";
  }
  return "";
}

function trustedReleaseUrl(value) {
  try {
    const url = new URL(String(value || RELEASE_PAGE_URL));
    if (url.protocol !== "https:" || url.hostname !== "github.com") return RELEASE_PAGE_URL;
    if (!url.pathname.startsWith(`/${SOURCE_REPOSITORY}/releases/`)) return RELEASE_PAGE_URL;
    return url.toString();
  } catch {
    return RELEASE_PAGE_URL;
  }
}

function normalizeGitHubDeviceUrl(value) {
  const url = parseGitHubDeviceUrl(value);
  return url ? url.toString() : GITHUB_DEVICE_URL;
}

function parseGitHubDeviceUrl(value) {
  try {
    const url = new URL(String(value || GITHUB_DEVICE_URL));
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== "/login/device") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function withGitHubDeviceCode(value, userCode) {
  const url = parseGitHubDeviceUrl(value);
  if (!url) return GITHUB_DEVICE_URL;
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(userCode || ""))) return url.toString();
  url.searchParams.set("user_code", userCode);
  return url.toString();
}

function firstLine(value) {
  return String(value || "").trim().split(/\r?\n/)[0] || "";
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    return null;
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let promptBuffer = "";
    let confirmedGitCredentials = false;
    let confirmedBrowserOpen = false;
    let openedBrowserUrl = false;
    let deviceUserCode = "";
    let reportedDeviceCode = "";
    const child = childProcess.spawn(command, args, {
      env: { ...process.env, ...(options.env || {}) },
      stdio: [options.interactiveGitHubLogin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const timeoutMs = Number(options.timeoutMs || 30000);
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      finish({ ok: false, status: null, stdout, stderr, error: "操作超时。" });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      answerGitHubPrompts(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      answerGitHubPrompts(chunk);
    });
    child.on("error", (error) => {
      finish({ ok: false, status: null, stdout, stderr, error: error.message });
    });
    child.on("close", (status) => {
      finish({ ok: status === 0, status, stdout, stderr, error: "" });
    });

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    function answerGitHubPrompts(chunk) {
      if (!options.interactiveGitHubLogin || !child.stdin || child.stdin.destroyed) return;
      promptBuffer = `${promptBuffer}${chunk}`.slice(-3000);
      const normalizedPrompt = promptBuffer.replace(/\x1b\[[0-9;]*m/g, "");
      if (!confirmedGitCredentials && /Authenticate Git with your GitHub credentials\?/i.test(normalizedPrompt)) {
        confirmedGitCredentials = true;
        child.stdin.write("Y\n");
      }
      if (!confirmedBrowserOpen && /Press Enter to open .*github\.com/i.test(normalizedPrompt)) {
        confirmedBrowserOpen = true;
        child.stdin.write("\n");
      }
      const codeMatch = /(?:copy your\s+)?one-time code(?:\s*\(|\s*:\s*|\s+)([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(normalizedPrompt);
      if (codeMatch) {
        deviceUserCode = codeMatch[1].toUpperCase();
        if (reportedDeviceCode !== deviceUserCode) {
          reportedDeviceCode = deviceUserCode;
          Promise.resolve(options.onDeviceCode && options.onDeviceCode(deviceUserCode)).catch(() => {});
        }
      }
      const urlMatch = /(https:\/\/github\.com\/login\/device)\b/i.exec(normalizedPrompt);
      if (!openedBrowserUrl && urlMatch) {
        openedBrowserUrl = true;
        const deviceUrl = withGitHubDeviceCode(urlMatch[1], deviceUserCode);
        Promise.resolve(options.openBrowser && options.openBrowser(deviceUrl)).catch(() => {});
      }
    }
  });
}

module.exports = {
  DEFAULT_REPOSITORY_NAME,
  GITHUB_DEVICE_URL,
  RELEASE_PAGE_URL,
  SOURCE_REPOSITORY,
  GitHubService,
  cleanGitHubError,
  githubNetworkError,
  runProcess,
  sanitizeRepositoryName,
  trustedReleaseUrl,
  withGitHubDeviceCode
};
