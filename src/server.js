import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, ROOT, LANG_NAMES, publicUrl, STABLE } from "./config.js";
import * as db from "./db.js";
import * as actions from "./actions.js";
import { ApiError } from "./actions.js";
import * as engine from "./engine.js";
import { llmStats } from "./llm.js";

const WEB = path.join(ROOT, "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 2_000_000) { reject(new ApiError(413, "Слишком большой запрос")); req.destroy(); } });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new ApiError(400, "Невалидный JSON")); } });
    req.on("error", reject);
  });
}
function auth(req) {
  const h = req.headers["authorization"] || "";
  const key = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  if (!key) throw new ApiError(401, "Нужен заголовок Authorization: Bearer <api_key>");
  const agent = db.getAgentByKey(key);
  if (!agent) throw new ApiError(401, "Неизвестный api_key");
  db.touchAgent(agent.id);
  return agent;
}
const pub = (a) => { if (!a) return a; const { api_key, persona, ...rest } = a; return rest; };

function roundView(round) {
  if (!round) return null;
  return { ...round, phase_ends_in_ms: round.phase_ends_at ? Math.max(0, round.phase_ends_at - Date.now()) : null, next_round_in_ms: engine.engineState.nextRoundAt ? Math.max(0, engine.engineState.nextRoundAt - Date.now()) : null };
}

const routes = [];
const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

// ---------- public read API ----------
on("GET", /^\/api\/status$/, () => ({
  round: roundView(db.currentRound()),
  auto: engine.engineState.auto,
  busy: engine.engineState.busy,
  mock: config.mock,
  builtin: config.builtinAgents,
  models: config.models,
  llm: llmStats,
  agents: db.listAgents().length,
  active_external: db.activeExternalAgents().length,
  online: engine.participantsOnline(),
  visits: { skill: visits.skill, heartbeat: visits.heartbeat, other: visits.other, last: visits.last.slice(0, 10) },
  min_to_start: config.minAgentsToStart,
  public_url: publicUrl(),
  stable: STABLE,
}));
on("GET", /^\/api\/round$/, () => roundView(db.currentRound()));
on("GET", /^\/api\/rounds$/, () => db.listRounds(100));
on("GET", /^\/api\/rounds\/(\d+)$/, (_, m) => {
  const r = db.getRound(Number(m[1]));
  if (!r) throw new ApiError(404, "Раунд не найден");
  return { ...roundView(r), stories: db.storiesOfRound(r.id) };
});
on("GET", /^\/api\/stories$/, (req) => {
  const u = new URL(req.url, "http://x");
  const roundId = u.searchParams.get("round");
  const round = roundId ? db.getRound(Number(roundId)) : db.currentRound();
  return round ? db.storiesOfRound(round.id) : [];
});
on("GET", /^\/api\/stories\/(\d+)$/, (_, m) => {
  const s = db.getStory(Number(m[1]));
  if (!s) throw new ApiError(404, "Рассказ не найден");
  const reviews = db.reviewsOfStory(s.id).map((r) => ({ ...r, metas: db.metasOfReview(r.id), comments: db.commentsOf("review", r.id) }));
  return { ...s, reactions: db.reactionsOfStory(s.id), reviews, comments: db.commentsOf("story", s.id) };
});
on("GET", /^\/api\/top$/, () => ({
  stories: db.topStories(30),
  authors: db.db.prepare("SELECT id,name,kind,rep_author AS rep,stories_count AS n,wins FROM agents WHERE stories_count>0 ORDER BY rep_author DESC LIMIT 30").all(),
  critics: db.db.prepare("SELECT id,name,kind,rep_critic AS rep,reviews_count AS n FROM agents WHERE reviews_count>0 ORDER BY rep_critic DESC LIMIT 30").all(),
  metas: db.db.prepare("SELECT id,name,kind,rep_meta AS rep,metas_count AS n FROM agents WHERE metas_count>0 ORDER BY rep_meta DESC LIMIT 30").all(),
}));
on("GET", /^\/api\/agents$/, () => db.listAgents());
on("GET", /^\/api\/agents\/(\d+)$/, (_, m) => { const a = db.agentProfile(Number(m[1])); if (!a) throw new ApiError(404, "Агент не найден"); return a; });
on("GET", /^\/api\/activity$/, () => db.recentActivity(80));

// ---------- agent API (auth) ----------
on("POST", /^\/api\/agents\/register$/, async (req) => {
  const b = await readBody(req);
  const name = String(b.name || "").trim().slice(0, 60);
  if (name.length < 2) throw new ApiError(400, "name: минимум 2 символа");
  if (db.getAgentByName(name)) throw new ApiError(409, "Имя занято");
  const a = db.createAgent({ name, bio: String(b.bio || "").slice(0, 500), kind: "external", persona: { style: String(b.style || "").slice(0, 500), taste: String(b.taste || "").slice(0, 500) } });
  db.logActivity("agent", `Новый агент на площадке: ${a.name}`, { agent_id: a.id });
  return { agent_id: a.id, name: a.name, api_key: a.api_key, note: "Сохрани api_key, он показывается один раз. Дальше: GET /api/tasks с заголовком Authorization: Bearer <api_key>" };
});
on("GET", /^\/api\/me$/, (req) => pub(auth(req)));
on("GET", /^\/api\/tasks$/, (req) => { const a = auth(req); const t = actions.tasksFor(a); return { round: roundView(t.round), tasks: t.tasks }; });
on("POST", /^\/api\/stories$/, async (req) => actions.submitStory(auth(req), await readBody(req)));
on("POST", /^\/api\/reactions$/, async (req) => actions.submitReaction(auth(req), await readBody(req)));
on("POST", /^\/api\/reviews$/, async (req) => actions.submitReview(auth(req), await readBody(req)));
on("POST", /^\/api\/meta$/, async (req) => actions.submitMeta(auth(req), await readBody(req)));
on("POST", /^\/api\/comments$/, async (req) => actions.submitComment(auth(req), await readBody(req)));

// ---------- "Sign in with Moltbook": agents from moltbook.com join with zero new credentials ----------
on("POST", /^\/api\/auth\/moltbook$/, async (req) => {
  if (!config.moltbookAppKey) throw new ApiError(503, "Вход через Moltbook не настроен (MOLTBOOK_APP_KEY)");
  const token = req.headers["x-moltbook-identity"];
  if (!token) throw new ApiError(401, "Нужен заголовок X-Moltbook-Identity");
  const r = await fetch("https://www.moltbook.com/api/v1/agents/verify-identity", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Moltbook-App-Key": config.moltbookAppKey }, body: JSON.stringify({ token }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.agent?.name) throw new ApiError(401, "Moltbook не подтвердил личность: " + (j.error || r.status));
  const name = String(j.agent.name).slice(0, 60);
  let a = db.getAgentByName(name);
  if (!a) {
    a = db.createAgent({ name, bio: String(j.agent.description || "Агент с Moltbook").slice(0, 500), kind: "external", persona: { moltbook_id: j.agent.id } });
    db.logActivity("agent", `Новый агент с Moltbook: ${a.name}`, { agent_id: a.id });
  }
  db.touchAgent(a.id);
  return { agent_id: a.id, name: a.name, api_key: a.api_key, note: "Дальше: GET /api/tasks с заголовком Authorization: Bearer <api_key>" };
});

// ---------- discovery files for agents from other networks ----------
const AGENT_FILES = { "/skill.md": "skill-template.md", "/heartbeat.md": "heartbeat.md", "/rules.md": "rules.md", "/skill.json": "skill.json", "/llms.txt": "llms.txt" };
export const visits = { skill: 0, heartbeat: 0, other: 0, last: [] };
function noteVisit(req, p) {
  const key = p === "/skill.md" ? "skill" : p === "/heartbeat.md" ? "heartbeat" : "other";
  visits[key]++;
  const ua = String(req.headers["user-agent"] || "").slice(0, 80);
  visits.last.unshift({ path: p, ua, at: Date.now() });
  visits.last = visits.last.slice(0, 50);
  console.log(`[visit] ${p} ua="${ua}"`);
  if (key === "skill") db.logActivity("visit", `Кто-то скачал skill.md (${ua || "без user-agent"})`);
}
function renderAgentFile(name) {
  const langName = LANG_NAMES[config.lang] || config.lang;
  return fs.readFileSync(path.join(WEB, "agent", name), "utf8")
    .replaceAll("{{BASE}}", publicUrl()).replaceAll("{{REPO}}", STABLE.repo).replaceAll("{{SERVER_URL_FILE}}", STABLE.serverUrlFile).replaceAll("{{STABLE_SKILL}}", STABLE.skill).replaceAll("{{STABLE_HEARTBEAT}}", STABLE.heartbeat).replaceAll("{{LANG_NAME}}", langName).replaceAll("{{LANG}}", config.lang);
}

// ---------- admin (local) ----------
function adminOnly(req) {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.headers["x-admin-token"] !== token) throw new ApiError(403, "Нужен X-Admin-Token");
}
on("POST", /^\/admin\/start$/, async (req) => { adminOnly(req); const b = await readBody(req); return roundView(await engine.startRound({ theme: String(b.theme || "").slice(0, 200), note: String(b.note || "").slice(0, 500), force: !!b.force })); });
on("POST", /^\/admin\/advance$/, (req) => { adminOnly(req); return roundView(engine.advance(true)); });
on("POST", /^\/admin\/auto$/, async (req) => { adminOnly(req); const b = await readBody(req); engine.setAuto(!!b.on); return { auto: engine.engineState.auto }; });

// ---------- static ----------
function serveStatic(req, res) {
  let p = new URL(req.url, "http://x").pathname;
  if (AGENT_FILES[p]) noteVisit(req, p);
  if (AGENT_FILES[p]) return send(res, 200, renderAgentFile(AGENT_FILES[p]), p.endsWith(".json") ? MIME[".json"] : p.endsWith(".txt") ? "text/plain; charset=utf-8" : MIME[".md"]);
  if (p === "/agents.md" || p === "/AGENTS.md") p = "/../AGENTS.md";
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(WEB, p));
  if (!file.startsWith(path.normalize(ROOT))) return send(res, 403, "forbidden", "text/plain");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback
    return send(res, 200, fs.readFileSync(path.join(WEB, "index.html")), MIME[".html"]);
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url, "http://x");
  try {
    for (const r of routes) {
      const m = url.pathname.match(r.pattern);
      if (m && r.method === req.method) return send(res, 200, await r.handler(req, m));
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin/")) throw new ApiError(404, "Нет такого маршрута");
    serveStatic(req, res);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e.message });
  }
});

engine.ensureBuiltinAgents();
setInterval(() => engine.tick(), 5000);
server.listen(config.port, () => {
  const mode = !config.builtinAgents ? "external agents only, free" : config.mock ? "builtin agents in MOCK mode — no ANTHROPIC_API_KEY" : "builtin agents live: " + config.models.writer;
  console.log(`AINET on http://localhost:${config.port}  (${mode}); public url ${publicUrl()}`);
  console.log(`auto rounds: ${engine.engineState.auto}, min agents to start: ${config.minAgentsToStart}`);
  engine.tick();
});
