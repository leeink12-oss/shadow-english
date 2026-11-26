#!/usr/bin/env node
'use strict';

/**
 * 影读英语 · 本地服务
 * 零依赖：只用 Node 内置模块。负责三件事
 *   1) 托管 public 下的静态页面
 *   2) 代理 DeepSeek 调用（Key 只存在本机，不暴露给浏览器）
 *   3) 读写本地 data 目录里的课程 / 生词本 / 配置
 */

const http = require('node:http');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const COURSE_DIR = path.join(DATA, 'courses');
const TRASH_DIR = path.join(DATA, 'trash');
const STORE_FILE = path.join(DATA, 'store.json');
const WORD_FILE = path.join(DATA, 'words.json');
const TTS_DIR = path.join(DATA, 'tts');
const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '127.0.0.1';

const DEFAULT_CONFIG = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
};

// ---------------------------------------------------------------- 存储
for (const dir of [DATA, COURSE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true });

let store = { config: { ...DEFAULT_CONFIG }, courses: [], vocab: [], expressions: [], speaking: [], settings: {} };
let wordCache = {};

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

store = { ...store, ...loadJSON(STORE_FILE, {}) };
store.config = { ...DEFAULT_CONFIG, ...(store.config || {}) };
if (!Array.isArray(store.expressions)) store.expressions = [];
if (!Array.isArray(store.speaking)) store.speaking = [];
wordCache = loadJSON(WORD_FILE, {});

let saveChain = Promise.resolve();
function persist(file, data) {
  saveChain = saveChain
    .then(() => fsp.writeFile(file, JSON.stringify(data, null, 0), 'utf8'))
    .catch((err) => console.error('[save]', file, err.message));
  return saveChain;
}
const saveStore = () => persist(STORE_FILE, store);
const saveWords = () => persist(WORD_FILE, wordCache);

// ---------------------------------------------------------------- 工具
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const TTS_VOICES = new Set([
  'en-US-AvaMultilingualNeural',
  'en-US-JennyNeural',
  'en-US-AndrewMultilingualNeural',
  'en-US-BrianNeural',
  'en-GB-SoniaNeural',
  'en-GB-RyanNeural',
]);

function ttsRate(rate) {
  const value = Math.max(0.7, Math.min(1.3, Number(rate) || 1));
  const percent = Math.round((value - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function ttsText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
}

function synthesizeTTS({ text, voice, rate }) {
  const clean = ttsText(text);
  if (!clean) throw new Error('没有可朗读的内容');
  const voiceName = TTS_VOICES.has(voice) ? voice : 'en-US-AvaMultilingualNeural';
  const speed = ttsRate(rate);
  const key = crypto
    .createHash('sha256')
    .update(`${voiceName}\n${speed}\n${clean}`)
    .digest('hex')
    .slice(0, 32);
  const file = path.join(TTS_DIR, `${key}.mp3`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return Promise.resolve(file);

  const python =
    process.platform === 'win32'
      ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
      : path.join(ROOT, '.venv', 'bin', 'python');
  const bin = fs.existsSync(python) ? python : process.platform === 'win32' ? 'py' : 'python3';
  const tmp = `${file}.${process.pid}.${Date.now()}.part`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      [
        '-m',
        'edge_tts',
        '--voice',
        voiceName,
        '--text',
        clean,
        `--rate=${speed}`,
        '--pitch=+0Hz',
        '--write-media',
        tmp,
      ],
      {
        cwd: ROOT,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      }
    );
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动语音合成：${e.message}`));
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        await fsp.unlink(tmp).catch(() => {});
        reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `语音合成失败（${code}）`));
        return;
      }
      try {
        await fsp.rename(tmp, file);
        resolve(file);
      } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        reject(e);
      }
    });
  });
}

function extractJSON(text) {
  if (!text) throw new Error('AI 返回为空');
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    /* 继续尝试截取 */
  }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(t.slice(s, e + 1));
    } catch {
      /* ignore */
    }
  }
  throw new Error('无法解析 AI 返回的 JSON');
}

// ---------------------------------------------------------------- DeepSeek
async function callAIOnce(messages, opts = {}) {
  const { apiKey, baseUrl, model } = store.config;
  if (!apiKey) {
    const err = new Error('还没有配置 DeepSeek API Key，请点右上角设置填写。');
    err.code = 'NO_KEY';
    throw err;
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload = {
    model: opts._model || opts.model || model || 'deepseek-chat',
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 8000,
    stream: false,
  };
  if (opts.json) payload.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 120000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('AI 请求超时，请重试（或改用更短的片段）');
    throw new Error(`无法连接 DeepSeek：${e.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `DeepSeek 返回 ${res.status}`;
    try {
      const j = JSON.parse(body);
      if (j.error?.message) msg += `：${j.error.message}`;
    } catch {
      if (body) msg += `：${body.slice(0, 200)}`;
    }
    if (res.status === 401) msg = 'API Key 无效，请检查设置里的 Key。';
    if (res.status === 402) msg = '账户余额不足，请到 DeepSeek 平台充值。';
    const err = new Error(msg);
    // 模型名失效（DeepSeek 会淘汰旧模型名，第三方中转也可能不支持新名）
    if ((res.status === 400 || res.status === 404) && /model/i.test(body)) err.code = 'MODEL_UNSUPPORTED';
    throw err;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  // 空响应的典型原因：模型处于思考模式把 max_tokens 全用在推理上，或额度耗尽
  if (!content.trim() && !opts.allowEmpty) {
    const err = new Error(
      '模型返回了空内容。多半是这个模型默认开启「思考模式」把 token 用光了，请在设置里把模型改回 deepseek-chat。'
    );
    err.code = 'EMPTY_CONTENT';
    throw err;
  }
  return content;
}

/**
 * 关于模型名：不要把 deepseek-chat 改成 deepseek-v4-flash。
 * 官方 V4 系列**默认开启思考模式**，content 会被推理过程挤空；
 * 而 deepseek-chat 这个兼容别名明确对应「非思考模式」，正好是这类短任务要的。
 * 所以默认沿用配置名，只在报"模型不存在"时按备选顺序重试。
 */
function modelCandidates(configured) {
  const list = [configured || 'deepseek-chat'];
  for (const alt of ['deepseek-chat', 'deepseek-v4-flash']) {
    if (!list.includes(alt)) list.push(alt);
  }
  return list;
}

async function callAI(messages, opts = {}) {
  const candidates = modelCandidates(opts.model || store.config.model);
  let lastErr;
  for (const name of candidates) {
    try {
      return await callAIOnce(messages, { ...opts, _model: name });
    } catch (e) {
      lastErr = e;
      if (e.code !== 'MODEL_UNSUPPORTED') throw e;
    }
  }
  throw new Error(`模型名不被支持（已尝试 ${candidates.join(' / ')}）：${lastErr.message}`);
}

const SYS_TUTOR =
  '你是一位严谨、专业的英语教学专家，面向以简体中文为母语的中级学习者（CEFR B1–B2）。' +
  '你熟悉语法分析、语用、英美口语习惯与连读弱读。你的解释必须准确、简洁、可直接用于教学，不编造用法。';

// 讲解 / 改写类任务用的角色：职场同事，不是老师
const SYS_COACH =
  '你是一位在跨国公司工作多年、天天用英语开会写邮件的中文母语者，现在带新人提升职场英语。' +
  '你很清楚中国职场人说英语卡在哪：不是语法不懂，而是用词不够地道、语气拿捏不准、场合不匹配。' +
  '你只讲对方还不知道的东西，给的建议必须具体到能直接照搬，不说空话，不编造用法。';

// 讲解内容的版本号：改了 prompt 就 +1，前端据此提示"旧版可更新"
const EXPLAIN_VER = 2;

// 表达分析用的角色：口语教练，不是语法老师
const SYS_ANALYST =
  '你是一位在美国生活工作多年的英语口语教练，专门帮中文母语的人把看得懂变成说得出。' +
  '你的判断标准是实用：一句话值得学，是因为它能在很多真实场合被复用，而不是因为它语法复杂或词汇高级。' +
  '你只教自然的美式英语；遇到英式或其他地区说法会明确标注，不混为一谈。' +
  '你不编造用法，不确定的地方说得保守一些。';

// 表达分析的 schema 版本
const ANALYSIS_VER = 1;

// ---------------------------------------------------------------- AI 任务
const TASKS = {
  /** 批量把英文字幕翻译成中文 */
  async translate(p) {
    const items = p.items || [];
    const list = items.map((it) => `[${it.i}] ${it.en}`).join('\n');
    const raw = await callAI(
      [
        { role: 'system', content: SYS_TUTOR },
        {
          role: 'user',
          content:
            '把下面编号的英文字幕逐条翻译成自然、口语化的简体中文（用于双语字幕）。\n' +
            '要求：逐条对应，不合并、不拆分、不添加解释；保持语气和口语味道；专有名词保留常规译名。\n' +
            `只输出 JSON，格式为 {"items":[{"i":索引,"zh":"译文"}]}，必须覆盖全部 ${items.length} 条。\n\n字幕：\n${list}`,
        },
      ],
      { json: true, temperature: 0.2 }
    );
    const data = extractJSON(raw);
    const map = new Map((data.items || []).map((x) => [Number(x.i), String(x.zh || '').trim()]));
    return { items: items.map((it) => ({ i: it.i, zh: map.get(it.i) || '' })) };
  },

  /** 把被拆断的字幕条目合并成完整句子 */
  async organize(p) {
    const lines = p.items || [];
    const list = lines.map((it) => `[${it.i}] EN: ${it.en}${it.zh ? `\n     ZH: ${it.zh}` : ''}`).join('\n');
    const raw = await callAI(
      [
        { role: 'system', content: SYS_TUTOR },
        {
          role: 'user',
          content:
            '下面是一段英语视频的字幕条目，常被切成半句。请把它们整理成"完整、自然的句子"用于精听教学。\n' +
            '规则：\n' +
            '1. 只做合并与去噪（去掉重复口癖、语气填充碎片），不润色改写、不改语序、不删信息；\n' +
            '2. 每条输出覆盖一段连续的原始条目，from/to 为索引（含两端），所有条目必须被恰好覆盖一次且按顺序连续；\n' +
            '3. 中文字段按合并后的英文重新对齐；只有某一条目是完整的、无需合并时才单独成句；\n' +
            '4. 若某条原本就是不完整的插入语，并入相邻句子，不要单独成句。\n' +
            `只输出 JSON：{"items":[{"from":0,"to":2,"en":"完整英文句","zh":"对应中文"}]}\n\n字幕条目：\n${list}`,
        },
      ],
      { json: true, temperature: 0.1 }
    );
    const data = extractJSON(raw);
    return { items: (data.items || []).filter((x) => x && x.en) };
  },

  /** 句型讲解（职场向） */
  async explain(p) {
    const text = await callAI(
      [
        { role: 'system', content: SYS_COACH },
        {
          role: 'user',
          content:
            '给下面这句英语写一张"实用卡片"，读者是能用英语工作、但表达还不够地道的中文母语职场人（CEFR B2）。\n' +
            '\n' +
            '**只讲他不知道的**：不要拆主谓宾、不要分析状语从句、不要标注"并列句/形式主语"——这些他已经会了，写了就是噪音。\n' +
            '\n' +
            '固定输出 3 条，每条一行，以 "- " 开头，全篇不超过 110 字：\n' +
            '- **能用在哪**：这句话在什么场合能直接用（会议/邮件/客户沟通/同事闲聊/日常口语），一句话点明；如果它只适合生活场景、职场用不上，就明说"职场少用，属于日常口语"。\n' +
            '- **更好的说法**：给一个更地道、或更正式/更委婉的替代表达，并点出关键差别（语气？正式度？对象？）。替代表达要能和原句互换，不要换掉意思。\n' +
            '- **发音**：只标这句里最容易读错的一处（连读 / 弱读 / 重读 / 语调），没有明显特征就写"无特别"。\n' +
            '\n' +
            '只有当这句里有中级学习者**真的会踩的坑**（时态用错会改变意思、固定搭配记错、易混词、中式英语陷阱）时，才追加第 4 条：\n' +
            '- **注意**：一句话说清坑在哪。\n' +
            '\n' +
            '语气像同事在工位上顺口给你讲，不要"我们来看""首先其次"，不要复述译文，不要总结。\n' +
            '用 **粗体** 标出关键表达。\n\n' +
            `句子：${p.en}\n` +
            (p.zh ? `参考译文：${p.zh}\n` : '') +
            (p.prev ? `上一句（语境）：${p.prev}\n` : '') +
            (p.next ? `下一句（语境）：${p.next}\n` : ''),
        },
      ],
      { temperature: 0.4, maxTokens: 500 }
    );
    return { text: text.trim(), v: EXPLAIN_VER };
  },

  /** 单词卡 */
  async word(p) {
    const raw = await callAI(
      [
        { role: 'system', content: SYS_TUTOR },
        {
          role: 'user',
          content:
            '为下面这个单词生成一张学习卡片，优先给出它在给定句子中的含义。\n' +
            `只输出 JSON：{"word":"原形","phonetic":"英式或美式音标，带斜杠","pos":"词性缩写如 n./v./adj.","brief":"12字内中文速记","defs":["词性. 释义","词性. 释义"],"example":"一个地道英文例句","exampleZh":"例句中文","note":"用法或搭配提示，25字内，可空字符串"}\n` +
            '要求：defs 给 1–3 个常用义项，按常用度排序；音标用国际音标；不确定的字段留空字符串但不要编造。\n\n' +
            `单词：${p.word}\n` +
            (p.sentence ? `所在句子：${p.sentence}\n` : ''),
        },
      ],
      { json: true, temperature: 0.2, maxTokens: 700 }
    );
    return extractJSON(raw);
  },

  /** 批量单词速释（逐词模式） */
  async words(p) {
    const words = (p.words || []).slice(0, 60);
    const raw = await callAI(
      [
        { role: 'system', content: SYS_TUTOR },
        {
          role: 'user',
          content:
            '为下列单词各给一个极简中文释义（结合语境，8 字以内，只给最贴切的一个义项）。\n' +
            `只输出 JSON：{"items":[{"w":"单词","b":"中文","pos":"词性缩写"}]}，必须覆盖全部 ${words.length} 个词。\n` +
            (p.sentence ? `语境句：${p.sentence}\n` : '') +
            `\n单词列表：${words.join(', ')}`,
        },
      ],
      { json: true, temperature: 0.1, maxTokens: 3000 }
    );
    const data = extractJSON(raw);
    return { items: data.items || [] };
  },

  /** 挖空点选择 */
  async cloze(p) {
    const raw = await callAI(
      [
        { role: 'system', content: SYS_TUTOR },
        {
          role: 'user',
          content:
            '为下面这个英语句子挑选适合做"听写填空"的词（挖掉后仍有线索可填）。\n' +
            '规则：优先挖实词（名词、动词、形容词、副词、介词短语中的关键词），避开 a/the/is/of 这类功能词；每句 2–4 个；不要挖句首第一个词除非它是核心实词。\n' +
            'words 是句中按顺序排列的单词数组，用它的下标（index）返回。\n' +
            `只输出 JSON：{"blanks":[下标,...]}\n\n` +
            `句子：${p.en}\n` +
            `words: ${JSON.stringify(p.words || [])}`,
        },
      ],
      { json: true, temperature: 0.1, maxTokens: 400 }
    );
    const data = extractJSON(raw);
    const blanks = (data.blanks || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
    return { blanks };
  },

  /** 整句音标 */
  async phonetic(p) {
    const raw = await callAI(
      [
        { role: 'system', content: SYS_TUTOR },
        {
          role: 'user',
          content:
            '给出这句英语的整句国际音标（IPA），体现实际口语中的连读与弱读（可标注弱读形式），用斜杠包裹。\n' +
            '只输出 JSON：{"ipa":"/.../","tips":"一句中文发音提示，20字内"}\n\n' +
            `句子：${p.en}`,
        },
      ],
      { json: true, temperature: 0.2, maxTokens: 500 }
    );
    return extractJSON(raw);
  },

  /* ══════════════════ 表达分析（P0 核心） ══════════════════ */

  /**
   * 第一遍：从整段字幕里挑出值得学的表达块（只挑，不展开）
   * 返回 si = 字幕句序号，由前端回查原句，保证不编造
   */
  async analyze_pick(p) {
    const list = (p.sentences || []).map((s) => `[${s.i}] ${s.en}`).join('\n');
    if (!list) throw new Error('没有可分析的句子');
    const want = Math.max(4, Math.min(10, Number(p.want) || 8));

    const raw = await callAI(
      [
        { role: 'system', content: SYS_ANALYST },
        {
          role: 'user',
          content:
            '下面是一段英语视频的字幕，每行格式是 [序号] 句子。\n' +
            `请挑出 ${want} 条左右最值得学了就能用的表达块（chunks）。\n` +
            '\n' +
            '挑什么：\n' +
            '1. 高频可复用：换掉人/地点/事情还能用（I am craving … / It is worth … / I ended up …）\n' +
            '2. 地道搭配：中国人容易说错或根本说不出来的（on my plate / run errands / get a hold of）\n' +
            '3. 语用技巧：让话说得更得体自然的（委婉拒绝、软化语气、接话、追问）\n' +
            '4. 有价值的生活/文化信息，最多 1 条，value 标 cultural\n' +
            '\n' +
            '不要挑：\n' +
            '- 生僻词、专业术语、人名地名品牌名\n' +
            '- 纯剧情事实（这家店 1987 年开业）\n' +
            '- 只有语法价值、没有复用价值的句子\n' +
            '- 拼写怪、语法不通、明显是语音识别错的句子\n' +
            '\n' +
            '数量与分布：宁可少而精，绝不凑数。尽量覆盖前、中、后段，不要全挤在一起。\n' +
            '\n' +
            '另外先给一句视频概览 summary：\n' +
            '- topic：英文短语，这段视频在讲什么（如 Food and daily life）\n' +
            '- difficulty："beginner" | "intermediate" | "advanced"（按语速、用词、句式综合判断）\n' +
            '- accent：主要口音（一般写 "American English"；明显不是美音就如实写）\n' +
            '\n' +
            '每条输出：\n' +
            '- si：句子序号（必须是给定序号之一，不是行号）\n' +
            '- core：核心表达块，用 … 表示可替换部分（例："I am craving …"）；整句是固定说法就写整句\n' +
            '- meaning：这个表达块的中文意思，10 字内\n' +
            '- value："high" | "mid" | "cultural"\n' +
            '- why：一句话说清什么场合能用，20 字内\n' +
            '\n' +
            '只输出 JSON：{"summary":{"topic":"","difficulty":"intermediate","accent":"American English"},' +
            '"picks":[{"si":12,"core":"...","meaning":"...","value":"high","why":"..."}]}\n\n' +
            `字幕：\n${list}`,
        },
      ],
      { json: true, temperature: 0.3, maxTokens: 2500, timeout: 180000 }
    );
    const data = extractJSON(raw);
    const picks = (data.picks || [])
      .filter((x) => x && Number.isInteger(Number(x.si)) && String(x.core || '').trim())
      .map((x) => ({
        si: Number(x.si),
        core: String(x.core).trim().slice(0, 120),
        meaning: String(x.meaning || '').trim().slice(0, 60),
        value: ['high', 'mid', 'cultural'].includes(x.value) ? x.value : 'mid',
        why: String(x.why || '').trim().slice(0, 80),
      }));
    return { summary: normalizeSummary(data.summary), picks, v: ANALYSIS_VER };
  },

  /** 第二遍：把单条表达展开成 场景 / 替换 / 对话 / 练习 */
  async analyze_expand(p) {
    const raw = await callAI(
      [
        { role: 'system', content: SYS_ANALYST },
        {
          role: 'user',
          content:
            '围绕一个英语表达块，为中文母语的中级学习者（能读能写，说的时候会卡）准备一份能直接用的材料。\n' +
            '\n' +
            `视频原句（不要改写它）：${p.en}\n` +
            `核心表达块：${p.core}\n` +
            (p.meaning ? `中文意思：${p.meaning}\n` : '') +
            (p.prev ? `上一句（语境）：${p.prev}\n` : '') +
            (p.next ? `下一句（语境）：${p.next}\n` : '') +
            (p.topic ? `视频主题：${p.topic}\n` : '') +
            '\n' +
            '输出四部分：\n' +
            '\n' +
            '1. usage —— 使用场景\n' +
            '   context：什么场合用（如 朋友闲聊 / 跟同事商量 / 跟客户沟通）\n' +
            '   register："casual" | "neutral" | "polite" | "formal"\n' +
            '   people：通常对谁说（朋友 / 同事 / 上级 / 客户 / 陌生人）\n' +
            '   explanation：一句话说清这个表达的语感，15–30 字\n' +
            '\n' +
            '2. alternatives —— 2 到 4 个能互换的美式说法\n' +
            '   必须能替换原表达而不改变意思；每个用 difference 说清语气或场合差别（15 字内）\n' +
            '   不要同义词词典式罗列，要讲清楚一个人为什么会换个说法\n' +
            '\n' +
            '3. dialogues —— 2 到 3 组对话，把这个表达迁移到不同场景\n' +
            '   每组 4–6 行，两个说话人；必须像美国人真的会说的话（可以有 yeah / well / I mean，可以省略主语），不要教科书腔\n' +
            '   必须有回应、追问或补充信息，不能一问一答就结束\n' +
            '   每组换一个场景，不要复述视频剧情；scenario 用中文写清场景\n' +
            '\n' +
            '4. practice —— 三个让学习者自己说的任务（只给中文提示，不给答案、不给模板）\n' +
            '   substitution：换掉原句里的人/事/地点，说一句自己的\n' +
            '   scenarioResponse：给一个具体情境，让他自己组织回答\n' +
            '   freeExpression：让他讲自己的经历或观点\n' +
            '\n' +
            '只输出 JSON：\n' +
            '{"usage":{"context":"","register":"casual","people":"","explanation":""},' +
            '"alternatives":[{"expression":"","meaning":"","difference":""}],' +
            '"dialogues":[{"scenario":"","lines":[{"speaker":"A","text":""}]}],' +
            '"practice":{"substitution":"","scenarioResponse":"","freeExpression":""}}',
        },
      ],
      { json: true, temperature: 0.6, maxTokens: 3000, timeout: 180000 }
    );
    return normalizeExpand(extractJSON(raw));
  },

  /* ══════════════════ 口语输出评价 ══════════════════ */

  /** 对一次用户的输出做 5 维评价 + 改写 + 追问 */
  async coach(p) {
    const raw = await callAI(
      [
        { role: 'system', content: SYS_ANALYST },
        {
          role: 'user',
          content:
            '用户在做口语输出练习。请评价他刚才的表达。目标是帮他下一次能说出来，不是给他打分排名。\n' +
            '\n' +
            `练习要求 / 情境：${p.prompt || ''}\n` +
            (p.target ? `希望他用上的表达：${p.target}\n` : '') +
            (p.context ? `背景：${p.context}\n` : '') +
            `他的回答：${p.answer || ''}\n` +
            '\n' +
            '评分（1–5 的整数）：\n' +
            'grammar 语法准确性 / naturalness 是否像美国人会说的话 / fluency 组织语言的顺畅度 / relevance 是否真的回应了要求 / conversation 能否接话、补充信息、延续（只答一句就停给 3 分以下）\n' +
            '\n' +
            '铁律：\n' +
            '1. 只指出 2–3 个最影响沟通的问题，不要把他所有错都列出来。\n' +
            '2. 优先指出"美国人不会这么说"和"信息不完整"，其次才是语法。\n' +
            '3. 同一个错误只说一次。不要换个说法把同一个毛病再列一遍。\n' +
            '4. 每个问题给：他的原话 original → 问题 problem（一句话，只说错在哪，不要把正确说法塞进 problem）→ 更自然的说法 better → 为什么 why（一句话）。\n' +
            '4. 不要夸，不要客套，不要"总体来说不错"这类空话。\n' +
            '5. rewrite：保留他的意思，给出完整重写版，说得更像美国人。\n' +
            '6. followUp：一个追问，逼他补充信息或再说一句。\n' +
            '\n' +
            '只输出 JSON：{"scores":{"grammar":3,"naturalness":2,"fluency":3,"relevance":4,"conversation":2},' +
            '"issues":[{"original":"","problem":"","better":"","why":""}],"rewrite":"","followUp":""}',
        },
      ],
      { json: true, temperature: 0.4, maxTokens: 1600, timeout: 120000 }
    );
    return normalizeCoach(extractJSON(raw));
  },

  /** 口语实战：扮演对话对象，回一句话 */
  async chat(p) {
    const history = (p.messages || []).slice(-24);
    const lines = history
      .map((m) => `${m.role === 'user' ? '用户' : '你'}：${String(m.content || '').slice(0, 600)}`)
      .join('\n');

    const raw = await callAI(
      [
        { role: 'system', content: SYS_ANALYST },
        {
          role: 'user',
          content:
            '你在扮演一个真实的人，跟用户做英语对话练习。\n' +
            '\n' +
            `场景：${p.scenario || ''}\n` +
            `你的角色：${p.role || '一个普通的美国人'}\n` +
            `用户水平：中级，能表达基本意思，但会卡、会说得不自然\n` +
            '\n' +
            '规则（最重要）：\n' +
            '1. 你是在聊天，不是在考试。绝不出题、不要求造句、不给标准答案、不纠正语法。\n' +
            '2. 每次回复 1–3 句，像真人说话，可以有 yeah / hmm / oh / well 这类口语反应。\n' +
            '3. 必须先接住用户说的内容（同意/惊讶/追问细节），再自然带出下一句。\n' +
            '4. 不要每轮换话题。一个话题聊 4–6 轮，聊透了再自然过渡。\n' +
            '5. 可以主动分享自己的信息（Oh nice, I have been meaning to try that place），让对话是双向的。\n' +
            '6. 用户答得很短或答非所问时，先用一句自己的信息垫一下（I am in marketing, by the way），再问一个更具体的问题，不要纠正他。\n' +
            '7. 不要重复问过的问题。同一个问题问过一次对方没答上来，就换个角度问细节，别把原话再问一遍。\n' +
            '8. 用户用中文，就用英文自然地请他再说一遍英文。\n' +
            '9. 难度随他表现调整：说得顺就追问原因、让他讲细节；说得吃力就放慢、给更具体的问题。\n' +
            '10. 不评价他的英语，不说 good job。你只是聊天对象。\n' +
            '11. 回复必须是完整、连贯、适合直接朗读的句子，标点清楚；不要复述识别错误的碎片，也不要连续堆叠没有主语的短语。\n' +
            '12. 如果用户的转写内容明显混乱，先用一句自然的话确认意思，再继续对话，不要模仿或原样重复错误文本。\n' +
            '\n' +
            `对话记录：\n${lines || '（还没开始）'}\n` +
            '\n' +
            '只输出 JSON：{"reply":"你的下一句话"}',
        },
      ],
      { json: true, temperature: 0.85, maxTokens: 400, timeout: 90000 }
    );
    const data = extractJSON(raw);
    return { reply: String(data.reply || '').trim() };
  },

  /** 口语实战：结束后的复盘（含 Conversation Flow） */
  async chat_review(p) {
    const lines = (p.messages || [])
      .map((m) => `${m.role === 'user' ? '用户' : '对方'}：${m.content}`)
      .join('\n');
    const userTurns = (p.messages || []).filter((m) => m.role === 'user').length;

    const raw = await callAI(
      [
        { role: 'system', content: SYS_ANALYST },
        {
          role: 'user',
          content:
            '下面是用户和场景对方的一段英语对话练习，请复盘他的表现。\n' +
            '\n' +
            `场景：${p.scenario || ''}\n` +
            `用户发言轮数：${userTurns}\n` +
            `对话记录：\n${lines}\n` +
            '\n' +
            '一、5 维评分（1–5 整数）：grammar / naturalness / fluency / relevance / conversation\n' +
            '\n' +
            '二、Conversation Flow（这部分最重要，权重高于语法）：\n' +
            'respond 是否准确回应对方 / expand 是否主动补充额外信息 / ask 是否主动追问 / link 是否自然承接话题 / sustain 是否让对话能继续\n' +
            '每项给 level（"good" | "ok" | "weak"）+ note（一句中文说明，要具体到他的原话）\n' +
            '\n' +
            '三、问题清单：只挑 2–3 个最影响沟通的，给 original / problem / better / why\n' +
            '\n' +
            '四、nextTime：一句话说清下次最该注意什么（不要泛泛而谈）\n' +
            '\n' +
            '不要只数语法错误。答得短、只回答不追问、话题接不上，这些比语法错误更值得说。\n' +
            '\n' +
            '只输出 JSON：{"scores":{"grammar":3,"naturalness":3,"fluency":3,"relevance":3,"conversation":3},' +
            '"flow":{"respond":{"level":"ok","note":""},"expand":{"level":"ok","note":""},"ask":{"level":"ok","note":""},' +
            '"link":{"level":"ok","note":""},"sustain":{"level":"ok","note":""}},' +
            '"issues":[{"original":"","problem":"","better":"","why":""}],"nextTime":""}',
        },
      ],
      { json: true, temperature: 0.3, maxTokens: 2000, timeout: 150000 }
    );
    return normalizeReview(extractJSON(raw));
  },
};

/* ─────────────── 结构化结果清洗（字段缺失时前端能降级） ─────────────── */
const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function normalizeSummary(s) {
  return {
    topic: str(s?.topic, 60),
    difficulty: ['beginner', 'intermediate', 'advanced'].includes(s?.difficulty) ? s.difficulty : 'intermediate',
    accent: str(s?.accent, 40) || 'American English',
  };
}

function normalizeExpand(d) {
  const usage = d?.usage || {};
  const alts = (Array.isArray(d?.alternatives) ? d.alternatives : [])
    .map((a) => ({ expression: str(a?.expression, 160), meaning: str(a?.meaning, 80), difference: str(a?.difference, 120), generated_example: true }))
    .filter((a) => a.expression)
    .slice(0, 4);
  const dialogues = (Array.isArray(d?.dialogues) ? d.dialogues : [])
    .map((g) => ({
      scenario: str(g?.scenario, 60),
      generated_example: true,
      lines: (Array.isArray(g?.lines) ? g.lines : [])
        .map((l) => ({ speaker: str(l?.speaker, 4) || 'A', text: str(l?.text, 400) }))
        .filter((l) => l.text)
        .slice(0, 8),
    }))
    .filter((g) => g.lines.length >= 2)
    .slice(0, 3);
  const practice = d?.practice || {};
  return {
    usage: {
      context: str(usage.context, 60),
      register: ['casual', 'neutral', 'polite', 'formal'].includes(usage.register) ? usage.register : 'neutral',
      people: str(usage.people, 60),
      explanation: str(usage.explanation, 200),
    },
    alternatives: alts,
    dialogues,
    practice: {
      substitution: str(practice.substitution, 200),
      scenarioResponse: str(practice.scenarioResponse, 200),
      freeExpression: str(practice.freeExpression, 200),
    },
    v: ANALYSIS_VER,
  };
}

function normalizeScores(s) {
  const out = {};
  for (const k of ['grammar', 'naturalness', 'fluency', 'relevance', 'conversation']) {
    const n = Math.round(Number(s?.[k]));
    out[k] = Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 3;
  }
  return out;
}

function normalizeIssues(list) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const one = {
      original: str(x?.original, 300),
      problem: str(x?.problem, 200),
      better: str(x?.better, 300),
      why: str(x?.why, 200),
    };
    if (!one.problem && !one.better) continue;
    // 同一个错误被 AI 说了两遍时只留第一条
    const key = (one.original || one.better).toLowerCase().replace(/[^a-z ]/g, '');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(one);
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeCoach(d) {
  return {
    scores: normalizeScores(d?.scores),
    issues: normalizeIssues(d?.issues),
    rewrite: str(d?.rewrite, 600),
    followUp: str(d?.followUp, 200),
  };
}

function normalizeReview(d) {
  const flow = {};
  for (const k of ['respond', 'expand', 'ask', 'link', 'sustain']) {
    const v = d?.flow?.[k] || {};
    flow[k] = { level: ['good', 'ok', 'weak'].includes(v.level) ? v.level : 'ok', note: str(v.note, 120) };
  }
  return {
    scores: normalizeScores(d?.scores),
    flow,
    issues: normalizeIssues(d?.issues),
    nextTime: str(d?.nextTime, 200),
  };
}

// ---------------------------------------------------------------- 路由
const asr = require('./asr/service')({ root: ROOT, dataDir: DATA, sendJSON });

async function handleAPI(req, res, url) {
  const p = url.pathname;

  // 本地语音识别（视频 → 字幕）
  if (p.startsWith('/api/asr/')) return asr.handle(req, res, url);

  if (p === '/api/config' && req.method === 'GET') {
    return sendJSON(res, 200, {
      hasKey: Boolean(store.config.apiKey),
      keyPreview: store.config.apiKey ? store.config.apiKey.slice(0, 6) + '••••' + store.config.apiKey.slice(-4) : '',
      baseUrl: store.config.baseUrl,
      model: store.config.model,
      settings: store.settings || {},
    });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.apiKey === 'string') store.config.apiKey = body.apiKey.trim();
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) store.config.baseUrl = body.baseUrl.trim();
    if (typeof body.model === 'string' && body.model.trim()) store.config.model = body.model.trim();
    if (body.settings && typeof body.settings === 'object') store.settings = { ...store.settings, ...body.settings };
    await saveStore();
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/ai' && req.method === 'POST') {
    const body = await readBody(req);
    const task = TASKS[body.task];
    if (!task) return sendJSON(res, 400, { ok: false, error: '未知任务' });
    try {
      const data = await task(body.payload || {});
      return sendJSON(res, 200, { ok: true, data });
    } catch (e) {
      console.error('[ai]', body.task, e.message);
      return sendJSON(res, 200, { ok: false, error: e.message, code: e.code });
    }
  }

  // 自然语音朗读：Edge Neural TTS，失败时前端会自动回退到浏览器语音。
  if (p === '/api/tts' && req.method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    try {
      const file = await synthesizeTTS(body);
      const stat = await fsp.stat(file);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=86400',
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error('[tts]', e.message);
      return sendJSON(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  if (p === '/api/words' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const hits = q ? Object.keys(wordCache).filter((k) => k.includes(q)).slice(0, 30) : [];
    return sendJSON(res, 200, { ok: true, cache: q ? Object.fromEntries(hits.map((k) => [k, wordCache[k]])) : {}, count: Object.keys(wordCache).length });
  }

  if (p === '/api/words' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.cache && typeof body.cache === 'object') {
      Object.assign(wordCache, body.cache);
      saveWords();
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/vocab' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, items: store.vocab });
  }

  if (p === '/api/vocab' && req.method === 'POST') {
    const body = await readBody(req);
    store.vocab = Array.isArray(body.items) ? body.items : store.vocab;
    await saveStore();
    return sendJSON(res, 200, { ok: true, count: store.vocab.length });
  }

  if (p === '/api/courses' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, items: store.courses });
  }

  if (p === '/api/courses' && req.method === 'POST') {
    const course = await readBody(req);
    if (!course || !course.id || !Array.isArray(course.sentences)) {
      return sendJSON(res, 400, { ok: false, error: '课程数据不完整' });
    }
    await fsp.writeFile(path.join(COURSE_DIR, `${course.id}.json`), JSON.stringify(course), 'utf8');
    const meta = {
      id: course.id,
      title: course.title,
      videoName: course.videoName || '',
      count: course.sentences.length,
      duration: course.duration || 0,
      createdAt: course.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    const idx = store.courses.findIndex((c) => c.id === course.id);
    if (idx >= 0) store.courses[idx] = meta;
    else store.courses.unshift(meta);
    await saveStore();
    return sendJSON(res, 200, { ok: true, meta });
  }

  if (p.startsWith('/api/courses/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/courses/'.length)).replace(/\.json$/, '');
    try {
      const raw = await fsp.readFile(path.join(COURSE_DIR, `${id}.json`), 'utf8');
      return sendJSON(res, 200, { ok: true, course: JSON.parse(raw) });
    } catch {
      return sendJSON(res, 404, { ok: false, error: '课程不存在' });
    }
  }

  if (p.startsWith('/api/courses/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/courses/'.length)).replace(/\.json$/, '');
    // 不直接删文件：挪进 data/trash/，误删了还能捞回来
    const src = path.join(COURSE_DIR, `${id}.json`);
    try {
      await fsp.mkdir(TRASH_DIR, { recursive: true });
      await fsp.rename(src, path.join(TRASH_DIR, `${id}-${Date.now()}.json`));
      // 回收站只留最近 50 个，避免长期堆积
      const olds = (await fsp.readdir(TRASH_DIR)).filter((f) => f.endsWith('.json')).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - 50))) {
        await fsp.unlink(path.join(TRASH_DIR, f)).catch(() => {});
      }
    } catch {
      /* 原文件不存在也无所谓，继续把索引清掉 */
    }
    store.courses = store.courses.filter((c) => c.id !== id);
    await saveStore();
    return sendJSON(res, 200, { ok: true });
  }

  /* ───────── 个人表达库（收藏的是完整表达，不是单词） ───────── */
  if (p === '/api/expressions' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, items: store.expressions });
  }

  if (p === '/api/expressions' && req.method === 'POST') {
    const body = await readBody(req);
    if (Array.isArray(body.items)) {
      store.expressions = body.items.slice(0, 2000);
    } else if (body.item && body.item.id) {
      const idx = store.expressions.findIndex((x) => x.id === body.item.id);
      if (idx >= 0) store.expressions[idx] = { ...store.expressions[idx], ...body.item };
      else store.expressions.unshift(body.item);
    }
    await saveStore();
    return sendJSON(res, 200, { ok: true, count: store.expressions.length });
  }

  if (p.startsWith('/api/expressions/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/expressions/'.length));
    store.expressions = store.expressions.filter((x) => x.id !== id);
    await saveStore();
    return sendJSON(res, 200, { ok: true });
  }

  /* ───────── 口语实战记录 ───────── */
  if (p === '/api/speaking' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, items: store.speaking });
  }

  if (p === '/api/speaking' && req.method === 'POST') {
    const body = await readBody(req);
    if (Array.isArray(body.items)) {
      store.speaking = body.items.slice(0, 30);
    } else if (body.item && body.item.id) {
      const idx = store.speaking.findIndex((x) => x.id === body.item.id);
      if (idx >= 0) store.speaking[idx] = body.item;
      else store.speaking.unshift(body.item);
      store.speaking = store.speaking.slice(0, 30);
    }
    await saveStore();
    return sendJSON(res, 200, { ok: true });
  }

  if (p.startsWith('/api/speaking/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/speaking/'.length));
    store.speaking = store.speaking.filter((x) => x.id !== id);
    await saveStore();
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { ok: false, error: 'not found' });
}

// ---------------------------------------------------------------- 静态
async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, pathname));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) throw new Error('dir');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const isAPI = url.pathname.startsWith('/api/');
  (isAPI ? handleAPI(req, res, url) : serveStatic(req, res, url)).catch((err) => {
    console.error('[server]', err);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: err.message });
    else res.end();
  });
});

/* ══════════ 打开浏览器 / 端口占用处理 ══════════ */

const APP_URL = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
// 双击 bat 就自动开浏览器；加 --no-open 可关闭
const AUTO_OPEN = !process.argv.includes('--no-open') && process.env.NO_OPEN !== '1';

function openBrowser(url) {
  try {
    const { spawn } = require('node:child_process');
    const opts = { detached: true, stdio: 'ignore', windowsHide: true };
    if (process.platform === 'win32') {
      // start 是 cmd 内部命令，必须经 cmd /c 调用
      spawn('cmd', ['/c', 'start', '', url], opts).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], opts).unref();
    } else {
      spawn('xdg-open', [url], opts).unref();
    }
    return true;
  } catch {
    return false;
  }
}

// 探测端口上跑的是不是本程序
function pingSelf() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/config', timeout: 1200 },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(Object.prototype.hasOwnProperty.call(JSON.parse(body), 'hasKey'));
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('\n  [!] 服务启动失败：', err.message, '\n');
    setTimeout(() => process.exit(1), 300);
    return;
  }
  const isMine = await pingSelf();
  const line = '─'.repeat(48);
  console.log(`\n  ${line}`);
  if (isMine) {
    // 之前的窗口还在跑 —— 不报错，直接把浏览器打开
    console.log('   影读英语已经在运行了（端口 ' + PORT + '）');
    console.log(AUTO_OPEN ? '   正在打开浏览器，无需重复启动' : '   无需重复启动');
    console.log(`   ${line}`);
    console.log(`   访问地址：${APP_URL}`);
    console.log(`  ${line}\n   这个窗口可以直接关掉\n`);
    if (AUTO_OPEN) openBrowser(APP_URL);
    setTimeout(() => process.exit(0), 1500);
  } else {
    console.log(`   [!] 端口 ${PORT} 被其他程序占用了`);
    console.log(`   ${line}`);
    console.log('   解决办法（任选一个）：');
    console.log(`     1) 关掉占用端口的程序后重新双击启动`);
    console.log(`     2) 换端口启动：在窗口里执行  set PORT=5179 再执行 node server.js`);
    console.log(`   ${line}\n`);
    console.log(`   ${line}\n`);
    setTimeout(() => process.exit(1), 600);
  }
});

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(48);
  console.log(`\n  ${line}`);
  console.log('   影读英语 Shadow English  ·  本地已启动');
  console.log(`   ${line}`);
  console.log(`   打开浏览器访问：  ${APP_URL}`);
  if (!store.config.apiKey) console.log('   提示：尚未配置 DeepSeek Key，进页面后点右上角 ⚙ 填写');
  console.log('   数据目录：', DATA);
  console.log(`  ${line}\n   关闭本窗口即停止服务`);

  if (HOST === '0.0.0.0') {
    try {
      const nets = os.networkInterfaces();
      const lan = Object.values(nets)
        .flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal)
        .map((n) => n.address);
      if (lan.length) console.log('   同一 Wi-Fi 下的手机/平板可用：' + lan.map((ip) => `http://${ip}:${PORT}`).join('  '));
    } catch {
      /* ignore */
    }
  }
  console.log('');
  if (AUTO_OPEN) setTimeout(() => openBrowser(APP_URL), 500);
});
