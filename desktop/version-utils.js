"use strict";

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function versionParts(value) {
  const match = String(value || "").trim().match(/^(?:v)?(\d+(?:\.\d+)*)/i);
  if (!match) return [0];
  return match[1].split(".").map((part) => Number(part) || 0);
}

module.exports = {
  compareVersions,
  versionParts
};
