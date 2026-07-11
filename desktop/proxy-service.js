"use strict";

const net = require("net");

const LOCAL_HTTP_PROXY_PORTS = [7890, 7897, 10809, 6152];

async function detectNetworkProxy(options = {}) {
  const environment = options.environment || process.env;
  const configured = proxyFromEnvironment(environment);
  if (configured) return { url: configured, source: "environment" };

  if (typeof options.resolveSystemProxy === "function") {
    try {
      const rules = await options.resolveSystemProxy("https://github.com");
      const systemProxy = proxyFromSystemRules(rules);
      if (systemProxy) return { url: systemProxy, source: "system" };
    } catch {
      // Continue with the local proxy check.
    }
  }

  const probe = options.probe || probeHttpProxy;
  const candidates = options.candidates || LOCAL_HTTP_PROXY_PORTS.map((port) => `http://127.0.0.1:${port}`);
  for (const candidate of candidates) {
    if (await probe(candidate)) return { url: candidate, source: "local" };
  }
  return null;
}

function applyProxyEnvironment(proxy, environment = process.env) {
  if (!proxy || !proxy.url) return environment;
  const url = normalizeProxyUrl(proxy.url);
  if (!url) return environment;

  if (!environment.HTTPS_PROXY && !environment.https_proxy) {
    environment.HTTPS_PROXY = url;
    environment.https_proxy = url;
  }
  if (!environment.HTTP_PROXY && !environment.http_proxy) {
    environment.HTTP_PROXY = url;
    environment.http_proxy = url;
  }
  const noProxy = String(environment.NO_PROXY || environment.no_proxy || "");
  const entries = new Set(noProxy.split(",").map((item) => item.trim()).filter(Boolean));
  entries.add("127.0.0.1");
  entries.add("localhost");
  environment.NO_PROXY = Array.from(entries).join(",");
  environment.no_proxy = environment.NO_PROXY;
  return environment;
}

function proxyFromEnvironment(environment = process.env) {
  const value = environment.HTTPS_PROXY
    || environment.https_proxy
    || environment.ALL_PROXY
    || environment.all_proxy
    || environment.HTTP_PROXY
    || environment.http_proxy
    || "";
  return normalizeProxyUrl(value);
}

function proxyFromSystemRules(value) {
  const rules = String(value || "").split(";").map((item) => item.trim()).filter(Boolean);
  for (const rule of rules) {
    const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^\s]+)$/i.exec(rule);
    if (!match) continue;
    const scheme = /^SOCKS/i.test(match[1]) ? "socks5" : match[1].toUpperCase() === "HTTPS" ? "https" : "http";
    const normalized = normalizeProxyUrl(`${scheme}://${match[2]}`);
    if (normalized) return normalized;
  }
  return "";
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const parsed = new URL(withScheme);
    if (!["http:", "https:", "socks:", "socks5:"].includes(parsed.protocol)) return "";
    if (!parsed.hostname || !parsed.port) return "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function probeHttpProxy(proxyUrl, options = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(proxyUrl);
    const socket = net.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port)
    });
    let settled = false;
    let response = "";
    const timeout = setTimeout(() => finish(false), Number(options.timeoutMs || 1800));

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write([
        "CONNECT github.com:443 HTTP/1.1",
        "Host: github.com:443",
        "Proxy-Connection: close",
        "",
        ""
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (!response.includes("\r\n")) return;
      finish(/^HTTP\/1\.[01] 200\b/i.test(response));
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(/^HTTP\/1\.[01] 200\b/i.test(response)));

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(Boolean(result));
    }
  });
}

module.exports = {
  LOCAL_HTTP_PROXY_PORTS,
  applyProxyEnvironment,
  detectNetworkProxy,
  normalizeProxyUrl,
  probeHttpProxy,
  proxyFromEnvironment,
  proxyFromSystemRules
};
