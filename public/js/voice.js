// 语音输入 + 跟读评分
//
// 三件事：
// 1. Mic            —— 录音，带静音自动停止（说完自己停，不用手点）
// 2. transcribeClip —— 交给本地 faster-whisper 常驻进程，返回文字 + 词级置信度
// 3. scoreShadow    —— 把"机器听到的"和"原句"对齐，算出可听懂度分数
//
// 为什么用 whisper 的置信度当发音分：
// 它衡量的是「这个音机器能不能听清」，也就是「别人能不能听懂你」。
// 这是职场口语真正关心的指标，而且完全本地、不花钱。
// 它不评判口音是否好听，也不做音素级打分——这一点在界面上要说清楚。
import { el } from './util.js';

/* ═══════════════ 录音 ═══════════════ */

export const canRecord = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/** 不能录音时给出具体原因（手机通过局域网 http 打开时最常见的是"不是安全环境"） */
export function recordBlockedHint() {
  if (!window.isSecureContext) return '录音需要安全环境：本机用 http://127.0.0.1 打开，手机通过局域网 IP 打开时浏览器会禁用麦克风';
  if (!navigator.mediaDevices?.getUserMedia) return '这个浏览器不支持录音，用 Chrome 或 Edge 打开';
  if (!window.MediaRecorder) return '这个浏览器缺少录音组件，用 Chrome 或 Edge 打开';
  return '';
}

/** 录到了但没识别出来时，区分"根本没录到"和"录到了机器没听懂" */
export function quietNote(stats = {}) {
  const loud = Math.round((Number(stats.peak) || 0) * 100);
  const secs = ((Number(stats.ms) || 0) / 1000).toFixed(1);
  if (loud < 10) return `几乎没录到声音（峰值 ${loud}%）——看看系统里选的麦克风对不对`;
  if (!Number(stats.ms)) return '没听清，再说一次';
  return `录到了 ${secs} 秒（峰值 ${loud}%），但没听出词——凑近点、说慢一点`;
}

export class Mic {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.timer = 0;
    this.ctx = null;
    this.analyser = null;
    this.raf = 0;
  }

  async ensure() {
    if (this.stream?.active) return this.stream;
    if (!canRecord()) throw new Error(recordBlockedHint());
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return this.stream;
  }

  get active() {
    return this.recorder?.state === 'recording';
  }

  /**
   * 开始录一段。onLevel(0–1) 用于画音量条；
   * 检测到"说过话 + 随后静音 silenceMs"就自动停（免提对话靠这个）。
   */
  async start({ onLevel, onAutoStop, silenceMs = 1500, minSpeechMs = 320, maxMs = 30000 } = {}) {
    const stream = await this.ensure();
    this.chunks = [];
    this.stats = { peak: 0, floor: 0, speechMs: 0, ms: 0 };
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    this.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data?.size) this.chunks.push(e.data);
    };
    this.recorder.start();

    // ── 音量监测 ──
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = this.ctx || new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);

    const buf = new Uint8Array(this.analyser.fftSize);
    const startedAt = Date.now();
    // 环境噪声底：取开头 450ms 的平均值。
    // 这里曾经用 Math.min 取最小值，一帧安静就把阈值钉死在 0.018，
    // 麦克风增益偏低的人（说话 rms 只有 0.012 左右）永远判成静音：
    // 音量条不动、也不自动停——表现就是"我说了话但它毫无反应"。
    let noiseSum = 0;
    let noiseN = 0;
    let floor = 0.006;
    let peak = 0.02;
    let speechMs = 0;
    let quietSince = 0;
    let stopped = false;

    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.analyser) this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);

      // 峰值缓慢衰减；音量条按峰值归一化，小音量也看得见在动
      peak = Math.max(peak * 0.996, rms);
      const level = Math.min(1, rms / Math.max(peak, 0.015));
      onLevel?.(level);
      this.stats.peak = peak;
      this.stats.floor = floor;
      this.stats.ms = Date.now() - startedAt;

      if (Date.now() - startedAt < 450) {
        noiseSum += rms;
        noiseN++;
        floor = Math.max(0.0025, noiseSum / Math.max(1, noiseN));
        return;
      }
      // 相对噪声底 + 一点绝对余量，弱麦也不会被误判成静音
      const threshold = Math.max(0.008, floor * 2.2 + 0.003);
      if (rms > threshold) {
        speechMs += 50;
        quietSince = 0;
      } else if (speechMs > minSpeechMs) {
        quietSince = quietSince || Date.now();
        if (Date.now() - quietSince >= silenceMs) {
          stopped = true;
          onAutoStop?.();
        }
      }
      this.stats.speechMs = speechMs;
      if (Date.now() - startedAt > maxMs) {
        stopped = true;
        onAutoStop?.();
      }
      if (stopped) clearInterval(this.timer);
    }, 50);
  }

  stop() {
    clearInterval(this.timer);
    const rec = this.recorder;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
        resolve(blob.size > 1200 ? blob : null);
      };
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });
  }

  dispose() {
    clearInterval(this.timer);
    try {
      this.recorder?.stop();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close?.().catch?.(() => {});
    this.ctx = null;
  }
}

/* ═══════════════ 识别 ═══════════════ */

/** 短音频 → { text, words:[{w,p,s,e}], duration } */
export async function transcribeClip(blob, { lang = 'en', model = '', words = false } = {}) {
  const qs = new URLSearchParams({ lang });
  if (model) qs.set('model', model);
  if (words) qs.set('words', '1');
  const res = await fetch(`/api/asr/clip?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  });
  let j = {};
  try {
    j = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || !j.ok) {
    const err = new Error(j.error || `识别失败（${res.status}）`);
    err.code = res.status === 503 ? 'ASR_DOWN' : 'ASR_FAIL';
    throw err;
  }
  return j;
}

/* ═══════════════ 跟读评分 ═══════════════ */

// 保留带变音符号的词（chamfé、café），否则 "chamfé" 会被切成 "chamf"
const WORD_RE = /[A-Za-z\u00C0-\u024F0-9][A-Za-z\u00C0-\u024F0-9'’\-]*/g;

const wordsOf = (text) => String(text || '').match(WORD_RE) || [];

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 词级对齐：heard 是机器听到的（可带置信度），target 是原句 */
function align(heard, target) {
  const a = heard.map((h) => ({ ...h, k: norm(h.w) }));
  const b = target.map((w) => ({ w, k: norm(w) }));
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].k && a[i].k === b[j].k ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].k && a[i].k === b[j].k) {
      ops.push({ t: 'eq', w: b[j].w, p: a[i].p });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'extra', w: a[i].w });
      i++;
    } else {
      ops.push({ t: 'miss', w: b[j].w });
      j++;
    }
  }
  while (i < n) ops.push({ t: 'extra', w: a[i++].w });
  while (j < m) ops.push({ t: 'miss', w: b[j++].w });
  return ops;
}

/** 语速评分：美国人日常对话大约 130–180 wpm，中间段给满分 */
function speedFactor(wpm) {
  if (!Number.isFinite(wpm) || wpm <= 0) return { f: null, note: '' };
  if (wpm < 90) return { f: Math.max(0.35, 0.35 + (wpm / 90) * 0.65), note: '语速偏慢，词和词之间连起来说' };
  if (wpm <= 195) return { f: 1, note: '' };
  if (wpm <= 260) return { f: 1 - ((wpm - 195) / 65) * 0.4, note: '语速偏快，吞音会变多' };
  return { f: 0.6, note: '说太快了，先稳下来' };
}

export function scoreShadow(targetEn, { words = [], duration = 0, text = '' } = {}) {
  const target = wordsOf(targetEn);
  if (!target.length) return null;

  const heard = (words?.length ? words : wordsOf(text).map((w) => ({ w }))) || [];
  const ops = align(heard, target);

  const eq = ops.filter((o) => o.t === 'eq');
  const miss = ops.filter((o) => o.t === 'miss').map((o) => o.w);
  const extra = ops.filter((o) => o.t === 'extra').map((o) => o.w);

  const accuracy = eq.length / target.length;
  const probs = eq.map((o) => (Number.isFinite(o.p) ? o.p : null)).filter((p) => p != null);
  const clarity = probs.length ? probs.reduce((s, p) => s + p, 0) / probs.length : null;

  // 用"说出来的词数 / 说话时长"估语速；没时长就不参与评分
  const wpm = duration > 0.6 ? (heard.length / duration) * 60 : null;
  const { f: sf, note: speedNote } = speedFactor(wpm);

  const parts = clarity != null
    ? [[accuracy, 0.5], [clarity, 0.35], [sf ?? 1, 0.15]]
    : [[accuracy, 0.65], [sf ?? 1, 0.35]];
  let score = Math.round(parts.reduce((s, [v, w]) => s + v * w, 0) * 100);
  // 整句没识别出来就是 0 分，别给安慰分
  if (!heard.length) score = 0;
  score = Math.max(0, Math.min(100, score));

  const tips = [];
  if (miss.length) tips.push(`漏了 ${miss.length} 个词：${miss.slice(0, 6).join(' / ')}`);
  if (extra.length) tips.push(`多出 ${extra.length} 个词：${extra.slice(0, 5).join(' / ')}（可能是口误，也可能是机器听岔了）`);
  const murky = eq.filter((o) => Number.isFinite(o.p) && o.p < 0.6).map((o) => o.w);
  if (murky.length) tips.push(`这几个词没听清：${murky.slice(0, 6).join(' / ')}——单独慢读两遍`);
  if (speedNote) tips.push(speedNote);
  if (!heard.length) tips.push('没识别到声音：先说大声一点，或者确认麦克风选对了');

  const grade = score >= 90 ? '过' : score >= 80 ? '不错' : score >= 65 ? '再顺一点' : score >= 45 ? '有点糊' : '重来';

  return { ops, score, grade, accuracy, clarity, wpm, tips, missing: miss, extra, murky };
}

/** 逐词渲染：绿=听清，黄=听出来了但含糊，红=漏掉，灰=多读 */
export function renderWordDiff(ops) {
  const frag = document.createDocumentFragment();
  for (const op of ops) {
    const cls = op.t === 'miss' ? 'd-miss' : op.t === 'extra' ? 'd-extra' : Number.isFinite(op.p) && op.p < 0.6 ? 'd-weak' : 'd-hit';
    frag.append(el('span', { class: 'd-w ' + cls, text: op.w }));
  }
  return frag;
}

/** 评分的颜色档位，给分数条用 */
export const scoreTone = (v) => (v >= 85 ? 'high' : v >= 65 ? 'mid' : 'low');
