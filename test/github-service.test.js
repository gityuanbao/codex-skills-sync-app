"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  RELEASE_PAGE_URL,
  GitHubService,
  cleanGitHubError,
  runProcess,
  sanitizeRepositoryName,
  trustedReleaseUrl,
  withGitHubDeviceCode
} = require("../desktop/github-service");

test("reports an available but signed-out GitHub client", async () => {
  const runner = async (_command, args) => {
    if (args[0] === "--version") return ok("gh version 2.94.0");
    return fail("not logged in");
  };
  const service = new GitHubService({ runner });
  const status = await service.getStatus();
  assert.equal(status.available, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.login, "");
});

test("returns only the GitHub profile fields needed by the UI", async () => {
  const runner = async (_command, args) => {
    if (args[0] === "--version") return ok("gh version 2.94.0");
    if (args[0] === "auth" && args[1] === "status") return ok();
    if (args[0] === "api") {
      return ok(JSON.stringify({
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://example.test/avatar.png",
        private_field: "must not escape"
      }));
    }
    return fail();
  };
  const service = new GitHubService({ runner });
  const status = await service.getStatus();
  assert.deepEqual(status, {
    available: true,
    authenticated: true,
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://example.test/avatar.png",
    version: "gh version 2.94.0",
    error: ""
  });
});

test("uses the browser login flow without accepting a password", async () => {
  let authenticated = false;
  let loginOptions = null;
  const runner = async (_command, args, options) => {
    if (args[0] === "--version") return ok("gh version 2.94.0");
    if (args[0] === "auth" && args[1] === "status") return authenticated ? ok() : fail();
    if (args[0] === "auth" && args[1] === "login") {
      loginOptions = options;
      authenticated = true;
      return ok();
    }
    if (args[0] === "auth" && args[1] === "setup-git") return ok();
    if (args[0] === "api") return ok(JSON.stringify({ login: "octocat" }));
    return fail();
  };
  const service = new GitHubService({ runner });
  const status = await service.login();
  assert.equal(status.authenticated, true);
  assert.equal(loginOptions.interactiveGitHubLogin, true);
  assert.equal(loginOptions.env.LANG, "C");
});

test("automatically confirms only the two GitHub CLI browser prompts", async () => {
  const fixture = path.join(__dirname, "fixtures", "fake-github-login.js");
  const result = await runProcess(process.execPath, [fixture], {
    timeoutMs: 5000,
    interactiveGitHubLogin: true,
    env: { LANG: "C", LC_ALL: "C" }
  });
  assert.equal(result.ok, true);
  assert.match(result.stdout, /Authentication complete/);
});

test("opens the GitHub device page with its one-time code prefilled", async () => {
  const fixture = path.join(__dirname, "fixtures", "fake-github-login-url.js");
  const opened = [];
  const codes = [];
  const result = await runProcess(process.execPath, [fixture], {
    timeoutMs: 5000,
    interactiveGitHubLogin: true,
    openBrowser: async (url) => opened.push(url),
    onDeviceCode: async (code) => codes.push(code),
    env: { LANG: "C", LC_ALL: "C" }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(codes, ["ABCD-EFGH"]);
  assert.deepEqual(opened, ["https://github.com/login/device?user_code=ABCD-EFGH"]);
});

test("only adds a device code to the official GitHub device page", () => {
  assert.equal(
    withGitHubDeviceCode("https://github.com/login/device", "ABCD-EFGH"),
    "https://github.com/login/device?user_code=ABCD-EFGH"
  );
  assert.equal(
    withGitHubDeviceCode("https://example.test/login/device", "ABCD-EFGH"),
    "https://github.com/login/device"
  );
});

test("redacts a one-time code from GitHub errors", () => {
  const message = cleanGitHubError(fail("One-time code (ABCD-EFGH) was not accepted"));
  assert.doesNotMatch(message, /ABCD-EFGH/);
  assert.match(message, /一次性授权码/);
});

test("logs out the active GitHub account without touching repositories", async () => {
  const calls = [];
  let loggedOut = false;
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "--version") return ok("gh version 2.94.0");
    if (args[0] === "auth" && args[1] === "status" && args.includes("--json")) {
      return ok(JSON.stringify({
        hosts: { "github.com": [{ login: "octocat", active: true }] }
      }));
    }
    if (args[0] === "auth" && args[1] === "logout") {
      loggedOut = true;
      return ok();
    }
    if (args[0] === "auth" && args[1] === "status") {
      return loggedOut ? fail("not logged in") : ok();
    }
    return fail();
  };
  const service = new GitHubService({ runner });
  const status = await service.logout();
  assert.equal(status.authenticated, false);
  assert.deepEqual(
    calls.find((args) => args[0] === "auth" && args[1] === "logout"),
    ["auth", "logout", "--hostname", "github.com", "--user", "octocat"]
  );
  assert.equal(calls.some((args) => args[0] === "repo"), false);
});

test("diagnoses a GitHub timeout and reports the active proxy", async () => {
  let command = null;
  let args = null;
  const service = new GitHubService({
    gitExecutable: "test-git",
    prepareNetwork: async () => ({ url: "http://127.0.0.1:7890", source: "local" }),
    networkRunner: async (nextCommand, nextArgs) => {
      command = nextCommand;
      args = nextArgs;
      return fail("dial tcp: i/o timeout");
    }
  });
  const result = await service.diagnoseNetwork();
  assert.equal(command, "test-git");
  assert.deepEqual(args, [
    "ls-remote",
    "--exit-code",
    "https://github.com/cli/cli.git",
    "HEAD"
  ]);
  assert.equal(result.online, false);
  assert.equal(result.viaProxy, true);
  assert.equal(result.proxySource, "local");
  assert.match(result.message, /超时/);
});

test("reads the latest release and rejects untrusted release links", async () => {
  const runner = async (_command, args) => {
    if (args[0] !== "api") return fail();
    return ok(JSON.stringify({
      tag_name: "v0.3.4",
      name: "Codex 技能同步器 v0.3.4",
      published_at: "2026-07-12T00:00:00Z",
      html_url: "https://github.com/gityuanbao/codex-skills-sync-app/releases/tag/v0.3.4"
    }));
  };
  const service = new GitHubService({ runner });
  const release = await service.getLatestRelease();
  assert.equal(release.version, "0.3.4");
  assert.equal(release.url, "https://github.com/gityuanbao/codex-skills-sync-app/releases/tag/v0.3.4");
  assert.equal(trustedReleaseUrl("https://example.test/releases/v9"), RELEASE_PAGE_URL);
});

test("reuses an existing private repository", async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "--version") return ok("gh version 2.94.0");
    if (args[0] === "auth") return ok();
    if (args[0] === "api") return ok(JSON.stringify({ login: "dorian" }));
    if (args[0] === "repo" && args[1] === "view") {
      return ok(JSON.stringify({
        nameWithOwner: "dorian/codex-skill-sync",
        url: "https://github.com/dorian/codex-skill-sync",
        isPrivate: true
      }));
    }
    return fail();
  };
  const service = new GitHubService({ runner });
  const repository = await service.ensurePrivateRepository();
  assert.equal(repository.cloneUrl, "https://github.com/dorian/codex-skill-sync.git");
  assert.equal(calls.some((args) => args[1] === "create"), false);
});

test("creates a private repository when one does not exist", async () => {
  let views = 0;
  const runner = async (_command, args) => {
    if (args[0] === "--version") return ok("gh version 2.94.0");
    if (args[0] === "auth") return ok();
    if (args[0] === "api") return ok(JSON.stringify({ login: "dorian" }));
    if (args[0] === "repo" && args[1] === "view") {
      views += 1;
      if (views === 1) return fail("not found");
      return ok(JSON.stringify({
        nameWithOwner: "dorian/codex-skill-sync",
        url: "https://github.com/dorian/codex-skill-sync",
        isPrivate: true
      }));
    }
    if (args[0] === "repo" && args[1] === "create") return ok();
    return fail();
  };
  const service = new GitHubService({ runner });
  const repository = await service.ensurePrivateRepository();
  assert.equal(repository.isPrivate, true);
  assert.equal(repository.nameWithOwner, "dorian/codex-skill-sync");
});

test("sanitizes repository names", () => {
  assert.equal(sanitizeRepositoryName("  my skills / 2026  "), "my-skills-2026");
});

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "", error: "" };
}

function fail(stderr = "failed") {
  return { ok: false, status: 1, stdout: "", stderr, error: "" };
}
