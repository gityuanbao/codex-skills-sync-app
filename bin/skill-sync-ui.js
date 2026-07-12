#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(ROOT, "web");
const CLI = path.join(ROOT, "bin", "skill-sync.js");
const DEFAULT_PORT = 17321;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const COMMANDS = {
  status: {
    args: () => ["status", "--json"]
  },
  doctor: {
    args: () => ["doctor", "--json"]
  },
  hook: {
    args: () => ["hook", "--json"]
  },
  init: {
    args: (body) => {
      const args = ["init"];
      if (body.remote) args.push(String(body.remote));
      if (body.repo) args.push("--repo", String(body.repo));
      if (body.skillsDir) args.push("--skills-dir", String(body.skillsDir));
      if (body.branch) args.push("--branch", String(body.branch));
      if (body.importExisting) args.push("--import-existing");
      args.push("--json");
      return args;
    }
  },
  import: {
    args: (body) => ["import", body.prune === false ? "--no-prune" : "--prune", "--json"]
  },
  pull: {
    args: (body) => {
      const args = ["pull"];
      if (body.prune) args.push("--prune");
      if (body.force) args.push("--force");
      args.push("--json");
      return args;
    }
  },
  publish: {
    args: (body) => {
      const args = ["publish"];
      if (body.message) args.push("--message", String(body.message));
      if (body.push === false) args.push("--no-push");
      if (body.pull === false) args.push("--no-pull");
      args.push("--json");
      return args;
    }
  },
  sync: {
    args: (body) => {
      const args = ["sync"];
      if (body.message) args.push("--message", String(body.message));
      if (body.push === false) args.push("--no-push");
      args.push("--json");
      return args;
    }
  },
  link: {
    args: (body) => {
      const args = ["link"];
      if (body.backupExisting) args.push("--backup-existing");
      args.push("--json");
      return args;
    }
  }
};

const READ_COMMANDS = new Set(["status", "doctor", "hook"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const port = Number(args.port || process.env.SKILL_SYNC_UI_PORT || DEFAULT_PORT);
  const host = args.host || process.env.SKILL_SYNC_UI_HOST || "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port >= 65536) {
    throw new Error(`无效端口：${args.port || process.env.SKILL_SYNC_UI_PORT || DEFAULT_PORT}`);
  }

  await startServer({ port, host, log: true });
}

function startServer(options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT);
  const host = options.host || "127.0.0.1";
  const desktopBridge = options.desktopBridge || null;
  const server = http.createServer((request, response) => {
    route(request, response, { desktopBridge }).catch((error) => {
      sendJson(response, 500, {
        ok: false,
        error: error.message
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      if (options.log) {
        console.log(`Codex 技能同步器可视化控制台已启动：${url}`);
      }
      resolve({ server, host, port: actualPort, url });
    });
  });
}

function parseArgs(argv) {
  const parsed = {
    help: false,
    host: "",
    port: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--host") {
      parsed.host = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--port") {
      parsed.port = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (/^\d+$/.test(token) && !parsed.port) {
      parsed.port = token;
      continue;
    }
    throw new Error(`未知选项：${token}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Codex 技能同步器可视化控制台

用法：
  skill-sync-ui [port]
  skill-sync-ui --port 17321 --host 127.0.0.1

环境变量：
  SKILL_SYNC_UI_PORT    覆盖 HTTP 端口。
  SKILL_SYNC_UI_HOST    覆盖 HTTP 主机。
  SKILL_SYNC_CONFIG     转发给 skill-sync 的配置文件。
  SKILL_SYNC_REPO       转发给 skill-sync 的同步仓库路径。
  SKILL_SYNC_SKILLS_DIR 转发给 skill-sync 的技能目录路径。
`);
}

async function route(request, response, context = {}) {
  if (!isLocalRequest(request)) {
    sendJson(response, 403, { ok: false, error: "仅允许本机访问。" });
    return;
  }
  if (request.method !== "GET" && !isTrustedOrigin(request)) {
    sendJson(response, 403, { ok: false, error: "已拒绝跨站请求。" });
    return;
  }

  const url = new URL(request.url, "http://localhost");
  const desktopBridge = context.desktopBridge || null;

  if (request.method === "GET" && url.pathname === "/api/meta") {
    sendJson(response, 200, {
      ok: true,
      root: ROOT,
      cli: CLI,
      node: process.version,
      desktop: Boolean(desktopBridge),
      platform: process.platform,
      env: {
        SKILL_SYNC_CONFIG: process.env.SKILL_SYNC_CONFIG || "",
        SKILL_SYNC_REPO: process.env.SKILL_SYNC_REPO || "",
        SKILL_SYNC_SKILLS_DIR: process.env.SKILL_SYNC_SKILLS_DIR || "",
        CODEX_HOME: process.env.CODEX_HOME || ""
      }
    });
    return;
  }

  if (url.pathname.startsWith("/api/desktop/")) {
    await routeDesktop(request, response, url, desktopBridge);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice("/api/".length);
    if (!COMMANDS[name] || !READ_COMMANDS.has(name)) {
      sendJson(response, 404, { ok: false, error: "未知 API 路由。" });
      return;
    }
    sendJson(response, 200, runSkillSync(COMMANDS[name].args({})));
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice("/api/".length);
    if (!COMMANDS[name]) {
      sendJson(response, 404, { ok: false, error: "未知 API 路由。" });
      return;
    }
    const body = await readJsonBody(request);
    const args = COMMANDS[name].args(body);
    const result = desktopBridge ? await runSkillSyncAsync(args) : runSkillSync(args);
    if (desktopBridge && result.ok && ["init", "link"].includes(name) && desktopBridge.configurationChanged) {
      await desktopBridge.configurationChanged();
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "不允许的请求方法。" });
    return;
  }

  serveStatic(url.pathname, response);
}

async function routeDesktop(request, response, url, desktopBridge) {
  if (!desktopBridge) {
    sendJson(response, 404, { ok: false, error: "当前运行方式不支持桌面功能。" });
    return;
  }

  const action = url.pathname.slice("/api/desktop/".length);
  if (request.method === "GET" && action === "status") {
    sendJson(response, 200, { ok: true, data: await desktopBridge.getStatus() });
    return;
  }
  if (request.method === "GET" && action === "onboarding") {
    sendJson(response, 200, { ok: true, data: await desktopBridge.getOnboardingStatus() });
    return;
  }
  if (request.method === "GET" && action === "github-device-info") {
    sendJson(response, 200, { ok: true, data: await desktopBridge.getGitHubDeviceInfo() });
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "不允许的请求方法。" });
    return;
  }

  const body = await readJsonBody(request);
  if (action === "settings") {
    sendJson(response, 200, { ok: true, data: await desktopBridge.updateSettings(body) });
    return;
  }
  if (action === "sync") {
    const result = await desktopBridge.syncNow(body.trigger || "manual");
    sendJson(response, 200, result);
    return;
  }
  if (action === "github-login") {
    const result = await desktopBridge.connectGitHub();
    sendJson(response, 200, { ok: true, data: result });
    return;
  }
  if (action === "open-github-device") {
    const result = await desktopBridge.openGitHubDevice();
    sendJson(response, 200, { ok: true, data: result });
    return;
  }
  if (action === "github-diagnose") {
    const result = await desktopBridge.diagnoseGitHub();
    sendJson(response, 200, { ok: true, data: result });
    return;
  }
  if (action === "github-reconnect") {
    const result = await desktopBridge.reconnectGitHub();
    sendJson(response, 200, { ok: true, data: result });
    return;
  }
  if (action === "onboarding-start") {
    const result = await desktopBridge.startOnboarding();
    sendJson(response, 200, { ok: true, data: result });
    return;
  }
  if (action === "onboarding-finish") {
    const result = await desktopBridge.finishOnboarding();
    sendJson(response, 200, { ok: true, data: result });
    return;
  }
  if (action === "check-update") {
    const result = await desktopBridge.checkForUpdate();
    sendJson(response, 200, { ok: true, data: result });
    return;
  }
  if (action === "open-release") {
    const result = await desktopBridge.openReleasePage();
    sendJson(response, 200, { ok: true, data: result });
    return;
  }
  if (action === "simple-setup") {
    const result = await desktopBridge.simpleSetup(body);
    sendJson(response, 200, { ok: true, data: result });
    return;
  }
  if (action === "select-directory") {
    const selected = await desktopBridge.selectDirectory(body.kind || "folder");
    sendJson(response, 200, { ok: true, path: selected || "" });
    return;
  }
  if (action === "install-hook") {
    const result = await desktopBridge.installHook();
    sendJson(response, 200, result);
    return;
  }
  if (action === "open-path") {
    const result = await desktopBridge.openPath(body.kind || "skills");
    sendJson(response, 200, { ok: true, data: result || null });
    return;
  }

  sendJson(response, 404, { ok: false, error: "未知桌面 API。" });
}

function runSkillSync(args) {
  const result = childProcess.spawnSync(process.execPath, [CLI, ...args], {
    cwd: commandWorkingDirectory(),
    encoding: "utf8",
    env: childEnvironment(),
    maxBuffer: 1024 * 1024 * 8
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const parsed = parseJson(stdout);

  return {
    ok: result.status === 0,
    status: result.status,
    command: ["node", CLI, ...args],
    data: parsed,
    stdout,
    stderr,
    error: result.error ? result.error.message : stderr.trim()
  };
}

function runSkillSyncAsync(args) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(process.execPath, [CLI, ...args], {
      cwd: commandWorkingDirectory(),
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        status: null,
        command: ["node", CLI, ...args],
        data: null,
        stdout,
        stderr,
        error: error.message
      });
    });
    child.on("close", (status) => {
      resolve({
        ok: status === 0,
        status,
        command: ["node", CLI, ...args],
        data: parseJson(stdout),
        stdout,
        stderr,
        error: stderr.trim()
      });
    });
  });
}

function childEnvironment() {
  const env = { ...process.env };
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

function commandWorkingDirectory() {
  if (process.versions.electron && process.resourcesPath) {
    return process.resourcesPath;
  }
  return ROOT;
}

function parseJson(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function serveStatic(rawPathname, response) {
  const pathname = rawPathname === "/" ? "/index.html" : rawPathname;
  const requested = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(WEB_ROOT, requested);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(WEB_ROOT)) {
    sendText(response, 403, "禁止访问");
    return;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendText(response, 404, "未找到");
    return;
  }

  const ext = path.extname(resolved);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  fs.createReadStream(resolved).pipe(response);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("请求体过大。"));
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("无效的 JSON 请求体。"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendText(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(value);
}

function isLocalRequest(request) {
  const rawHost = String(request.headers.host || "");
  try {
    const hostname = new URL(`http://${rawHost}`).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function isTrustedOrigin(request) {
  const origin = String(request.headers.origin || "");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === request.headers.host
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]");
  } catch {
    return false;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`skill-sync-ui: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runSkillSync,
  runSkillSyncAsync,
  startServer
};
