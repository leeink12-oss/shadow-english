// 学习页的三个 AI 面板：实用表达 / 对话迁移 / 开口练
// 设计原则：原句永远取自 course.sentences（不信任 AI 复述），教学示例全部标为生成内容
import { $, el, toast, busy, fmtTime } from './util.js';
import { mapLimit } from './api.js';
import * as api from './api.js';
import { speak } from './practice.js';
import { Mic, transcribeClip, canRecord, recordBlockedHint, quietNote } from './voice.js';

const VALUE = {
  high: ['高频', 'v-high'],
  mid: ['值得注意', 'v-mid'],
  cultural: ['文化', 'v-cult'],
};
const REG = { casual: '随意', neutral: '中性', polite: '客气', formal: '正式' };
const DIFF = { beginner: '初级', intermediate: '中级', advanced: '进阶' };
const DIMS = [
  ['grammar', '语法'],
  ['naturalness', '自然'],
  ['fluency', '流畅'],
  ['relevance', '切题'],
  ['conversation', '接话'],
];
const PRACTICE = [
  ['substitution', '替换练习', '换掉原句里的人 / 事 / 地点，用同样的结构说一句你自己的'],
  ['scenarioResponse', '情景回应', '看这个情境，自己组织一句话回应'],
  ['freeExpression', '自主表达', '用自己的话说一段，两三句起'],
];
const FLOW = [
  ['respond', '回应'],
  ['expand', '补充'],
  ['ask', '追问'],
  ['link', '衔接'],
  ['sustain', '延续'],
];

/** 一个 1–5 的评分条 */
function meter(label, v) {
  const m = el('div', { class: 'fb-meter' });
  const track = el('b');
  const bar = el('i');
  bar.style.width = `${(v / 5) * 100}%`;
  bar.className = v <= 2 ? 'low' : v === 3 ? 'mid' : 'high';
  track.append(bar);
  m.append(el('span', { text: label }), track, el('em', { text: String(v) }));
  return m;
}

export class AnalysisView {
  constructor(course, opts = {}) {
    this.course = course;
    this.opts = opts; // { onDirty, onSeek, library, goTab }
    this.running = false;
    this.openDlg = new Map(); // 对话卡当前选中的场景下标
    this.mic = new Mic();
    this.recOwner = null;
  }

  get list() {
    return this.course.analysis?.expressions || [];
  }
  get summary() {
    return this.course.analysis?.summary || {};
  }
  has() {
    return this.list.length > 0;
  }
  sentenceOf(x) {
    return this.course.sentences.find((s) => s.i === x.si) || {};
  }
  indexOf(x) {
    return this.course.sentences.findIndex((s) => s.i === x.si);
  }
  libId(x) {
    return `x-${this.course.id}-${x.si}`;
  }

  /* ═══════════════ 渲染入口 ═══════════════ */

  show(tab) {
    if (tab === 'expr') this.renderExpr();
    else if (tab === 'dialog') this.renderDialog();
    else if (tab === 'practice') this.renderPractice();
  }

  renderAll() {
    this.renderExpr();
    this.renderDialog();
    this.renderPractice();
  }

  emptyBox(desc) {
    const box = el('div', { class: 'p-empty' });
    box.append(
      el('h3', { text: '这个视频还没分析' }),
      el('p', { text: desc }),
      el('p', {
        class: 'p-empty-note',
        text: '只挑值得学的，不逐句讲语法。想细看某一句，去「字幕」里点 ✦。',
      })
    );
    const btn = el('button', { class: 'btn primary', text: this.running ? '正在分析…' : '开始分析' });
    btn.disabled = this.running;
    btn.addEventListener('click', () => this.run());
    box.append(btn);
    return box;
  }

  /* ═══════════════ 生成流程 ═══════════════ */

  async run() {
    if (this.running) return;
    const sents = this.course.sentences
      .filter((s) => s.en && s.en.trim().length > 1)
      .map((s) => ({ i: s.i, en: s.en.slice(0, 300) }));
    if (sents.length < 3) return toast('这段字幕句子太少，没什么可分析的');

    this.running = true;
    this.show('expr');
    busy.show('AI 正在通读全文，挑值得学的表达…', 5);
    try {
      const res = await api.analyzePick(sents, 8);
      const bySi = new Map(this.course.sentences.map((s) => [s.i, s]));
      const seen = new Set();
      const list = [];
      for (const p of res.picks || []) {
        const s = bySi.get(p.si);
        if (!s || seen.has(p.si)) continue;
        seen.add(p.si);
        list.push({
          id: 'x' + p.si,
          si: p.si,
          core: p.core,
          meaning: p.meaning,
          value: p.value,
          why: p.why,
          expanded: false,
        });
      }
      if (!list.length) throw new Error('这段字幕里没挑出合适的表达，换一段素材试试');

      this.course.analysis = {
        v: res.v || 1,
        createdAt: Date.now(),
        summary: res.summary || {},
        expressions: list,
      };
      this.opts.onDirty?.();
      this.renderAll();
      await this.expandAll();
      const failed = this.list.filter((x) => !x.expanded).length;
      toast(failed ? `挑出 ${list.length} 个表达，其中 ${failed} 个生成失败可重试` : `挑出 ${list.length} 个表达，全部就绪`, 3200);
    } catch (e) {
      toast(`分析失败：${e.message}`, 4200);
      this.renderExpr();
    } finally {
      this.running = false;
      busy.hide();
    }
  }

  async expandAll() {
    const todo = this.list.filter((x) => !x.expanded);
    if (!todo.length) return;
    let done = 0;
    await mapLimit(todo, 3, async (x) => {
      await this.expandOne(x);
      done++;
      busy.text(`正在为条目补场景、对话和练习（${done}/${todo.length}）…`);
      busy.progress(18 + (done / todo.length) * 78);
    });
    this.opts.onDirty?.();
    this.renderAll();
  }

  async expandOne(x) {
    const s = this.sentenceOf(x);
    const idx = this.indexOf(x);
    const prev = idx > 0 ? this.course.sentences[idx - 1].en : '';
    const next = idx >= 0 && idx < this.course.sentences.length - 1 ? this.course.sentences[idx + 1].en : '';
    try {
      const d = await api.analyzeExpand({
        en: s.en || '',
        core: x.core,
        meaning: x.meaning || '',
        prev,
        next,
        topic: this.summary.topic || this.course.title,
      });
      Object.assign(x, d);
      x.expanded = true;
      x.error = '';
      return true;
    } catch (e) {
      x.expanded = false;
      x.error = e.message;
      return false;
    }
  }

  async regenerate(x) {
    if (this.running) return;
    this.running = true;
    toast('正在重新生成这一条…');
    const ok = await this.expandOne(x);
    this.running = false;
    this.opts.onDirty?.();
    this.renderAll();
    toast(ok ? '已更新' : `生成失败：${x.error}`);
  }

  /* ═══════════════ 表达列表 ═══════════════ */

  renderExpr() {
    const pane = $('#paneExpr');
    if (!pane) return;
    pane.replaceChildren();
    if (!this.has()) {
      pane.append(
        this.emptyBox(
          'AI 会通读全部字幕，挑出 6–10 个「学了就能用」的表达：核心说法、使用场景、地道替换、迁移对话，以及让你开口的三道练习。3 分钟的视频大约 40 秒。'
        )
      );
      if (this.running) {
        const box = pane.querySelector('.p-empty');
        box?.querySelector('button')?.setAttribute('disabled', '');
      }
      return;
    }

    const head = el('div', { class: 'p-head' });
    const meta = [this.summary.accent || '美式英语', DIFF[this.summary.difficulty] || '', this.summary.topic || '']
      .filter(Boolean)
      .join(' · ');
    const left = el('div', { class: 'p-head-main' });
    left.append(el('b', { text: `${this.list.length} 个表达` }), el('span', { text: meta }));
    const again = el('button', { class: 'btn small', text: '重新分析' });
    again.addEventListener('click', () => {
      if (confirm('重新分析会覆盖现有的表达、对话和练习记录，确定？')) this.run();
    });
    head.append(left, again);
    pane.append(head);

    this.list.forEach((x, i) => pane.append(this.card(x, i)));
  }

  card(x, i) {
    const s = this.sentenceOf(x);
    const box = el('div', { class: 'x-card', 'data-x': x.id });

    const top = el('div', { class: 'x-top' });
    const [vLabel, vCls] = VALUE[x.value] || VALUE.mid;
    top.append(el('span', { class: 'x-num', text: String(i + 1).padStart(2, '0') }), el('span', { class: `x-badge ${vCls}`, text: vLabel }));
    const saved = this.opts.library?.has(this.libId(x));
    const star = el('button', { class: 'x-star' + (saved ? ' on' : ''), title: '收藏到表达库', text: saved ? '★' : '☆' });
    star.addEventListener('click', () => this.toggleStar(x, star));
    top.append(star);
    box.append(top);

    // 原句：永远来自字幕，点击回到视频
    const src = el('div', { class: 'x-src', title: '回到视频这一句' });
    src.append(el('span', { class: 'x-src-en', text: s.en || '（原句缺失）' }), el('em', { text: fmtTime(s.start || 0) }));
    src.addEventListener('click', () => this.opts.onSeek?.(x.si));
    box.append(src);
    if (s.zh) box.append(el('div', { class: 'x-src-zh', text: s.zh }));

    const core = el('div', { class: 'x-core' });
    core.append(el('b', { text: x.core }), el('span', { text: x.meaning || '' }));
    box.append(core);

    if (!x.expanded) {
      box.append(el('div', { class: 'x-loading', text: x.error ? `生成失败：${x.error}` : '正在生成场景、对话和练习…' }));
      const retry = el('button', { class: 'btn small', text: x.error ? '重试' : '重新生成' });
      retry.addEventListener('click', () => this.regenerate(x));
      box.append(retry);
      return box;
    }

    const u = x.usage || {};
    const usage = el('div', { class: 'x-usage' });
    const tags = [u.context, REG[u.register], u.people].filter(Boolean);
    if (tags.length) {
      const row = el('div', { class: 'x-tags' });
      tags.forEach((t) => row.append(el('span', { text: t })));
      usage.append(row);
    }
    if (u.explanation) usage.append(el('p', { class: 'x-exp', text: u.explanation }));
    if (x.why) usage.append(el('p', { class: 'x-why', text: `为什么学：${x.why}` }));
    box.append(usage);

    if (x.alternatives?.length) {
      const alt = el('div', { class: 'x-alt' });
      alt.append(el('div', { class: 'x-sec', text: '换个说法' }));
      for (const a of x.alternatives) {
        const row = el('div', { class: 'x-alt-row' });
        row.append(el('b', { text: a.expression }));
        if (a.meaning) row.append(el('span', { class: 'x-alt-m', text: a.meaning }));
        if (a.difference) row.append(el('em', { text: a.difference }));
        const sp = el('button', { class: 'mini-spk', text: '🔊', title: '朗读' });
        sp.addEventListener('click', (e) => {
          e.stopPropagation();
          speak(a.expression);
        });
        row.append(sp);
        alt.append(row);
      }
      box.append(alt);
    }

    const acts = el('div', { class: 'x-acts' });
    const bd = el('button', { class: 'btn small', text: `看对话 (${x.dialogues?.length || 0})` });
    bd.addEventListener('click', () => this.opts.goTab?.('dialog', x.id));
    const bp = el('button', { class: 'btn small primary', text: '开口练' });
    bp.addEventListener('click', () => this.opts.goTab?.('practice', x.id));
    const rg = el('button', { class: 'x-regen', text: '⟳', title: '重新生成这条' });
    rg.addEventListener('click', () => this.regenerate(x));
    acts.append(bd, bp, rg);
    box.append(acts);
    return box;
  }

  toggleStar(x, btn) {
    const lib = this.opts.library;
    if (!lib) return;
    const id = this.libId(x);
    if (lib.has(id)) {
      lib.remove(id);
      btn.classList.remove('on');
      btn.textContent = '☆';
      toast('已从表达库移除');
      return;
    }
    const s = this.sentenceOf(x);
    lib.add({
      id,
      kind: 'expression',
      en: x.core,
      zh: x.meaning || '',
      full: s.en || '',
      usage: [x.usage?.context, REG[x.usage?.register], x.usage?.people].filter(Boolean).join(' · '),
      source: {
        courseId: this.course.id,
        courseTitle: this.course.title,
        si: x.si,
        time: s.start || 0,
      },
    });
    btn.classList.add('on');
    btn.textContent = '★';
    toast('已存入表达库');
  }

  /* ═══════════════ 对话迁移 ═══════════════ */

  renderDialog() {
    const pane = $('#paneDialog');
    if (!pane) return;
    pane.replaceChildren();
    if (!this.has()) {
      pane.append(this.emptyBox('先分析视频，AI 会围绕每个表达生成 2–3 组不同场景的对话，把说法迁移到生活和职场里。'));
      return;
    }
    const ready = this.list.filter((x) => x.expanded && x.dialogues?.length);
    if (!ready.length) {
      pane.append(el('div', { class: 'p-note', text: '对话还在生成中，稍等一下…' }));
      return;
    }

    for (const x of ready) {
      const pick = Math.min(this.openDlg.get(x.id) || 0, x.dialogues.length - 1);
      const card = el('div', { class: 'd-card', 'data-x': x.id });
      const head = el('div', { class: 'd-head' });
      head.append(el('b', { text: x.core }), el('span', { text: x.meaning || '' }));
      head.append(el('em', { class: 'd-gen', text: 'AI 生成示例' }));
      card.append(head);

      const tabs = el('div', { class: 'd-tabs' });
      x.dialogues.forEach((g, gi) => {
        const t = el('button', { class: 'd-tab' + (gi === pick ? ' on' : ''), text: g.scenario || `场景 ${gi + 1}` });
        t.addEventListener('click', () => {
          this.openDlg.set(x.id, gi);
          this.renderDialog();
        });
        tabs.append(t);
      });
      card.append(tabs);

      const body = el('div', { class: 'd-body' });
      const g = x.dialogues[pick];
      for (const line of g.lines) {
        const row = el('div', { class: 'd-line' + (line.speaker === 'B' ? ' b' : '') });
        row.append(el('span', { class: 'd-who', text: line.speaker }), el('span', { class: 'd-text', text: line.text }));
        const sp = el('button', { class: 'mini-spk', text: '🔊', title: '朗读这句' });
        sp.addEventListener('click', () => speak(line.text));
        row.append(sp);
        body.append(row);
      }
      card.append(body);

      const foot = el('div', { class: 'd-foot' });
      const play = el('button', { class: 'btn small', text: '🔊 朗读整段' });
      play.addEventListener('click', () => {
        window.speechSynthesis?.cancel();
        const all = g.lines.map((l) => l.text).join(' ');
        speak(all, { rate: 0.9 });
      });
      const go = el('button', { class: 'btn small', text: '开口练' });
      go.addEventListener('click', () => this.opts.goTab?.('practice', x.id));
      const star2 = el('button', { class: 'btn small', text: '收藏表达' });
      star2.addEventListener('click', () => {
        const fake = el('button');
        this.toggleStar(x, fake);
        this.renderExpr();
      });
      foot.append(play, go, star2);
      card.append(foot);
      pane.append(card);
    }
    pane.append(el('p', { class: 'p-foot', text: '这些对话是 AI 按美式口语习惯生成的练习材料，不是视频原话。' }));
  }

  /* ═══════════════ 开口练 ═══════════════ */

  renderPractice() {
    const pane = $('#panePractice');
    if (!pane) return;
    pane.replaceChildren();
    if (!this.has()) {
      pane.append(this.emptyBox('先分析视频，每个表达会有三道练习：替换、情景回应、自主表达。你先写，AI 再给评价。'));
      return;
    }
    const ready = this.list.filter((x) => x.expanded && x.practice);
    if (!ready.length) {
      pane.append(el('div', { class: 'p-note', text: '练习还在生成中，稍等一下…' }));
      return;
    }

    pane.append(
      el('p', {
        class: 'p-foot top',
        text: '点麦克风直接说，说完自动结束、自动评分；不想开口也可以打字。AI 只指出 2–3 个最影响沟通的问题。',
      })
    );

    for (const x of ready) {
      const card = el('div', { class: 'px-card', 'data-x': x.id });
      const head = el('div', { class: 'px-head' });
      head.append(el('b', { text: x.core }), el('span', { text: x.meaning || '' }));
      head.append(el('em', { class: 'd-gen', text: 'AI 生成示例' }));
      card.append(head);

      for (const [key, label, hint] of PRACTICE) {
        const q = x.practice[key];
        if (!q) continue;
        card.append(this.practiceItem(x, key, label, hint, q));
      }
      pane.append(card);
    }

    const cta = el('div', { class: 'p-cta' });
    cta.append(
      el('b', { text: '单句练顺了，去演一场真的' }),
      el('p', {
        text: '开口练是一次一句。实战口语有 40 个真实场景——点餐、面试、谈价格、处理投诉，对方会接你的话、追问、换话题，全程只用嘴。',
      })
    );
    const go = el('button', { class: 'btn small primary', text: '打开实战口语 →' });
    go.addEventListener('click', () => this.opts.goSpeaking?.());
    cta.append(go);
    pane.append(cta);
  }

  practiceItem(x, key, label, hint, question) {
    const wrap = el('div', { class: 'px-item' });
    const q = el('div', { class: 'px-q' });
    q.append(el('em', { text: label }), el('span', { text: question }));
    wrap.append(q);
    wrap.append(el('div', { class: 'px-hint', text: hint }));

    /* ── 语音作答：默认入口，点一下就说，说完自动识别并提交 ── */
    const voice = el('div', { class: 'px-voice' });
    const mic = el('button', { class: 'px-mic', type: 'button' });
    const micIco = el('span', { class: 'px-mic-ico', text: '🎤' });
    const micTxt = el('b', { text: canRecord() ? '点一下，开口说' : '这台设备不能录音' });
    mic.append(micIco, micTxt);
    const level = el('div', { class: 'px-level' }, el('i'));
    const vhint = el('span', { class: 'px-vhint', text: canRecord() ? '说完自动结束并评分 · 卡住了就先说半句' : recordBlockedHint() });
    voice.append(mic, level, vhint);
    wrap.append(voice);

    const ta = el('textarea', { class: 'px-input', rows: '2', placeholder: '也可以直接打字，写完点提交' });
    wrap.append(ta);

    const row = el('div', { class: 'px-row' });
    const btn = el('button', { class: 'btn small primary', text: '提交，看反馈' });
    const note = el('span', { class: 'px-note', text: '' });
    row.append(btn, note);
    wrap.append(row);

    const fbBox = el('div', { class: 'px-fb' });
    wrap.append(fbBox);

    let recording = false;
    let sending = false;

    const resetMic = () => {
      mic.classList.remove('rec');
      micTxt.textContent = canRecord() ? '点一下，开口说' : '这台设备不能录音';
      level.firstChild.style.width = '0%';
    };

    const submit = async (text) => {
      const answer = String(text ?? ta.value).trim();
      if (answer.length < 2) return toast('先说（或写）一句');
      if (sending) return;
      sending = true;
      btn.disabled = true;
      btn.textContent = '正在看…';
      note.textContent = '';
      try {
        const data = await api.coachAnswer({
          prompt: question,
          target: x.core,
          context: this.summary.topic || this.course.title,
          answer,
        });
        x.results = x.results || {};
        x.results[key] = { answer, fb: data, at: Date.now() };
        this.opts.onDirty?.();
        fbBox.replaceChildren();
        this.renderFeedback(fbBox, data, () => {
          ta.value = '';
          beginRecord();
        });
        note.textContent = '照着「更自然的说法」再说一遍';
      } catch (e) {
        toast(`评价失败：${e.message}`, 4000);
      } finally {
        sending = false;
        btn.disabled = false;
        btn.textContent = '再提交一次';
      }
    };

    const endRecord = async () => {
      if (!recording) return;
      recording = false;
      this.recOwner = null;
      mic.classList.remove('rec');
      micTxt.textContent = '正在识别…';
      level.firstChild.style.width = '0%';
      const blob = await this.mic.stop();
      if (!blob) {
        resetMic();
        vhint.textContent = '没录到声音，再来一次';
        return;
      }
      try {
        const heard = await transcribeClip(blob, { lang: 'en' });
        const text = (heard.text || '').trim();
        if (!text) {
          resetMic();
          vhint.textContent = quietNote(this.mic.stats);
          return;
        }
        ta.value = text;
        vhint.textContent = `识别到：${text}`;
        await submit(text);
      } catch (e) {
        vhint.textContent =
          e.code === 'ASR_DOWN' ? '本地识别没就绪：先跑一次「安装语音识别.bat」' : `识别失败：${e.message}`;
        toast(vhint.textContent, 4200);
      } finally {
        resetMic();
      }
    };

    const beginRecord = async () => {
      if (!canRecord()) return toast(recordBlockedHint());
      if (this.recOwner && this.recOwner !== key) return toast('另一个练习还在录，先说那个');
      if (this.mic.active || recording) return;
      recording = true;
      this.recOwner = key;
      mic.classList.add('rec');
      micTxt.textContent = '正在听…再点一下结束';
      vhint.textContent = '正在听…';
      try {
        await this.mic.start({
          onLevel: (v) => (level.firstChild.style.width = `${Math.round(v * 100)}%`),
          onAutoStop: () => endRecord(),
          silenceMs: 1400,
          maxMs: 45000,
        });
      } catch (e) {
        recording = false;
        this.recOwner = null;
        resetMic();
        toast(`麦克风打不开：${e.message}`);
      }
    };

    mic.addEventListener('click', () => {
      if (recording) endRecord();
      else beginRecord();
    });
    btn.addEventListener('click', () => submit());

    const prev = x.results?.[key];
    if (prev) {
      ta.value = prev.answer || '';
      this.renderFeedback(fbBox, prev.fb, () => {
        ta.value = '';
        beginRecord();
      });
      note.textContent = '已提交过，改完可以再交一次';
    }

    return wrap;
  }

  renderFeedback(box, fb, onRetry) {
    if (!fb) return;
    const card = el('div', { class: 'fb' });

    const meters = el('div', { class: 'fb-meters' });
    for (const [k, label] of DIMS) {
      const v = fb.scores?.[k] ?? 3;
      meters.append(meter(label, v));
    }
    card.append(meters);

    if (fb.issues?.length) {
      const list = el('div', { class: 'fb-issues' });
      for (const it of fb.issues) {
        const one = el('div', { class: 'fb-issue' });
        if (it.original) one.append(el('s', { text: it.original }));
        if (it.better) {
          const b = el('div', { class: 'fb-better' });
          b.append(el('b', { text: it.better }));
          const sp = el('button', { class: 'mini-spk', text: '🔊' });
          sp.addEventListener('click', () => speak(it.better));
          b.append(sp);
          one.append(b);
        }
        if (it.why) one.append(el('p', { class: 'fb-why', text: it.why }));
        if (it.problem) one.append(el('p', { class: 'fb-prob', text: it.problem }));
        list.append(one);
      }
      card.append(list);
    }

    if (fb.rewrite) {
      const rw = el('div', { class: 'fb-rewrite' });
      const head = el('div', { class: 'fb-rw-head' });
      head.append(el('span', { text: '更自然的说法' }));
      const sp = el('button', { class: 'mini-spk', text: '🔊' });
      sp.addEventListener('click', () => speak(fb.rewrite));
      head.append(sp);
      rw.append(head, el('p', { text: fb.rewrite }));
      card.append(rw);
    }

    if (fb.followUp) card.append(el('div', { class: 'fb-follow', text: `接着说：${fb.followUp}` }));

    const retry = el('button', { class: 'btn small', text: '再说一次' });
    retry.addEventListener('click', onRetry);
    card.append(retry);

    box.append(card);
  }

  /* ═══════════════ 口语实战复盘（复用同一套视觉） ═══════════════ */

  static renderReview(container, rv, { scenario } = {}) {
    const card = el('div', { class: 'fb rv' });
    if (scenario) card.append(el('div', { class: 'rv-scene', text: scenario }));

    const meters = el('div', { class: 'fb-meters' });
    for (const [k, label] of DIMS) {
      const v = rv.scores?.[k] ?? 3;
      meters.append(meter(label, v));
    }
    card.append(meters);

    if (rv.flow) {
      const flow = el('div', { class: 'rv-flow' });
      flow.append(el('div', { class: 'rv-title', text: '对话推进能力' }));
      for (const [k, label] of FLOW) {
        const v = rv.flow[k] || {};
        const row = el('div', { class: 'rv-flow-row ' + (v.level || 'ok') });
        row.append(el('b', { text: label }), el('span', { text: v.note || '' }));
        flow.append(row);
      }
      card.append(flow);
    }

    if (rv.issues?.length) {
      const list = el('div', { class: 'fb-issues' });
      for (const it of rv.issues) {
        const one = el('div', { class: 'fb-issue' });
        if (it.original) one.append(el('s', { text: it.original }));
        if (it.better) {
          const b = el('div', { class: 'fb-better' });
          b.append(el('b', { text: it.better }));
          const sp = el('button', { class: 'mini-spk', text: '🔊' });
          sp.addEventListener('click', () => speak(it.better));
          b.append(sp);
          one.append(b);
        }
        if (it.why) one.append(el('p', { class: 'fb-why', text: it.why }));
        list.append(one);
      }
      card.append(list);
    }

    if (rv.nextTime) card.append(el('div', { class: 'rv-next', text: `下次注意：${rv.nextTime}` }));
    container.append(card);
  }
}
