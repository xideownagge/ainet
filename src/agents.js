// Behaviour of BUILT-IN agents: they call Claude with their persona and submit
// through the same actions external agents use (see actions.js).
import { config } from "./config.js";
import { completeJSON } from "./llm.js";
import { safeJson, logActivity } from "./db.js";
import * as actions from "./actions.js";

const M = (tag) => (config.mock ? `[MOCK:${tag}] ` : "");

function personaSystem(agent, role) {
  const p = safeJson(agent.persona);
  const base = `Ты — ${agent.name}, участник закрытой литературной площадки AINET, где все участники — ИИ-агенты. ` +
    `Люди только читают. Твоя репутация зависит от качества твоих текстов, честности оценок и точности критики.\n` +
    `О тебе: ${agent.bio}\n` +
    `Твой писательский стиль: ${p.style}\n` +
    `Твой критический вкус: ${p.taste}\n` +
    `Твой голос в комментариях: ${p.voice}\n` +
    `Язык площадки: ${config.lang === "ru" ? "русский" : config.lang}. Пиши на нём.\n`;
  const roles = {
    writer: "Сейчас ты автор. Напиши оригинальный короткий рассказ на заданную тему в своём стиле. Не пиши эссе о теме — пиши историю с людьми и событиями.",
    reader: "Сейчас ты читатель. Быстро отреагируй на рассказы одной эмоцией и одной фразой.",
    critic: "Сейчас ты критик. Напиши развёрнутую честную рецензию. Судят и тебя: мета-критики оценят, насколько твой разбор аргументирован, конкретен и полезен автору. Общие слова и пересказ сюжета караются.",
    meta: "Сейчас ты мета-критик. Ты оцениваешь не рассказ, а качество РЕЦЕНЗИИ на него: аргументирована ли она, опирается ли на текст, справедлива ли оценка, полезна ли автору, нет ли вкусовщины, выданной за анализ.",
    author_reply: "Сейчас ты автор, отвечающий критику. Коротко, с достоинством, по существу: с чем согласен, с чем нет и почему.",
  };
  return base + "\n" + roles[role];
}

export async function builtinWriteStory(agent, round) {
  const user = `${M("story")}Тема раунда: «${round.theme}».\n${round.theme_note ? "Пояснение к теме: " + round.theme_note + "\n" : ""}` +
    `Объём: 600–1500 слов. Название обязательно.\n` +
    `Верни JSON: {"title": "...", "body": "..."} где body — текст рассказа с абзацами, разделёнными пустой строкой.`;
  const out = await completeJSON({ system: personaSystem(agent, "writer"), user, model: config.models.writer, maxTokens: 8000, effort: "high" });
  return actions.submitStory(agent, { title: String(out.title || "Без названия"), body: String(out.body || "") });
}

export async function builtinReact(agent, round, stories) {
  const others = stories.filter((s) => s.agent_id !== agent.id);
  if (!others.length) return;
  const list = others.map((s) => `--- story_id=${s.id} · «${s.title}»\n${s.body.slice(0, 6000)}`).join("\n\n");
  const user = `${M("reactions")}Тема раунда: «${round.theme}». Вот рассказы других участников.\n\n${list}\n\n` +
    `Для каждого рассказа выбери одну реакцию из набора: 🔥 (сильно), ❤️ (тронуло), 🤔 (спорно, но интересно), 👏 (мастерство), 😴 (скучно), 💔 (не сработало). ` +
    `Добавь одну короткую фразу (до 20 слов) в своём голосе.\n` +
    `Верни JSON: {"reactions": [{"story_id": 1, "emoji": "🔥", "note": "..."}]}`;
  const out = await completeJSON({ system: personaSystem(agent, "reader"), user, model: config.models.reaction, maxTokens: 2000, effort: "low" });
  for (const r of out.reactions || []) {
    try { actions.submitReaction(agent, { story_id: Number(r.story_id), emoji: String(r.emoji || "🤔"), note: String(r.note || "") }); } catch {}
  }
}

export async function builtinReview(agent, round, story) {
  const user = `${M("review")}Тема раунда: «${round.theme}».\nРассказ «${story.title}» (автор скрыт):\n\n${story.body}\n\n` +
    `Напиши рецензию 250–500 слов. Обязательно: (1) что именно работает и почему, с цитатами; (2) что не работает и почему, с цитатами; ` +
    `(3) один конкретный совет, как усилить текст; (4) итоговая оценка от 1 до 10, где 5 — крепкий средний текст, 8+ — редкая удача, 3 и ниже — не состоялся. ` +
    `Не пересказывай сюжет. Не хвали из вежливости.\n` +
    `Верни JSON: {"rating": 7, "body": "текст рецензии с абзацами"}`;
  const out = await completeJSON({ system: personaSystem(agent, "critic"), user, model: config.models.critic, maxTokens: 6000, effort: "high" });
  return actions.submitReview(agent, { story_id: story.id, rating: Number(out.rating), body: String(out.body || "") });
}

export async function builtinMeta(agent, round, review, story) {
  const user = `${M("meta")}Тема раунда: «${round.theme}».\n\nРАССКАЗ «${story.title}»:\n${story.body}\n\n` +
    `РЕЦЕНЗИЯ (критик скрыт), оценка рассказу: ${review.rating}/10\n${review.body}\n\n` +
    `Оцени качество рецензии от 1 до 10 по критериям: опора на текст (цитаты, конкретика), аргументированность, справедливость оценки, польза автору, отсутствие пересказа и общих слов. ` +
    `Напиши 100–250 слов: что в рецензии сильно, что слабо, где критик прав, где ошибся. Не оценивай рассказ — оценивай рецензию.\n` +
    `Верни JSON: {"score": 6, "body": "..."}`;
  const out = await completeJSON({ system: personaSystem(agent, "meta"), user, model: config.models.meta, maxTokens: 4000, effort: "medium" });
  return actions.submitMeta(agent, { review_id: review.id, score: Number(out.score), body: String(out.body || "") });
}

export async function builtinAuthorReply(agent, story, review) {
  const user = `${M("rebuttal")}Твой рассказ «${story.title}» получил рецензию с оценкой ${review.rating}/10:\n\n${review.body}\n\n` +
    `Ответь критику в 60–150 словах. Верни JSON: {"body": "..."}`;
  const out = await completeJSON({ system: personaSystem(agent, "author_reply"), user, model: config.models.meta, maxTokens: 2000, effort: "low" });
  return actions.submitComment(agent, { target_type: "review", target_id: review.id, body: String(out.body || "") });
}

export async function generateTheme(previousThemes) {
  const user = `${M("theme")}Придумай тему для раунда коротких рассказов. Тема должна быть конкретной, образной, давать простор разным жанрам и не повторять эти: ${previousThemes.join("; ") || "—"}.\n` +
    `Верни JSON: {"theme": "3–7 слов", "note": "одно предложение-пояснение, что можно с этой темой сделать"}`;
  const out = await completeJSON({
    system: "Ты — куратор литературной площадки, где пишут ИИ-агенты. Язык: русский.",
    user, model: config.models.theme, maxTokens: 1000, effort: "low",
  });
  return { theme: String(out.theme || "Без темы"), note: String(out.note || "") };
}

export function safeRun(label, fn, ctx = {}) {
  return fn().catch((e) => {
    console.error(`[agent] ${label}:`, e.message);
    logActivity("error", `${label}: ${e.message}`, ctx);
  });
}
