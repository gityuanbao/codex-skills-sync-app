"use strict";

const path = require("path");
const source = require("../package.json").build;

const config = JSON.parse(JSON.stringify(source));
delete config.electronDist;

if (process.env.ELECTRON_WIN_DIST) {
  config.electronDist = path.resolve(process.env.ELECTRON_WIN_DIST);
} else if (process.platform === "win32") {
  config.electronDist = path.join(__dirname, "..", "node_modules", "electron", "dist");
}

module.exports = config;
