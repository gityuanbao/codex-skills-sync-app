"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const UNUSED_PERMISSION_KEYS = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription"
];

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const plistPath = path.join(appPath, "Contents", "Info.plist");

  for (const key of UNUSED_PERMISSION_KEYS) {
    runPlutil(["-remove", key, plistPath], { allowFail: true });
  }
  runPlutil(["-replace", "NSAppTransportSecurity.NSAllowsArbitraryLoads", "-bool", "false", plistPath]);
  const githubCliPath = path.join(appPath, "Contents", "Resources", "vendor", "gh", "gh");
  if (fs.existsSync(githubCliPath)) {
    runCommand("codesign", ["--force", "--sign", "-", githubCliPath]);
  }
  runCommand("codesign", ["--force", "--deep", "--sign", "-", appPath]);
};

function runPlutil(args, options = {}) {
  return runCommand("plutil", args, options);
}

function runCommand(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0 && !options.allowFail) {
    throw new Error((result.stderr || result.stdout || `${command} 执行失败`).trim());
  }
  return result;
}
