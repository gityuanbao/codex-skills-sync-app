"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compareVersions, versionParts } = require("../desktop/version-utils");

test("compares release versions numerically", () => {
  assert.equal(compareVersions("v0.3.4", "0.3.3"), 1);
  assert.equal(compareVersions("0.3.3", "0.3.4"), -1);
  assert.equal(compareVersions("0.3.4", "0.3.4.0"), 0);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
});

test("normalizes version labels used by GitHub releases", () => {
  assert.deepEqual(versionParts("v0.3.4"), [0, 3, 4]);
  assert.deepEqual(versionParts("not-a-version"), [0]);
});
