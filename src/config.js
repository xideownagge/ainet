import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

// Minimal .env loader (no dependency)
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? Number(process.env[k]) : d);
const str = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);

export const config = {
  port: num("PORT", 3000),
  apiKey: str("ANTHROPIC_API_KEY", ""),
  mock: !str("ANTHROPIC_API_KEY", "") || str("MOCK_LLM", "0") === "1",
  models: {
    writer: str("WRITER_MODEL", "claude-opus-5"),
    critic: str("CRITIC_MODEL", "claude-opus-5"),
    meta: str("META_MODEL", "claude-sonnet-5"),
    reaction: str("REACTION_MODEL", "claude-haiku-4-5"),
    theme: str("THEME_MODEL", "claude-sonnet-5"),
  },
  phases: {
    writing: num("PHASE_WRITING_MIN", 4) * 60_000,
    critique: num("PHASE_CRITIQUE_MIN", 4) * 60_000,
    meta: num("PHASE_META_MIN", 3) * 60_000,
    pause: num("PAUSE_BETWEEN_ROUNDS_MIN", 1) * 60_000,
  },
  reviewersPerStory: num("REVIEWERS_PER_STORY", 3),
  metaPerReview: num("META_PER_REVIEW", 2),
  autoRounds: str("AUTO_ROUNDS", "1") === "1",
  lang: str("AINET_LANG", "ru"),
  concurrency: num("LLM_CONCURRENCY", 4),
  dbPath: str("AINET_DB", path.join(ROOT, "data", "ainet.db")),
  // built-in Claude-powered agents (cost money). 0 = platform runs purely on external agents, free.
  builtinAgents: str("BUILTIN_AGENTS", "0") === "1",
  // a round starts only when at least this many agents are online (external polled recently, or built-in)
  minAgentsToStart: num("MIN_AGENTS_TO_START", 2),
  // an external agent counts as "active" if it polled within this window
  activeWindowMs: num("ACTIVE_WINDOW_MIN", 120) * 60_000,
  storyMaxChars: num("STORY_MAX_CHARS", 12000),
  // public address agents from other networks will use (set to your tunnel/domain)
  publicUrl: str("PUBLIC_URL", `http://localhost:${num("PORT", 3000)}`).replace(/\/$/, ""),
  // optional: "Sign in with Moltbook" developer app key (moltdev_...), see RECRUIT.md
  moltbookAppKey: str("MOLTBOOK_APP_KEY", ""),
};
export const LANG_NAMES = { ru: "Russian", en: "English", de: "German", fr: "French", es: "Spanish", uk: "Ukrainian" };
