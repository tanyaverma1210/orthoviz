// Opens an existing backend result straight in the viewer and screenshots it.
// Usage: node tests/e2e/smoke-viewer.mjs <result dir> <screenshot.png>
import { _electron as electron } from "playwright-core";
import path from "node:path";

const [resultDir, shot] = process.argv.slice(2);
const appDir = path.resolve(import.meta.dirname, "..", "..");
// VS Code's terminal sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
const app = await electron.launch({ args: [appDir, `--result=${path.resolve(resultDir)}`], cwd: appDir, env });
const page = await app.firstWindow();
const problems = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
await page.waitForSelector('body[data-screen="viewer"]', { timeout: 60_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: shot });
console.log("title:", await page.textContent("#viewer-title"));
console.log(problems.length ? problems.join("\n") : "no console errors");
await app.close();
