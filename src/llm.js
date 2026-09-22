import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const client = config.mock ? null : new Anthropic();

// simple concurrency limiter
let running = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    const tryRun = () => {
      if (running < config.concurrency) { running++; resolve(); } else queue.push(tryRun);
    };
    tryRun();
  });
}
function release() {
  running--;
  const next = queue.shift();
  if (next) next();
}

export const llmStats = { calls: 0, input_tokens: 0, output_tokens: 0, errors: 0, refusals: 0, mock: config.mock };

/**
 * Ask Claude for plain text.
 */
export async function complete({ system, user, model, maxTokens = 6000, effort = "medium" }) {
  if (config.mock) return mockText(system, user);
  await acquire();
  try {
    llmStats.calls++;
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      thinking: { type: "adaptive" },
      output_config: { effort },
      messages: [{ role: "user", content: user }],
    });
    const msg = await stream.finalMessage();
    llmStats.input_tokens += msg.usage?.input_tokens || 0;
    llmStats.output_tokens += msg.usage?.output_tokens || 0;
    if (msg.stop_reason === "refusal") {
      llmStats.refusals++;
      throw new Error("model refused: " + (msg.stop_details?.category || "unknown"));
    }
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  } catch (e) {
    llmStats.errors++;
    throw e;
  } finally {
    release();
  }
}

/**
 * Ask Claude for a JSON object. Robust to code fences and leading prose.
 */
export async function completeJSON(opts) {
  const text = await complete({ ...opts, user: opts.user + "\n\nОтветь строго одним JSON-объектом без пояснений и без markdown." });
  return parseJson(text);
}

export function parseJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// ---------------- MOCK MODE ----------------
// Deterministic placeholder generation so the whole pipeline can run without an API key.
let mockCounter = 0;
const filler = (t, n) => { const w = t.split(" "); while (w.length < n) w.push(...t.split(" ")); return w.join(" "); };
function mockText(system, user) {
  mockCounter++;
  const u = String(user);
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  if (u.includes("[MOCK:theme]")) {
    const themes = ["Последний трамвай", "Дом, который помнит", "Письмо без адреса", "Снег в июле", "Чужие ключи", "Тишина после праздника"];
    return JSON.stringify({ theme: themes[mockCounter % themes.length], note: "Тема-заглушка для тестового режима." });
  }
  if (u.includes("[MOCK:story]")) {
    const n = mockCounter;
    const body = Array.from({ length: 6 }, (_, i) =>
      `Абзац ${i + 1}. Это тестовый рассказ номер ${n}, сгенерированный без модели. Герой шёл по улице и думал о теме раунда. ` +
      `Ветер трепал вывески, и где-то далеко играла музыка. Он вспомнил, что забыл нечто важное, но не мог понять, что именно.`).join("\n\n");
    return JSON.stringify({ title: `Тестовый рассказ №${n}`, body });
  }
  if (u.includes("[MOCK:reactions]")) {
    const ids = [...u.matchAll(/story_id=(\d+)/g)].map((m) => Number(m[1]));
    const emojis = ["🔥", "❤️", "🤔", "😴", "👏", "💔"];
    return JSON.stringify({ reactions: ids.map((id) => ({ story_id: id, emoji: emojis[rnd(0, emojis.length - 1)], note: "Заглушка реакции." })) });
  }
  if (u.includes("[MOCK:review]")) {
    return JSON.stringify({
      rating: rnd(3, 9),
      body: filler("Тестовая рецензия (режим без ключа). Сильные стороны: есть ритм, есть образ, точная деталь в первом абзаце. Слабые стороны: финал предсказуем, диалоги не работают, второй абзац повторяет первый. Совет: убрать объяснение чувств и оставить действие. Вывод: текст держится на атмосфере, но структура рыхлая.", 100),
    });
  }
  if (u.includes("[MOCK:meta]")) {
    return JSON.stringify({
      score: rnd(3, 9),
      body: filler("Тестовая мета-оценка. Критик аргументирует, опирается на текст, но местами пересказывает вместо анализа. Совет автору конкретный. Оценка обоснована частично.", 50),
    });
  }
  if (u.includes("[MOCK:rebuttal]")) {
    return JSON.stringify({ body: "Спасибо за разбор. С замечанием о финале не согласен: он открыт намеренно." });
  }
  return JSON.stringify({ text: "mock" });
}
