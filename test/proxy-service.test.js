"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyProxyEnvironment,
  detectNetworkProxy,
  normalizeProxyUrl,
  proxyFromEnvironment,
  proxyFromSystemRules
} = require("../desktop/proxy-service");

test("uses an explicitly configured HTTPS proxy first", async () => {
  const proxy = await detectNetworkProxy({
    environment: { HTTPS_PROXY: "http://127.0.0.1:9000" },
    resolveSystemProxy: async () => "PROXY 127.0.0.1:7890",
    probe: async () => true
  });
  assert.deepEqual(proxy, { url: "http://127.0.0.1:9000", source: "environment" });
});

test("understands Chromium system proxy rules", () => {
  assert.equal(proxyFromSystemRules("PROXY 127.0.0.1:7890; DIRECT"), "http://127.0.0.1:7890");
  assert.equal(proxyFromSystemRules("SOCKS5 127.0.0.1:7891; DIRECT"), "socks5://127.0.0.1:7891");
  assert.equal(proxyFromSystemRules("DIRECT"), "");
});

test("finds a working local HTTP proxy when system settings are empty", async () => {
  const checked = [];
  const proxy = await detectNetworkProxy({
    environment: {},
    resolveSystemProxy: async () => "DIRECT",
    candidates: ["http://127.0.0.1:7890", "http://127.0.0.1:7897"],
    probe: async (candidate) => {
      checked.push(candidate);
      return candidate.endsWith(":7897");
    }
  });
  assert.deepEqual(checked, ["http://127.0.0.1:7890", "http://127.0.0.1:7897"]);
  assert.deepEqual(proxy, { url: "http://127.0.0.1:7897", source: "local" });
});

test("applies a detected proxy without replacing an explicit one", () => {
  const environment = { HTTPS_PROXY: "http://company.proxy:8080" };
  applyProxyEnvironment({ url: "http://127.0.0.1:7890" }, environment);
  assert.equal(environment.HTTPS_PROXY, "http://company.proxy:8080");
  assert.equal(environment.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.match(environment.NO_PROXY, /127\.0\.0\.1/);
  assert.match(environment.NO_PROXY, /localhost/);
});

test("normalizes proxy values and rejects unsupported schemes", () => {
  assert.equal(proxyFromEnvironment({ https_proxy: "127.0.0.1:7890" }), "http://127.0.0.1:7890");
  assert.equal(normalizeProxyUrl("javascript://127.0.0.1:7890"), "");
});
