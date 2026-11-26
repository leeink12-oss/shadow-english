// 与本地后端通信 + AI 任务封装 + 本地词库缓存
import { chunk, sleep } from './util.js';

const J = { 'Content-Type': 'application/json' };

async function req(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

export const getJSON = (url) => req(url);
export const postJSON = (url, body) => req(url, { method: 'POST', headers: J, body: JSON.stringify(body) });
export const delJSON = (url) => req(url, { method: 'DELETE' });

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 调后端 AI 任务，失败自动重试一次 */
export async function ai(task, payload, { retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await postJSON('/api/ai', { task, payload });
      if (!res.ok) {
        const err = new Error(res.error || 'AI 调用失败');
        err.code = res.code;
        throw err;
      }
      return res.data;
    } catch (e) {
      lastErr = e;
      if (e.code === 'NO_KEY') throw e;
      if (attempt < retries) await sleep(900);
    }
  }
  throw lastErr;
}

/* ─────────────── 词库缓存（本地 + 后端持久化） ─────────────── */
let wordCache = {};
const dirty = new Set();

export async function loadWordCache() {
  try {
    const res = await getJSON('/api/words');
    wordCache = res.cache || {};
  } catch {
    wordCache = {};
  }
  return wordCache;
}

export const normKey = (w) => String(w || '').toLowerCase().replace(/[^a-z'-]/g, '');

export function getCachedWord(word) {
  return wordCache[normKey(word)] || null;
}

export function setCachedWord(word, data) {
  const k = normKey(word);
  if (!k) return;
  wordCache[k] = { ...(wordCache[k] || {}), ...data };
  dirty.add(k);
  flushWordsSoon();
}

let flushTimer;
function flushWordsSoon() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushWords, 2500);
}

export async function flushWords() {
  if (!dirty.size) return;
  const payload = {};
  for (const k of dirty) payload[k] = wordCache[k];
  dirty.clear();
  try {
    await postJSON('/api/words', { cache: payload });
  } catch {
    /* 静默失败，下次再说 */
  }
}

/* ─────────────── 具体任务 ─────────────── */
export async function translateSentences(sentences, onProgress) {
  const todo = sentences.filter((s) => !s.zh);
  if (!todo.length) return;
  const batches = chunk(todo, 30);
  let done = 0;
  await mapLimit(batches, 3, async (batch) => {
    const data = await ai('translate', { items: batch.map((s) => ({ i: s.i, en: s.en })) });
    for (const it of data.items || []) {
      const target = sentences[it.i];
      if (target && it.zh) target.zh = it.zh;
    }
    done += batch.length;
    onProgress?.(done, todo.length);
  });
}

export async function organizeLines(entries, onProgress) {
  const batches = chunk(entries, 100);
  const merged = [];
  let done = 0;
  for (const batch of batches) {
    const base = batch[0].i;
    let items = [];
    try {
      const data = await ai('organize', {
        items: batch.map((e) => ({ i: e.i, en: e.en, zh: e.zh })),
      });
      items = (data.items || []).filter(
        (x) => x && x.en && Number.isFinite(+x.from) && Number.isFinite(+x.to)
      );
    } catch {
      items = [];
    }
    // 把 AI 返回的索引区间换算到批内下标
    const ranges = items
      .map((it) => ({
        from: Math.max(0, +it.from - base),
        to: Math.min(batch.length - 1, +it.to - base),
        en: String(it.en).trim(),
        zh: String(it.zh || '').trim(),
      }))
      .filter((r) => r.to >= r.from)
      .sort((a, b) => a.from - b.from);

    const byFrom = new Map();
    for (const r of ranges) if (!byFrom.has(r.from)) byFrom.set(r.from, r);

    // 严格顺序遍历，未被 AI 覆盖的条目原样补上，保证不丢句子
    let cursor = 0;
    while (cursor < batch.length) {
      const r = byFrom.get(cursor);
      if (r && r.to >= cursor) {
        const a = batch[r.from];
        const b = batch[r.to] || a;
        merged.push({ start: a.start, end: b.end, en: r.en, zh: r.zh });
        cursor = r.to + 1;
      } else {
        const e = batch[cursor];
        merged.push({ start: e.start, end: e.end, en: e.en || '', zh: e.zh || '' });
        cursor++;
      }
    }
    done += batch.length;
    onProgress?.(done, entries.length);
  }
  const cleaned = merged.filter((e) => e.en);
  cleaned.forEach((e, i) => (e.i = i));
  return cleaned;
}

export const explainSentence = (s, ctx = {}) =>
  ai('explain', { en: s.en, zh: s.zh || '', prev: ctx.prev || '', next: ctx.next || '' }, { retries: 0 });

export const wordCard = (word, sentence) => ai('word', { word, sentence: sentence || '' }, { retries: 0 });

export const wordGlosses = (words, sentence) => ai('words', { words, sentence });

export const clozeBlanks = (en, words) => ai('cloze', { en, words });

export const sentenceIpa = (en) => ai('phonetic', { en });

/* ─────────────── 表达分析 / 口语评价 ─────────────── */

/** 第一遍：从字幕里挑表达（返回 si 序号，由前端回查原句） */
export const analyzePick = (sentences, want = 8) => ai('analyze_pick', { sentences, want }, { retries: 0 });

/** 第二遍：展开单条表达（场景 / 替换 / 对话 / 练习） */
export const analyzeExpand = (payload) => ai('analyze_expand', payload, { retries: 1 });

/** 口语输出评价：5 维 + 改写 + 追问 */
export const coachAnswer = (payload) => ai('coach', payload, { retries: 0 });

/** 口语实战：对方回一句话 */
export const chatReply = (payload) => ai('chat', payload, { retries: 1 });

/** 口语实战：整段复盘 */
export const chatReview = (payload) => ai('chat_review', payload, { retries: 0 });
