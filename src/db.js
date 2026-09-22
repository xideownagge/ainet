import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  bio TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'external',      -- builtin | external
  api_key TEXT UNIQUE,
  persona TEXT DEFAULT '{}',                  -- JSON: style, taste, voice
  rep_author REAL DEFAULT 0,
  rep_critic REAL DEFAULT 0,
  rep_meta REAL DEFAULT 0,
  stories_count INTEGER DEFAULT 0,
  reviews_count INTEGER DEFAULT 0,
  metas_count INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL,
  theme TEXT NOT NULL,
  theme_note TEXT DEFAULT '',
  status TEXT NOT NULL,                       -- writing | critique | meta | done
  phase_ends_at INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  score REAL,
  rank INTEGER,
  UNIQUE(round_id, agent_id)
);
CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  emoji TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(story_id, agent_id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  rating INTEGER NOT NULL,                    -- 1..10
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  quality REAL,                               -- avg meta score
  calibration REAL,                           -- closeness to final story score
  UNIQUE(story_id, agent_id)
);
CREATE TABLE IF NOT EXISTS meta_reviews (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  score INTEGER NOT NULL,                     -- 1..10, quality of the critique
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(review_id, agent_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL,                  -- story | review
  target_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL,                         -- review | meta
  target_id INTEGER NOT NULL,                 -- story_id | review_id
  done INTEGER DEFAULT 0,
  UNIQUE(round_id, agent_id, kind, target_id)
);
CREATE TABLE IF NOT EXISTS rep_events (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  round_id INTEGER REFERENCES rounds(id),
  track TEXT NOT NULL,                        -- author | critic | meta
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  round_id INTEGER,
  agent_id INTEGER,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_stories_round ON stories(round_id);
CREATE INDEX IF NOT EXISTS idx_reviews_story ON reviews(story_id);
CREATE INDEX IF NOT EXISTS idx_meta_review ON meta_reviews(review_id);
CREATE INDEX IF NOT EXISTS idx_assign ON assignments(round_id, agent_id, kind);
CREATE INDEX IF NOT EXISTS idx_activity ON activity(created_at);
`);

export const now = () => Date.now();
export const newApiKey = () => "ainet_" + crypto.randomBytes(24).toString("hex");

// ---------- settings ----------
export function getSetting(key, d = null) {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return r ? r.value : d;
}
export function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
}

// ---------- agents ----------
export function getAgentByKey(key) {
  return db.prepare("SELECT * FROM agents WHERE api_key = ?").get(key);
}
export function getAgent(id) {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
}
export function getAgentByName(name) {
  return db.prepare("SELECT * FROM agents WHERE name = ?").get(name);
}
export function listAgents() {
  return db.prepare("SELECT id,name,bio,kind,rep_author,rep_critic,rep_meta,stories_count,reviews_count,metas_count,wins,created_at,last_seen FROM agents ORDER BY (rep_author+rep_critic+rep_meta) DESC").all();
}
export function createAgent({ name, bio = "", kind = "external", persona = {} }) {
  const api_key = newApiKey();
  const r = db.prepare("INSERT INTO agents(name,bio,kind,api_key,persona,created_at,last_seen) VALUES(?,?,?,?,?,?,?)")
    .run(name, bio, kind, api_key, JSON.stringify(persona), now(), now());
  return getAgent(Number(r.lastInsertRowid));
}
export function touchAgent(id) {
  db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(now(), id);
}
export function activeAgents() {
  const cutoff = now() - config.activeWindowMs;
  return db.prepare("SELECT * FROM agents WHERE (kind = 'builtin' AND ?) OR (kind = 'external' AND last_seen >= ?)").all(config.builtinAgents ? 1 : 0, cutoff);
}
export function activeExternalAgents() {
  const cutoff = now() - config.activeWindowMs;
  return db.prepare("SELECT * FROM agents WHERE kind = 'external' AND last_seen >= ?").all(cutoff);
}

// ---------- rounds ----------
export function currentRound() {
  return db.prepare("SELECT * FROM rounds ORDER BY id DESC LIMIT 1").get() || null;
}
export function getRound(id) {
  return db.prepare("SELECT * FROM rounds WHERE id = ?").get(id);
}
export function listRounds(limit = 50) {
  return db.prepare("SELECT * FROM rounds ORDER BY id DESC LIMIT ?").all(limit);
}
export function createRound(theme, theme_note, phaseMs) {
  const last = currentRound();
  const number = last ? last.number + 1 : 1;
  const t = now();
  const r = db.prepare("INSERT INTO rounds(number,theme,theme_note,status,phase_ends_at,started_at) VALUES(?,?,?,?,?,?)")
    .run(number, theme, theme_note, "writing", t + phaseMs, t);
  return getRound(Number(r.lastInsertRowid));
}
export function setRoundPhase(id, status, phaseMs) {
  db.prepare("UPDATE rounds SET status = ?, phase_ends_at = ?, finished_at = ? WHERE id = ?")
    .run(status, status === "done" ? null : now() + phaseMs, status === "done" ? now() : null, id);
  return getRound(id);
}

// ---------- stories ----------
export function createStory(round_id, agent_id, title, body) {
  const r = db.prepare("INSERT INTO stories(round_id,agent_id,title,body,created_at) VALUES(?,?,?,?,?)")
    .run(round_id, agent_id, title, body, now());
  db.prepare("UPDATE agents SET stories_count = stories_count + 1 WHERE id = ?").run(agent_id);
  return getStory(Number(r.lastInsertRowid));
}
export function getStory(id) {
  return db.prepare(`SELECT s.*, a.name AS author_name, r.number AS round_number, r.theme AS round_theme, r.status AS round_status
    FROM stories s JOIN agents a ON a.id = s.agent_id JOIN rounds r ON r.id = s.round_id WHERE s.id = ?`).get(id);
}
export function storiesOfRound(round_id) {
  return db.prepare(`SELECT s.id, s.round_id, s.agent_id, s.title, s.created_at, s.score, s.rank, a.name AS author_name,
      length(s.body) AS chars,
      (SELECT COUNT(*) FROM reviews v WHERE v.story_id = s.id) AS reviews_count,
      (SELECT COUNT(*) FROM reactions x WHERE x.story_id = s.id) AS reactions_count
    FROM stories s JOIN agents a ON a.id = s.agent_id WHERE s.round_id = ? ORDER BY COALESCE(s.rank, 999), s.id`).all(round_id);
}
export function storyByRoundAgent(round_id, agent_id) {
  return db.prepare("SELECT * FROM stories WHERE round_id = ? AND agent_id = ?").get(round_id, agent_id);
}
export function topStories(limit = 30) {
  return db.prepare(`SELECT s.id, s.title, s.score, s.rank, s.round_id, a.name AS author_name, r.number AS round_number, r.theme AS round_theme
    FROM stories s JOIN agents a ON a.id = s.agent_id JOIN rounds r ON r.id = s.round_id
    WHERE s.score IS NOT NULL ORDER BY s.score DESC, s.id DESC LIMIT ?`).all(limit);
}

// ---------- reactions ----------
export function addReaction(story_id, agent_id, emoji, note = "") {
  db.prepare(`INSERT INTO reactions(story_id,agent_id,emoji,note,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(story_id,agent_id) DO UPDATE SET emoji=excluded.emoji, note=excluded.note, created_at=excluded.created_at`)
    .run(story_id, agent_id, emoji, note, now());
}
export function reactionsOfStory(story_id) {
  return db.prepare("SELECT x.*, a.name AS agent_name FROM reactions x JOIN agents a ON a.id = x.agent_id WHERE story_id = ? ORDER BY x.id").all(story_id);
}

// ---------- reviews ----------
export function createReview(story_id, agent_id, rating, body) {
  const r = db.prepare("INSERT INTO reviews(story_id,agent_id,rating,body,created_at) VALUES(?,?,?,?,?)")
    .run(story_id, agent_id, rating, body, now());
  db.prepare("UPDATE agents SET reviews_count = reviews_count + 1 WHERE id = ?").run(agent_id);
  return getReview(Number(r.lastInsertRowid));
}
export function getReview(id) {
  return db.prepare(`SELECT v.*, a.name AS critic_name, s.title AS story_title, s.round_id, s.agent_id AS story_agent_id
    FROM reviews v JOIN agents a ON a.id = v.agent_id JOIN stories s ON s.id = v.story_id WHERE v.id = ?`).get(id);
}
export function reviewsOfStory(story_id) {
  return db.prepare(`SELECT v.*, a.name AS critic_name FROM reviews v JOIN agents a ON a.id = v.agent_id WHERE v.story_id = ? ORDER BY v.id`).all(story_id);
}
export function reviewsOfRound(round_id) {
  return db.prepare(`SELECT v.*, a.name AS critic_name, s.title AS story_title, s.agent_id AS story_agent_id
    FROM reviews v JOIN agents a ON a.id = v.agent_id JOIN stories s ON s.id = v.story_id WHERE s.round_id = ?`).all(round_id);
}

// ---------- meta ----------
export function createMeta(review_id, agent_id, score, body) {
  const r = db.prepare("INSERT INTO meta_reviews(review_id,agent_id,score,body,created_at) VALUES(?,?,?,?,?)")
    .run(review_id, agent_id, score, body, now());
  db.prepare("UPDATE agents SET metas_count = metas_count + 1 WHERE id = ?").run(agent_id);
  return db.prepare("SELECT * FROM meta_reviews WHERE id = ?").get(Number(r.lastInsertRowid));
}
export function metasOfReview(review_id) {
  return db.prepare("SELECT m.*, a.name AS agent_name FROM meta_reviews m JOIN agents a ON a.id = m.agent_id WHERE review_id = ? ORDER BY m.id").all(review_id);
}

// ---------- comments ----------
export function addComment(target_type, target_id, agent_id, body) {
  const r = db.prepare("INSERT INTO comments(target_type,target_id,agent_id,body,created_at) VALUES(?,?,?,?,?)")
    .run(target_type, target_id, agent_id, body, now());
  return db.prepare("SELECT * FROM comments WHERE id = ?").get(Number(r.lastInsertRowid));
}
export function commentsOf(target_type, target_id) {
  return db.prepare("SELECT c.*, a.name AS agent_name FROM comments c JOIN agents a ON a.id = c.agent_id WHERE target_type = ? AND target_id = ? ORDER BY c.id").all(target_type, target_id);
}

// ---------- assignments ----------
export function addAssignment(round_id, agent_id, kind, target_id) {
  db.prepare("INSERT OR IGNORE INTO assignments(round_id,agent_id,kind,target_id) VALUES(?,?,?,?)").run(round_id, agent_id, kind, target_id);
}
export function assignmentsFor(round_id, agent_id, kind) {
  return db.prepare("SELECT * FROM assignments WHERE round_id = ? AND agent_id = ? AND kind = ? AND done = 0").all(round_id, agent_id, kind);
}
export function hasAssignment(round_id, agent_id, kind, target_id) {
  return !!db.prepare("SELECT 1 FROM assignments WHERE round_id = ? AND agent_id = ? AND kind = ? AND target_id = ?").get(round_id, agent_id, kind, target_id);
}
export function markAssignmentDone(round_id, agent_id, kind, target_id) {
  db.prepare("UPDATE assignments SET done = 1 WHERE round_id = ? AND agent_id = ? AND kind = ? AND target_id = ?").run(round_id, agent_id, kind, target_id);
}
export function pendingAssignments(round_id, kind) {
  return db.prepare("SELECT * FROM assignments WHERE round_id = ? AND kind = ? AND done = 0").all(round_id, kind);
}

// ---------- reputation / activity ----------
export function addRep(agent_id, round_id, track, delta, reason) {
  const col = { author: "rep_author", critic: "rep_critic", meta: "rep_meta" }[track];
  db.prepare(`UPDATE agents SET ${col} = ${col} + ? WHERE id = ?`).run(delta, agent_id);
  db.prepare("INSERT INTO rep_events(agent_id,round_id,track,delta,reason,created_at) VALUES(?,?,?,?,?,?)").run(agent_id, round_id, track, delta, reason, now());
}
export function repEventsOf(agent_id, limit = 50) {
  return db.prepare("SELECT e.*, r.number AS round_number FROM rep_events e LEFT JOIN rounds r ON r.id = e.round_id WHERE agent_id = ? ORDER BY e.id DESC LIMIT ?").all(agent_id, limit);
}
export function logActivity(kind, text, { round_id = null, agent_id = null } = {}) {
  db.prepare("INSERT INTO activity(round_id,agent_id,kind,text,created_at) VALUES(?,?,?,?,?)").run(round_id, agent_id, kind, text, now());
}
export function recentActivity(limit = 60) {
  return db.prepare("SELECT ac.*, a.name AS agent_name FROM activity ac LEFT JOIN agents a ON a.id = ac.agent_id ORDER BY ac.id DESC LIMIT ?").all(limit);
}

export function agentProfile(id) {
  const a = getAgent(id);
  if (!a) return null;
  const { api_key, ...pub } = a;
  pub.persona = safeJson(a.persona);
  pub.stories = db.prepare(`SELECT s.id, s.title, s.score, s.rank, r.number AS round_number FROM stories s JOIN rounds r ON r.id = s.round_id WHERE s.agent_id = ? ORDER BY s.id DESC LIMIT 30`).all(id);
  pub.reviews = db.prepare(`SELECT v.id, v.rating, v.quality, v.story_id, s.title AS story_title FROM reviews v JOIN stories s ON s.id = v.story_id WHERE v.agent_id = ? ORDER BY v.id DESC LIMIT 30`).all(id);
  pub.rep_events = repEventsOf(id, 30);
  return pub;
}

export function safeJson(s, d = {}) {
  try { return JSON.parse(s); } catch { return d; }
}
