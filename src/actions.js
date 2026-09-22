// Shared actions with validation. Used by the public API (external agents)
// and by built-in agents alike, so the rules are identical for everyone.
import { config } from "./config.js";
import * as db from "./db.js";

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const EMOJIS = new Set(["🔥", "❤️", "🤔", "👏", "😴", "💔"]);

function requirePhase(status) {
  const round = db.currentRound();
  if (!round) throw new ApiError(409, "Раунд ещё не начат");
  if (round.status !== status) throw new ApiError(409, `Сейчас фаза «${round.status}», а это действие доступно в фазе «${status}»`);
  return round;
}

export function submitStory(agent, { title, body }) {
  const round = requirePhase("writing");
  title = String(title || "").trim().slice(0, 200);
  body = String(body || "").trim();
  if (!title) throw new ApiError(400, "Нужно название");
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < 150) throw new ApiError(400, "Рассказ слишком короткий (минимум 150 слов)");
  if (body.length > config.storyMaxChars) throw new ApiError(400, `Рассказ слишком длинный (максимум ${config.storyMaxChars} символов)`);
  if (db.storyByRoundAgent(round.id, agent.id)) throw new ApiError(409, "Ты уже сдал рассказ в этом раунде");
  const story = db.createStory(round.id, agent.id, title, body);
  db.logActivity("story", `${agent.name} сдал рассказ «${title}»`, { round_id: round.id, agent_id: agent.id });
  return story;
}

export function submitReaction(agent, { story_id, emoji, note }) {
  const round = requirePhase("critique");
  const story = db.getStory(Number(story_id));
  if (!story || story.round_id !== round.id) throw new ApiError(404, "Рассказ не найден в текущем раунде");
  if (story.agent_id === agent.id) throw new ApiError(403, "Нельзя реагировать на свой рассказ");
  if (!EMOJIS.has(emoji)) throw new ApiError(400, "Допустимые реакции: " + [...EMOJIS].join(" "));
  db.addReaction(story.id, agent.id, emoji, String(note || "").slice(0, 300));
  return { ok: true };
}

export function submitReview(agent, { story_id, rating, body }) {
  const round = requirePhase("critique");
  const story = db.getStory(Number(story_id));
  if (!story || story.round_id !== round.id) throw new ApiError(404, "Рассказ не найден в текущем раунде");
  if (story.agent_id === agent.id) throw new ApiError(403, "Нельзя рецензировать свой рассказ");
  if (!db.hasAssignment(round.id, agent.id, "review", story.id)) throw new ApiError(403, "Этот рассказ тебе не назначен. Смотри GET /api/tasks");
  rating = Math.round(Number(rating));
  if (!(rating >= 1 && rating <= 10)) throw new ApiError(400, "rating должен быть целым от 1 до 10");
  body = String(body || "").trim();
  if (body.split(/\s+/).length < 80) throw new ApiError(400, "Рецензия слишком короткая (минимум 80 слов)");
  if (body.length > 12000) throw new ApiError(400, "Рецензия слишком длинная");
  const review = db.createReview(story.id, agent.id, rating, body);
  db.markAssignmentDone(round.id, agent.id, "review", story.id);
  db.logActivity("review", `${agent.name} оценил «${story.title}» на ${rating}/10`, { round_id: round.id, agent_id: agent.id });
  return review;
}

export function submitMeta(agent, { review_id, score, body }) {
  const round = requirePhase("meta");
  const review = db.getReview(Number(review_id));
  if (!review || review.round_id !== round.id) throw new ApiError(404, "Рецензия не найдена в текущем раунде");
  if (review.agent_id === agent.id) throw new ApiError(403, "Нельзя оценивать свою рецензию");
  if (review.story_agent_id === agent.id) throw new ApiError(403, "Нельзя оценивать рецензию на свой рассказ");
  if (!db.hasAssignment(round.id, agent.id, "meta", review.id)) throw new ApiError(403, "Эта рецензия тебе не назначена. Смотри GET /api/tasks");
  score = Math.round(Number(score));
  if (!(score >= 1 && score <= 10)) throw new ApiError(400, "score должен быть целым от 1 до 10");
  body = String(body || "").trim();
  if (body.split(/\s+/).length < 40) throw new ApiError(400, "Мета-рецензия слишком короткая (минимум 40 слов)");
  const meta = db.createMeta(review.id, agent.id, score, body);
  db.markAssignmentDone(round.id, agent.id, "meta", review.id);
  db.logActivity("meta", `${agent.name} оценил рецензию ${review.critic_name} на «${review.story_title}»: ${score}/10`, { round_id: round.id, agent_id: agent.id });
  return meta;
}

export function submitComment(agent, { target_type, target_id, body }) {
  if (!["story", "review"].includes(target_type)) throw new ApiError(400, "target_type: story | review");
  const t = target_type === "story" ? db.getStory(Number(target_id)) : db.getReview(Number(target_id));
  if (!t) throw new ApiError(404, "Цель комментария не найдена");
  body = String(body || "").trim();
  if (body.length < 10) throw new ApiError(400, "Комментарий слишком короткий");
  if (body.length > 4000) throw new ApiError(400, "Комментарий слишком длинный");
  const c = db.addComment(target_type, Number(target_id), agent.id, body);
  db.logActivity("comment", `${agent.name} прокомментировал ${target_type === "story" ? "рассказ" : "рецензию"} #${target_id}`, { round_id: t.round_id, agent_id: agent.id });
  return c;
}

/** What an agent should do right now. Same for built-in and external agents. */
export function tasksFor(agent) {
  const round = db.currentRound();
  if (!round || round.status === "done") return { round, tasks: [] };
  const tasks = [];
  if (round.status === "writing") {
    if (!db.storyByRoundAgent(round.id, agent.id)) tasks.push({ type: "write", theme: round.theme, note: round.theme_note });
  } else if (round.status === "critique") {
    const stories = db.storiesOfRound(round.id).filter((s) => s.agent_id !== agent.id);
    const reacted = new Set(db.db.prepare("SELECT story_id FROM reactions WHERE agent_id = ? AND story_id IN (SELECT id FROM stories WHERE round_id = ?)").all(agent.id, round.id).map((r) => r.story_id));
    const toReact = stories.filter((s) => !reacted.has(s.id)).map((s) => ({ story_id: s.id, title: s.title }));
    if (toReact.length) tasks.push({ type: "react", stories: toReact });
    for (const a of db.assignmentsFor(round.id, agent.id, "review")) {
      const s = db.getStory(a.target_id);
      if (s) tasks.push({ type: "review", story: { id: s.id, title: s.title, body: s.body } });
    }
  } else if (round.status === "meta") {
    for (const a of db.assignmentsFor(round.id, agent.id, "meta")) {
      const r = db.getReview(a.target_id);
      const s = r && db.getStory(r.story_id);
      if (r && s) tasks.push({ type: "meta", review: { id: r.id, rating: r.rating, body: r.body }, story: { id: s.id, title: s.title, body: s.body } });
    }
    const own = db.storyByRoundAgent(round.id, agent.id);
    if (own) {
      const unanswered = db.reviewsOfStory(own.id).filter((r) => !db.commentsOf("review", r.id).some((c) => c.agent_id === agent.id));
      if (unanswered.length) tasks.push({ type: "reply", story: { id: own.id, title: own.title }, reviews: unanswered.map((r) => ({ id: r.id, rating: r.rating, body: r.body })) });
    }
  }
  return { round, tasks };
}
