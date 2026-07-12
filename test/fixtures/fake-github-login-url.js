"use strict";

process.stderr.write([
  "! First copy your one-time code: ABCD-EFGH",
  "Press Enter to open https://github.com/login/device in your browser...",
  ""
].join("\n"));

setTimeout(() => process.exit(0), 30);
