"use strict";

process.stdin.setEncoding("utf8");
let input = "";

process.stderr.write("? Authenticate Git with your GitHub credentials? ");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split(/\r?\n/);
  if (lines.length < 2) return;
  if (!process.env.SECOND_PROMPT_SHOWN) {
    process.env.SECOND_PROMPT_SHOWN = "1";
    input = lines.slice(1).join("\n");
    process.stderr.write("\nPress Enter to open https://github.com/login/device in your browser... ");
    return;
  }
  process.stdout.write("Authentication complete.\n");
  process.exit(0);
});
