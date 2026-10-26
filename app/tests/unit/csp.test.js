const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

test("the CSP pins the hash of the inline import map", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "src", "renderer", "index.html"), "utf8");
  const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
  const hash = crypto.createHash("sha256").update(importMap).digest("base64");
  assert.ok(html.includes(`'sha256-${hash}'`), `update the CSP in index.html to 'sha256-${hash}'`);
});
