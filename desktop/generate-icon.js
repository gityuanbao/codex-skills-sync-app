"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  const svgPath = path.join(__dirname, "..", "build", "icon.svg");
  const pngPath = path.join(__dirname, "..", "build", "icon.png");
  const svg = fs.readFileSync(svgPath, "utf8");
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    frame: false,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      offscreen: true
    }
  });
  const html = `<style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden;background:transparent}img{display:block;width:1024px;height:1024px}</style><img src="${source}">`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const captured = await window.webContents.capturePage();
  const image = captured.resize({ width: 1024, height: 1024, quality: "best" });
  fs.writeFileSync(pngPath, image.toPNG());
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error.message);
  app.exit(1);
});
