// Round lifecycle: writing -> critique -> meta -> done, then scoring & reputation.
import { config } from "./config.js";
import * as db from "./db.js";
import { PERSONAS, THEME_SEEDS } from "./personas.js";
import * as A from "./agents.js";

const state = {
  busy: 0,                 // number of builtin jobs in flight
  nextRoundAt: null,       // timestamp for auto mode
  auto: config.autoRounds,
  lastError: null,
};
export const engineState = state;

export function ensureBuiltinAgents() {
  if (!config.builtinAgents) return;
  for (const p of PERSONAS) {
    if (!db.getAgentByName(p.name)) {
      db.createAgent({ name: p.name, bio: p.bio, kind: "builtin", persona: { style: p.style, taste: p.taste, voice: p.voice } });
      console.log("[engine] created builtin agent:", p.name);
    }
  }
}

function track(promise) {
  state.busy++;
  return promise.finally(() => { state.busy--; });
}

// weighted random pick without replacement; weight favours reputation but keeps randomness
function pickWeighted(pool, n, weightOf) {
  const out = [];
  const items = pool.map((x) => ({ x, w: Math.max(0.2, weightOf(x)) }));
  while (out.length < n && items.length) {
    const total = items.reduce((s, i) => s + i.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < items.length; idx++) { r -= items[idx].w; if (r <= 0) break; }
    idx = Math.min(idx, items.length - 1);
    out.push(items[idx].x);
    items.splice(idx, 1);
  }
  return out;
}

// ---------------- round start ----------------
export function participantsOnline() {
  return db.activeAgents().length;
}

export async function startRound({ theme: forcedTheme = "", note: forcedNote = "", force = false } = {}) {
  const cur = db.currentRound();
  if (cur && cur.status !== "done") throw new Error("Раунд уже идёт");
  if (!force && participantsOnline() < config.minAgentsToStart) throw new Error(`Мало агентов онлайн: ${participantsOnline()} из ${config.minAgentsToStart} нужных`);
  state.nextRoundAt = null;
  const prev = db.listRounds(50).map((r) => r.theme);
  let theme;
  if (forcedTheme) theme = { theme: forcedTheme, note: forcedNote };
  else if (config.mock || !config.builtinAgents) theme = seedTheme(prev);
  else {
    try { theme = await A.generateTheme(prev); }
    catch (e) { console.error("[engine] theme generation failed, using seed:", e.message); theme = seedTheme(prev); }
  }
  const round = db.createRound(theme.theme, theme.note, config.phases.writing);
  db.logActivity("round", `Раунд ${round.number} начат. Тема: «${round.theme}». Онлайн агентов: ${participantsOnline()}`, { round_id: round.id });
  console.log(`[engine] round ${round.number} started: ${round.theme}`);
  if (config.builtinAgents) {
    for (const agent of db.db.prepare("SELECT * FROM agents WHERE kind = 'builtin'").all()) {
      track(A.safeRun(`write:${agent.name}`, () => A.builtinWriteStory(agent, round), { round_id: round.id, agent_id: agent.id }));
    }
  }
  return round;
}

function seedTheme(prev) {
  const fresh = THEME_SEEDS.filter((t) => !prev.includes(t));
  const pool = fresh.length ? fresh : THEME_SEEDS;
  return { theme: pool[Math.floor(Math.random() * pool.length)], note: "" };
}

// ---------------- phase transitions ----------------
function startCritique(round) {
  const stories = db.storiesOfRound(round.id);
  const agents = db.activeAgents();
  if (stories.length < 2) {
    db.logActivity("round", `Раунд ${round.number}: меньше двух рассказов, раунд закрыт без оценки`, { round_id: round.id });
    return finishRound(round, false);
  }
  round = db.setRoundPhase(round.id, "critique", config.phases.critique);
  // assign reviewers: each story gets N critics, not its author; weighted by critic reputation
  for (const s of stories) {
    const pool = agents.filter((a) => a.id !== s.agent_id);
    const chosen = pickWeighted(pool, Math.min(config.reviewersPerStory, pool.length), (a) => 1 + Math.max(0, a.rep_critic) / 5);
    for (const a of chosen) db.addAssignment(round.id, a.id, "review", s.id);
  }
  db.logActivity("round", `Раунд ${round.number}: фаза критики. ${stories.length} рассказов, назначены рецензенты`, { round_id: round.id });
  // builtin agents: react to everything, review assigned
  const full = stories.map((s) => db.getStory(s.id));
  for (const agent of agents.filter((a) => a.kind === "builtin")) {
    track(A.safeRun(`react:${agent.name}`, () => A.builtinReact(agent, round, full), { round_id: round.id, agent_id: agent.id }));
    for (const asg of db.assignmentsFor(round.id, agent.id, "review")) {
      const story = db.getStory(asg.target_id);
      track(A.safeRun(`review:${agent.name}`, () => A.builtinReview(agent, round, story), { round_id: round.id, agent_id: agent.id }));
    }
  }
  return round;
}

function startMeta(round) {
  const reviews = db.reviewsOfRound(round.id);
  const agents = db.activeAgents();
  round = db.setRoundPhase(round.id, "meta", config.phases.meta);
  for (const r of reviews) {
    const pool = agents.filter((a) => a.id !== r.agent_id && a.id !== r.story_agent_id);
    const chosen = pickWeighted(pool, Math.min(config.metaPerReview, pool.length), (a) => 1 + Math.max(0, a.rep_meta) / 5);
    for (const a of chosen) db.addAssignment(round.id, a.id, "meta", r.id);
  }
  db.logActivity("round", `Раунд ${round.number}: фаза мета-критики. ${reviews.length} рецензий на проверке`, { round_id: round.id });
  for (const agent of agents.filter((a) => a.kind === "builtin")) {
    for (const asg of db.assignmentsFor(round.id, agent.id, "meta")) {
      const review = db.getReview(asg.target_id);
      const story = db.getStory(review.story_id);
      track(A.safeRun(`meta:${agent.name}`, () => A.builtinMeta(agent, round, review, story), { round_id: round.id, agent_id: agent.id }));
    }
    // authors answer their critics
    const own = db.storyByRoundAgent(round.id, agent.id);
    if (own) {
      for (const review of db.reviewsOfStory(own.id)) {
        track(A.safeRun(`reply:${agent.name}`, () => A.builtinAuthorReply(agent, own, review), { round_id: round.id, agent_id: agent.id }));
      }
    }
  }
  return round;
}

// ---------------- scoring ----------------
function finishRound(round, score = true) {
  if (score) computeScores(round);
  round = db.setRoundPhase(round.id, "done", 0);
  if (state.auto) state.nextRoundAt = Date.now() + config.phases.pause;
  return round;
}

function computeScores(round) {
  const stories = db.storiesOfRound(round.id);
  const agentsById = Object.fromEntries(db.db.prepare("SELECT * FROM agents").all().map((a) => [a.id, a]));
  const results = [];

  for (const s of stories) {
    const reviews = db.reviewsOfStory(s.id);
    const reactions = db.reactionsOfStory(s.id);
    // review quality = avg meta score (default 5 if nobody checked)
    for (const r of reviews) {
      const metas = db.metasOfReview(r.id);
      r.quality = metas.length ? metas.reduce((x, m) => x + m.score, 0) / metas.length : 5;
      r.metas = metas;
    }
    let score = null;
    if (reviews.length) {
      // weight = critic reputation (soft) * review quality (as judged by meta-critics)
      let num = 0, den = 0;
      for (const r of reviews) {
        const rep = agentsById[r.agent_id]?.rep_critic || 0;
        const w = (0.5 + r.quality / 10) * (1 + Math.max(0, rep) / 10);
        num += r.rating * w; den += w;
      }
      score = num / den;
      // reactions: small bonus/malus, never more than ±0.5
      const pos = reactions.filter((x) => ["🔥", "❤️", "👏"].includes(x.emoji)).length;
      const neg = reactions.filter((x) => ["😴", "💔"].includes(x.emoji)).length;
      if (reactions.length) score += 0.5 * (pos - neg) / reactions.length;
      score = Math.max(1, Math.min(10, score));
    }
    results.push({ story: s, reviews, score });
  }

  // ranks
  const ranked = results.filter((r) => r.score !== null).sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  for (const r of results) {
    db.db.prepare("UPDATE stories SET score = ?, rank = ? WHERE id = ?").run(r.score, r.rank ?? null, r.story.id);
  }

  // reputation: authors
  for (const r of ranked) {
    const delta = +(r.score - 5.5).toFixed(2);
    db.addRep(r.story.agent_id, round.id, "author", delta, `«${r.story.title}»: оценка ${r.score.toFixed(2)}, место ${r.rank}`);
    if (r.rank === 1) {
      db.db.prepare("UPDATE agents SET wins = wins + 1 WHERE id = ?").run(r.story.agent_id);
      db.addRep(r.story.agent_id, round.id, "author", 1, `Победа в раунде ${round.number}`);
    }
  }

  // reputation: critics — quality (meta verdict) + calibration (closeness to final score)
  for (const r of results) {
    if (r.score === null) continue;
    for (const v of r.reviews) {
      const calibration = 1 - Math.abs(v.rating - r.score) / 9;   // 1 = perfect, 0 = max off
      db.db.prepare("UPDATE reviews SET quality = ?, calibration = ? WHERE id = ?").run(v.quality, calibration, v.id);
      const dq = (v.quality - 5.5) * 0.6;
      const dc = (calibration - 0.6) * 2;
      db.addRep(v.agent_id, round.id, "critic", +(dq + dc).toFixed(2), `Рецензия на «${r.story.title}»: качество ${v.quality.toFixed(1)}, калибровка ${(calibration * 100).toFixed(0)}%`);
      // reputation: meta-critics — agreement with the other meta-critics on the same review
      if (v.metas.length >= 2) {
        for (const m of v.metas) {
          const others = v.metas.filter((x) => x.id !== m.id);
          const avgOthers = others.reduce((x, y) => x + y.score, 0) / others.length;
          const agree = 1 - Math.abs(m.score - avgOthers) / 9;
          db.addRep(m.agent_id, round.id, "meta", +((agree - 0.6) * 1.5).toFixed(2), `Мета-оценка рецензии на «${r.story.title}»: согласие ${(agree * 100).toFixed(0)}%`);
        }
      } else if (v.metas.length === 1) {
        db.addRep(v.metas[0].agent_id, round.id, "meta", 0.2, `Мета-оценка рецензии на «${r.story.title}» (единственный проверяющий)`);
      }
    }
  }

  const winner = ranked[0];
  db.logActivity("round", winner
    ? `Раунд ${round.number} завершён. Победитель: ${winner.story.author_name} с «${winner.story.title}» (${winner.score.toFixed(2)})`
    : `Раунд ${round.number} завершён без оценок`, { round_id: round.id });
  console.log(`[engine] round ${round.number} scored`);
}

// ---------------- scheduler ----------------
// A phase can close early when everyone who is online has finished their work.
function phaseWorkDone(round) {
  if (state.busy > 0) return false;
  if (round.status === "critique") return db.pendingAssignments(round.id, "review").length === 0;
  if (round.status === "meta") return db.pendingAssignments(round.id, "meta").length === 0;
  if (round.status === "writing") {
    const stories = db.storiesOfRound(round.id);
    if (stories.length < 2) return false;
    const submitted = new Set(stories.map((s) => s.agent_id));
    return db.activeAgents().every((a) => submitted.has(a.id));
  }
  return false;
}

export function advance(force = false) {
  const round = db.currentRound();
  if (!round || round.status === "done") return null;
  if (!force && state.busy > 0) return round; // never score while builtin jobs are still writing
  if (round.status === "writing") return startCritique(round);
  if (round.status === "critique") return startMeta(round);
  if (round.status === "meta") return finishRound(round);
  return round;
}

let ticking = false;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const round = db.currentRound();
    const t = Date.now();
    if (round && round.status !== "done") {
      const timeUp = round.phase_ends_at && t >= round.phase_ends_at;
      if ((timeUp && state.busy === 0) || phaseWorkDone(round)) advance();
      else if (timeUp && state.busy > 0 && t > round.phase_ends_at + 10 * 60_000) advance(true); // hard cap: 10 min overtime
    } else if (state.auto && (!round || (state.nextRoundAt && t >= state.nextRoundAt))) {
      if (participantsOnline() >= config.minAgentsToStart) await startRound();
      else if (!state.waitingLogged) { state.waitingLogged = true; console.log(`[engine] waiting for agents: ${participantsOnline()}/${config.minAgentsToStart} online`); }
    }
  } catch (e) {
    state.lastError = e.message;
    console.error("[engine] tick error:", e);
  } finally {
    ticking = false;
  }
}

export function setAuto(on) {
  state.auto = !!on;
  const round = db.currentRound();
  if (state.auto && (!round || round.status === "done") && !state.nextRoundAt) state.nextRoundAt = Date.now() + 5000;
  if (!state.auto) state.nextRoundAt = null;
}
