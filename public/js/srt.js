// 字幕解析：支持 SRT / VTT，自动处理 UTF-8 / GBK / UTF-16 编码与双语字幕

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/;
const LATIN = /[A-Za-z]/;

/** 从 ArrayBuffer 解码文本，尽量不出现乱码 */
export function decodeBuffer(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length > 1) {
    if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
    if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  }
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > 3 && bad / Math.max(1, utf8.length) > 0.001) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      /* 浏览器不支持 gbk 时退回 utf-8 */
    }
  }
  return utf8.replace(/^\uFEFF/, '');
}

function toSec(t) {
  const m = String(t)
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (h ? +h * 3600 : 0) + +mm * 60 + +ss + Number(`0.${ms}`);
}

function cleanText(s) {
  return s
    .replace(/\{[^}]*\}/g, '')          // ASS 样式标签 {\an8}
    .replace(/<[^>]+>/g, '')            // HTML 标签
    .replace(/^\s*[-–—]\s*/, '')        // 对话破折号
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOISE = /^(?:[\(\[]?\s*(?:music|applause|laughter|inaudible|silence|laughs?|sighs?)\s*[\)\]]?|♪+|\.+|,…)$/i;

/**
 * 解析字幕文本
 * @returns {{entries: Array<{start:number,end:number,en:string,zh:string}>, hasZh:boolean, warn:string}}
 */
export function parseSubtitles(text) {
  const normalized = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const entries = [];
  let hasZh = false;
  let skippedNoise = 0;

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (!lines.length) continue;
    const tIdx = lines.findIndex((l) => l.includes('-->'));
    if (tIdx < 0) continue; // NOTE / STYLE / WEBVTT 头
    const [rawA, rawB] = lines[tIdx].split('-->');
    const start = toSec(rawA);
    const end = toSec((rawB || '').trim().split(/\s+/)[0]);
    if (start == null || end == null || end <= start) continue;

    const body = lines
      .slice(tIdx + 1)
      .map(cleanText)
      .filter((s) => s.length > 0);
    if (!body.length) continue;

    // 拆双语：中文行 / 英文行
    const zhLines = [];
    const enLines = [];
    for (const line of body) {
      const cjkCount = (line.match(new RegExp(CJK, 'g')) || []).length;
      const latinCount = (line.match(/[A-Za-z]/g) || []).length;
      if (cjkCount > 0 && cjkCount >= latinCount) zhLines.push(line);
      else if (latinCount > 0) enLines.push(line);
      else zhLines.push(line);
    }
    const en = enLines.join(' ').trim();
    const zh = zhLines.join(' ').trim();
    if (!en && !zh) continue;
    if (NOISE.test(en) || NOISE.test(zh)) {
      skippedNoise++;
      continue;
    }
    if (zh) hasZh = true;

    const prev = entries[entries.length - 1];
    // 完全重复的连续条目（滚动字幕常见）直接跳过
    if (prev && prev.en === en && prev.zh === zh && start - prev.end < 0.2) {
      prev.end = end;
      continue;
    }
    entries.push({ start, end, en, zh });
  }

  entries.sort((a, b) => a.start - b.start);
  entries.forEach((e, i) => (e.i = i));

  let warn = '';
  const withEn = entries.filter((e) => e.en).length;
  if (!entries.length) warn = '没有解析出任何字幕条目，请确认文件是 SRT/VTT 格式。';
  else if (withEn < entries.length * 0.4) warn = '这个字幕里英文很少，可能是纯中文字幕，建议换一份英文字幕。';
  if (skippedNoise > 0 && !warn) warn = `已自动跳过 ${skippedNoise} 条音效/音乐标记。`;

  return { entries, hasZh, warn };
}

/** 规则兜底：把过短的碎片条目并到相邻条目（AI 整理失败时使用） */
export function mergeFragments(entries) {
  const out = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    const endsSentence = /[.!?…"'”’)\]]\s*$/.test(e.en || '');
    const tooShort = e.end - e.start < 0.55;
    if (last && last.en && !/[.!?…"'”’)\]]\s*$/.test(last.en) && (e.start - last.end < 0.35 || tooShort) && last.en.length + (e.en || '').length < 160) {
      last.en = `${last.en} ${e.en || ''}`.trim();
      last.zh = `${last.zh}${e.zh}`.trim();
      last.end = e.end;
      if (endsSentence) continue;
    } else {
      out.push({ ...e });
    }
  }
  out.forEach((e, i) => (e.i = i));
  return out;
}
