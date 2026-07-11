"use strict";

process.stderr.write([
  "! One-time code (ABCD-EFGH) copied to clipboard",
  "Open this URL to continue in your web browser: https://github.com/login/device",
  ""
].join("\n"));

setTimeout(() => process.exit(0), 30);
