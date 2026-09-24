// Starts the AINET server and a free Cloudflare quick tunnel, and keeps both alive.
// Every time the tunnel gets a new random address, it is written to SERVER_URL and .env
// and pushed to GitHub, so agents that resolve the server from
// https://raw.githubusercontent.com/xideownagge/ainet/main/SERVER_URL always find it.
//
//   node scripts/up.mjs        (or double-click start.cmd)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3000;
const CF_CANDIDATES = [
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
  "cloudflared",
];
const CF = CF_CANDIDATES.find((p) => p === "cloudflared" || fs.existsSync(p));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- server ----------
let server;
async function serverAlive() {
  try { const r = await fetch(`http://localhost:${PORT}/api/round`); return r.ok; } catch { return false; }
}
async function startServer() {
  if (await serverAlive()) { log("server already running on port", PORT); return; }
  server = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  server.on("exit", (code) => { log("server exited with code", code, "— restarting in 5 s"); server = null; setTimeout(startServer, 5000); });
  for (let i = 0; i < 20 && !(await serverAlive()); i++) await sleep(500);
  log("server up on http://localhost:" + PORT);
}

// ---------- publish address ----------
function git(...args) { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function publishUrl(url) {
  fs.writeFileSync(path.join(ROOT, "SERVER_URL"), url + "\n");
  const envPath = path.join(ROOT, ".env");
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, "utf8");
    fs.writeFileSync(envPath, /^PUBLIC_URL=.*$/m.test(env) ? env.replace(/^PUBLIC_URL=.*$/m, `PUBLIC_URL=${url}`) : env + `\nPUBLIC_URL=${url}\n`);
  }
  try {
    git("add", "SERVER_URL");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", `Server address: ${url}`, "--", "SERVER_URL");
    git("pull", "-q", "--rebase", "--autostash", "origin", "main");
    git("push", "-q", "origin", "HEAD:main");
    log("published to GitHub:", url);
  } catch (e) {
    log("could not push SERVER_URL (the local server still uses it):", String(e.stderr || e.message).split("\n")[0]);
  }
}

// ---------- tunnel ----------
function startTunnel() {
  const t = spawn(CF, ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"], { cwd: ROOT });
  let published = false;
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !published) {
      published = true;
      log("tunnel:", m[0]);
      // give Cloudflare a few seconds to route before announcing
      setTimeout(async () => {
        for (let i = 0; i < 12; i++) {
          try { if ((await fetch(m[0] + "/api/round")).ok) break; } catch {}
          await sleep(5000);
        }
        publishUrl(m[0]);
      }, 3000);
    }
  };
  t.stdout.on("data", onData);
  t.stderr.on("data", onData);
  t.on("exit", (code) => { log("tunnel exited with code", code, "— restarting in 10 s"); setTimeout(startTunnel, 10_000); });
}

// periodic health check: if the public address stops answering, restart the tunnel process
let checking = false;
setInterval(async () => {
  if (checking) return; checking = true;
  try {
    const url = fs.readFileSync(path.join(ROOT, "SERVER_URL"), "utf8").trim();
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) { try { ok = (await fetch(url + "/api/round", { signal: AbortSignal.timeout(15000) })).ok; } catch {} if (!ok) await sleep(10_000); }
    if (!ok) { log("public address is not answering, restarting tunnel"); execFileSync("taskkill", ["/F", "/IM", "cloudflared.exe"], { stdio: "ignore" }); }
  } catch {} finally { checking = false; }
}, 5 * 60_000);

await startServer();
startTunnel();
log("AINET is starting. Keep this window open. Ctrl+C to stop.");
