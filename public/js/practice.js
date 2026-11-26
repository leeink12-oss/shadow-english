// 练习模块：分词、听写判分、挖空、跟读录音
import { el, toast } from './util.js';
import { speak as speakNatural, stopSpeech } from './tts.js';

/* ─────────────── 分词 ─────────────── */
export function tokenize(text) {
  const tokens = [];
  const re = /[A-Za-z][A-Za-z'’\-]*|\d+(?:[.,]\d+)*|[^A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (/^[A-Za-z]/.test(raw)) tokens.push({ type: 'w', text: raw });
    else tokens.push({ type: 's', text: raw });
  }
  return tokens;
}

export function wordList(text) {
  return tokenize(text)
    .filter((t) => t.type === 'w')
    .map((t) => t.text);
}

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* ─────────────── 听写判分（词级 LCS） ─────────────── */
export function scoreDictation(userText, targetText) {
  const a = normalize(userText).split(' ').filter(Boolean);
  const b = normalize(targetText).split(' ').filter(Boolean);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', w: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'extra', w: a[i] });
      i++;
    } else {
      ops.push({ t: 'miss', w: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: 'extra', w: a[i++] });
  while (j < m) ops.push({ t: 'miss', w: b[j++] });

  const correct = ops.filter((o) => o.t === 'eq').length;
  const total = Math.max(1, b.length);
  return { ops, correct, total: b.length, ratio: correct / total };
}

export function renderDiff(ops) {
  const frag = document.createDocumentFragment();
  for (const op of ops) {
    if (op.t === 'eq') frag.append(el('span', { class: 'g', text: op.w + ' ' }));
    else if (op.t === 'miss') frag.append(el('span', { class: 'm', text: op.w + ' ' }));
    else frag.append(el('span', { class: 'r', text: op.w + ' ' }));
  }
  return frag;
}

/* ─────────────── 挖空 ─────────────── */
const STOP = new Set(
  ('a an the is are was were be been being am of to in on at for and or but it its this that these those ' +
    'i you he she we they me him her us them my your his our their do does did not no so as if with from ' +
    'there here what which who whom when where why how can could will would shall should may might must ' +
    'have has had just very too also than then').split(' ')
);

/** 供其他模块判断"实词"（需要查义的词） */
export const STOPWORDS = STOP;

/** 规则挑挖空词，返回 words 数组中的下标 */
export function pickBlanks(words, wanted = 3) {
  const cands = [];
  words.forEach((w, i) => {
    const low = w.toLowerCase();
    if (low.length < 3 || STOP.has(low)) return;
    if (/['’]/.test(w)) return; // 缩写 / 所有格：填空歧义太大
    if (/^\d/.test(w)) return;
    // 句中大写开头多为专有名词（King's Cross、London…），挖掉没意义
    if (i > 0 && /^[A-Z]/.test(w) && w !== 'I') return;
    if (i === 0 && words.length > 6) return;
    cands.push(i);
  });
  if (!cands.length) {
    words.forEach((w, i) => {
      if (w.length >= 2 && i > 0 && !STOP.has(w.toLowerCase())) cands.push(i);
    });
  }
  const want = Math.min(wanted, Math.max(1, Math.round(words.length / 3.5)), cands.length);
  const picked = [];
  const step = cands.length / want;
  for (let k = 0; k < want; k++) {
    const idx = cands[Math.min(cands.length - 1, Math.floor(k * step + step / 2))];
    if (idx != null && !picked.includes(idx)) picked.push(idx);
  }
  return picked.sort((x, y) => x - y);
}

export function buildClozeRow(sentence, blanks, { onCheck } = {}) {
  const box = el('div', { class: 'cloze-en' });
  const tokens = tokenize(sentence.en);
  const words = tokens.filter((t) => t.type === 'w');
  const blankSet = new Set(blanks);
  const inputs = [];
  let wi = 0;

  for (const tk of tokens) {
    if (tk.type === 's') {
      box.append(document.createTextNode(tk.text));
      continue;
    }
    const idx = wi++;
    if (!blankSet.has(idx)) {
      box.append(document.createTextNode(tk.text));
      continue;
    }
    const width = Math.max(48, Math.min(140, tk.text.length * 9 + 18));
    const inp = el('input', {
      class: 'cloze-input',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      style: `width:${width}px`,
      'data-answer': tk.text,
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const next = inputs[inputs.indexOf(inp) + 1];
        if (next) next.focus();
        else check();
      }
    });
    inputs.push(inp);
    box.append(inp);
  }

  const bar = el('div', { class: 'dict-actions' });
  const btnCheck = el('button', { class: 'btn small', text: '检查' });
  const btnAns = el('button', { class: 'btn small', text: '看答案' });
  const result = el('span', { class: 'dict-result' });
  bar.append(btnCheck, btnAns, result);
  box.append(bar);

  function check() {
    let right = 0;
    inputs.forEach((inp) => {
      const ans = normalize(inp.dataset.answer);
      const val = normalize(inp.value);
      inp.classList.remove('good', 'bad');
      if (!val) return;
      if (val === ans) {
        inp.classList.add('good');
        right++;
      } else {
        inp.classList.add('bad');
      }
    });
    const filled = inputs.filter((i) => i.value.trim()).length;
    result.innerHTML = `<span class="${right === inputs.length ? 'ok' : 'bad'}">${right} / ${inputs.length} 正确</span>${filled < inputs.length ? ' <span class="hint">（还有空没填）</span>' : ''}`;
    if (right === inputs.length) {
      inputs.forEach((i) => (i.disabled = true));
      onCheck?.(true);
    }
  }

  btnCheck.addEventListener('click', check);
  btnAns.addEventListener('click', () => {
    inputs.forEach((inp) => {
      inp.value = inp.dataset.answer;
      inp.classList.remove('bad');
      inp.classList.add('good');
      inp.disabled = true;
    });
    result.innerHTML = '<span class="hint">已显示答案</span>';
  });

  return { node: box, inputs, check };
}

/* ─────────────── 听写 ─────────────── */
export function buildDictationRow(sentence, { onListen, onScore } = {}) {
  const wrap = el('div', { class: 'dict-row' });
  const inp = el('input', {
    class: 'dict-input',
    type: 'text',
    placeholder: '听这句，把听到的英文打出来，回车检查',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
  });
  const bar = el('div', { class: 'dict-actions' });
  const bCheck = el('button', { class: 'btn small', text: '检查' });
  const bListen = el('button', { class: 'btn small', text: '▶ 再听' });
  const bHint = el('button', { class: 'btn small', text: '提示' });
  const bAnswer = el('button', { class: 'btn small', text: '答案' });
  const res = el('span', { class: 'dict-result' });
  const diff = el('div', { class: 'dict-diff' });
  bar.append(bCheck, bListen, bHint, bAnswer, res);
  wrap.append(inp, bar, diff);

  let hintLevel = 0;

  function check() {
    if (!inp.value.trim()) {
      toast('先写点什么再检查');
      return;
    }
    const r = scoreDictation(inp.value, sentence.en);
    diff.replaceChildren(renderDiff(r.ops));
    const pct = Math.round(r.ratio * 100);
    res.innerHTML = `<span class="${pct >= 90 ? 'ok' : 'bad'}">${pct}% 命中</span> <span class="hint">${r.correct}/${r.total} 词</span>`;
    if (pct >= 90) onScore?.(pct);
  }

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      check();
    }
  });
  bCheck.addEventListener('click', check);
  bListen.addEventListener('click', () => onListen?.());
  bAnswer.addEventListener('click', () => {
    inp.value = sentence.en;
    res.innerHTML = `<span class="hint">答案已填入</span>`;
  });
  bHint.addEventListener('click', () => {
    const words = wordList(sentence.en);
    hintLevel = Math.min(hintLevel + 1, 3);
    if (hintLevel === 1) res.innerHTML = `<span class="hint">${words.length} 个词，首字母：${words.map((w) => w[0]).join(' ')}</span>`;
    else if (hintLevel === 2) res.innerHTML = `<span class="hint">${words.map((w) => w[0] + '_'.repeat(Math.max(0, w.length - 1))).join(' ')}</span>`;
    else res.innerHTML = `<span class="hint">${sentence.en.split(' ').map((w) => w.slice(0, Math.ceil(w.length / 2)) + '…').join(' ')}</span>`;
  });

  return { node: wrap, input: inp };
}

/* 录音能力已统一到 voice.js 的 Mic（带静音自动停止），这里不再保留旧实现 */

/* ─────────────── 自然语音朗读 ─────────────── */
export function speak(text, { rate = 0.95, lang = 'en-US', onEnd } = {}) {
  return speakNatural(text, { rate, lang, onEnd });
}

/** 停掉正在朗读的内容（切场景 / 离开页面时用） */
export function stopSpeak() {
  stopSpeech();
}
