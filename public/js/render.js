// 字幕视图：渲染、高亮、实用讲解、音标、逐词释义、模式切换
import { el, $$, fmtTime, miniMarkdown, escapeHtml, toast } from './util.js';
import {
  tokenize,
  wordList,
  buildClozeRow,
  buildDictationRow,
  pickBlanks,
  STOPWORDS,
} from './practice.js';
import { Mic, transcribeClip, scoreShadow, renderWordDiff, scoreTone, canRecord, recordBlockedHint, quietNote } from './voice.js';

// 讲解内容版本号（改动 server.js 的 explain prompt 时同步 +1）
const EXPLAIN_VER = 2;
import * as api from './api.js';

export class SubtitleView {
  constructor(container, opts) {
    this.container = container;
    this.course = opts.course;
    this.player = opts.player;
    this.onWord = opts.onWord || (() => {});
    this.onDirty = opts.onDirty || (() => {});
    this.onActive = opts.onActive || (() => {});
    this.isSaved = opts.isSaved || (() => false);
    this.getSettings = opts.getSettings || (() => ({}));

    this.mode = 'bilingual';
    this.wordGloss = false;
    this.ipa = false;
    this.visited = new Set();
    this.nodes = new Map();
    this.activeIdx = -1;
    this.userScrollUntil = 0;
    this.recorder = new Mic();
    this.currentShadow = null;
    this.openExplains = new Set();

    this._bind();
  }

  get sentences() {
    return this.course.sentences;
  }

  _bind() {
    this.container.addEventListener('click', (e) => {
      const w = e.target.closest('.w');
      if (w) {
        e.stopPropagation();
        this.onWord(w.dataset.w, w);
        return;
      }
      if (e.target.closest('input, button, audio, textarea, select')) return;
      const row = e.target.closest('.sub');
      if (!row) return;
      if (this.mode === 'blind') row.classList.add('reveal');
      if (!this.player.video.src) {
        toast('先选一下课程对应的视频文件');
        return;
      }
      const idx = Number(row.dataset.i);
      this.player.seekToIndex(idx, { play: true });
    });

    const markScroll = () => {
      this.userScrollUntil = Date.now() + 5000;
    };
    this.container.addEventListener('wheel', markScroll, { passive: true });
    this.container.addEventListener('touchmove', markScroll, { passive: true });
  }

  /* ───────── 整体渲染 ───────── */
  renderAll() {
    const frag = document.createDocumentFragment();
    this.nodes.clear();
    this.sentences.forEach((s, i) => {
      const row = this.buildRow(s, i);
      this.nodes.set(i, row);
      frag.append(row);
    });
    this.container.replaceChildren(frag);
    if (this.activeIdx >= 0) {
      const row = this.nodes.get(this.activeIdx);
      row?.classList.add('active');
    }
    this.visited.forEach((i) => this.nodes.get(i)?.classList.add('visited'));
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'shadow') {
      if (this.recorder.active) this.recorder.stop(); // 切走就别在后台继续录
      this.shadowPanel?.remove();
    }
    this.renderAll();
    // 视频尚未加载时 player.index 为 -1，退回到第一句，保证面板/高亮可用
    const idx = this.player.index >= 0 ? this.player.index : 0;
    this.setActive(idx, { force: true });
    this.updateOverlay();
  }

  buildRow(s, i) {
    const row = el('div', { class: 'sub', 'data-i': i });

    const meta = el('div', { class: 'sub-meta' });
    meta.append(
      el('span', { class: 'num', text: String(i + 1).padStart(2, '0') }),
      el('span', { class: 'time', text: `${fmtTime(s.start)} – ${fmtTime(s.end)}` })
    );
    const btnZh = el('button', { class: 'btn-zh', text: '中' });
    btnZh.addEventListener('click', (e) => {
      e.stopPropagation();
      row.querySelector('.sub-zh')?.classList.toggle('show');
    });
    const btnEx = el('button', { class: 'btn-explain', html: '<span>✦</span> 实用讲解' });
    btnEx.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleExplain(i);
    });
    meta.append(btnZh, btnEx);
    row.append(meta);

    const enBox = el('div', { class: 'sub-en' });
    if (this.mode !== 'dictation' && this.mode !== 'cloze') this.fillEnglish(enBox, s);
    row.append(enBox);

    const zhBox = el('div', {
      class: `sub-zh${s.zh ? '' : ' empty'}`,
      text: s.zh || '（暂无译文，可点右上角 ✦ 让 AI 生成讲解）',
    });
    row.append(zhBox);

    const extra = el('div', { class: 'sub-extra' });
    row.append(extra);

    if (this.mode === 'dictation') {
      const d = buildDictationRow(s, {
        onListen: () => this.player.seekToIndex(i, { play: true }),
        onScore: () => row.classList.add('done'),
      });
      if (s._draft) d.input.value = s._draft;
      d.input.addEventListener('input', () => {
        s._draft = d.input.value;
      });
      extra.append(d.node);
    } else if (this.mode === 'cloze') {
      const blanks = s.blanks?.length ? s.blanks : pickBlanks(wordList(s.en));
      const c = buildClozeRow(s, blanks, { onCheck: () => row.classList.add('done') });
      c.node.dataset.starter = '1';
      extra.append(c.node);
    }

    // 模式切换会重建行，把之前展开过的讲解补回来
    if (this.openExplains.has(i) && s.explain) {
      extra.append(this.makeExplainCard(i, s));
    }

    return row;
  }

  fillEnglish(box, s) {
    const frag = document.createDocumentFragment();
    for (const t of tokenize(s.en)) {
      if (t.type === 'w') {
        const span = el('span', { class: 'w', 'data-w': t.text, text: t.text });
        if (this.isSaved(t.text)) span.classList.add('saved');
        frag.append(span);
      } else {
        frag.append(document.createTextNode(t.text));
      }
    }
    box.replaceChildren(frag);
    if (this.wordGloss) this.applyGlossTo(box, s);
  }

  /* ───────── 激活句子 ───────── */
  setActive(idx, { force = false } = {}) {
    if (idx === this.activeIdx && !force) return;
    const prev = this.nodes.get(this.activeIdx);
    if (prev && this.activeIdx >= 0) {
      prev.classList.remove('active');
      prev.classList.add('visited');
      this.visited.add(this.activeIdx);
    }
    this.activeIdx = idx;
    const row = this.nodes.get(idx);
    if (row) {
      row.classList.add('active');
      row.classList.remove('visited');
      this.scrollToRow(row);
      if (this.mode === 'shadow') this.attachShadowPanel(idx);
    }
    this.updateOverlay();
    this.onActive?.(idx);
    this.scheduleLazy(idx);
  }

  scrollToRow(row) {
    if (Date.now() < this.userScrollUntil) return;
    if (!this.getSettings().autoScroll) return;
    const top = row.offsetTop - this.container.clientHeight / 2 + row.offsetHeight / 2;
    this.container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  scrollToIndex(i) {
    this.userScrollUntil = 0;
    const row = this.nodes.get(i);
    if (row) this.scrollToRow(row);
  }

  updateOverlay() {
    const s = this.sentences[this.activeIdx];
    const t = document.getElementById('voText');
    const z = document.getElementById('voZh');
    if (!t || !z) return;
    t.textContent = s?.en || '';
    clearTimeout(this._zhTimer);
    const delay = Number(this.getSettings().zhDelay || 0);
    if (!s?.zh) {
      z.textContent = '';
      return;
    }
    if (delay > 0) {
      z.textContent = '';
      this._zhTimer = setTimeout(() => {
        z.textContent = s.zh;
      }, delay * 1000);
    } else {
      z.textContent = s.zh;
    }
  }

  /* ───────── 懒加载 ───────── */
  scheduleLazy(idx) {
    clearTimeout(this._lazyTimer);
    if (idx < 0) return;
    this._lazyTimer = setTimeout(() => {
      if (this.mode === 'cloze') this.ensureBlanks(idx);
      if (this.wordGloss) this.ensureGloss(idx);
      if (this.ipa) this.ensureIpa(idx);
    }, 500);
  }

  /* ───────── 实用讲解 ───────── */
  /** 讲解卡（复用：展开、重建、旧版提示都走这里） */
  makeExplainCard(i, s) {
    const card = el('div', { class: 'explain' });
    const head = el('div', { class: 'ex-head' });
    head.append(el('span', { text: '✦ 实用讲解' }));
    const refresh = el('button', { class: 'ex-refresh', title: '重新生成讲解', text: '⟳' });
    refresh.addEventListener('click', (e) => {
      e.stopPropagation();
      this.generateExplain(i, card);
    });
    head.append(refresh);
    card.append(head);

    const body = el('div', { class: 'ex-body', html: miniMarkdown(s.explain) });
    // 老课程里的讲解是旧版（语法拆解），提示可以一键换掉
    if ((s.explainV || 1) < EXPLAIN_VER) {
      body.append(
        el('div', { class: 'ex-stale', text: '旧版讲解（语法分析）。点右上角 ⟳ 换成职场向的新版' })
      );
    }
    card.append(body);
    return card;
  }

  async generateExplain(i, card) {
    const s = this.sentences[i];
    const row = this.nodes.get(i);
    const body = card.querySelector('.ex-body');
    const btn = row?.querySelector('.btn-explain');
    btn?.classList.add('loading');
    body.innerHTML = '<div class="ex-loading">正在分析…</div>';
    try {
      const data = await api.explainSentence(s, {
        prev: this.sentences[i - 1]?.en || '',
        next: this.sentences[i + 1]?.en || '',
      });
      s.explain = data.text;
      s.explainV = data.v || EXPLAIN_VER;
      this.onDirty();
      if (card.isConnected) body.innerHTML = miniMarkdown(s.explain);
    } catch (e) {
      if (card.isConnected) body.innerHTML = `<div class="ex-loading">生成失败：${escapeHtml(e.message)}</div>`;
      toast(e.message);
    } finally {
      btn?.classList.remove('loading');
    }
  }

  async toggleExplain(i) {
    const s = this.sentences[i];
    const row = this.nodes.get(i);
    if (!s || !row) return;
    const extra = row.querySelector('.sub-extra');
    const existing = extra.querySelector('.explain');
    if (existing) {
      existing.remove();
      this.openExplains.delete(i);
      return;
    }
    this.openExplains.add(i);

    if (s.explain) {
      const card = this.makeExplainCard(i, s);
      if (this.mode === 'cloze' || this.mode === 'dictation') extra.append(card);
      else extra.prepend(card);
      return;
    }

    const card = this.makeExplainCard(i, s);
    card.querySelector('.ex-body').innerHTML = '<div class="ex-loading">正在分析…</div>';
    if (this.mode === 'cloze' || this.mode === 'dictation') extra.append(card);
    else extra.prepend(card);
    await this.generateExplain(i, card);
  }

  /* ───────── 音标 ───────── */
  setIpa(on) {
    this.ipa = on;
    this.sentences.forEach((s, i) => {
      const row = this.nodes.get(i);
      const box = row?.querySelector('.ipa');
      if (!on && box) box.remove();
    });
    if (on && this.activeIdx >= 0) this.ensureIpa(this.activeIdx);
  }

  async ensureIpa(i) {
    const s = this.sentences[i];
    const row = this.nodes.get(i);
    if (!s || !row || !this.ipa) return;
    if (s.ipa) {
      this.renderIpa(i);
      return;
    }
    if (s._ipaLoading) return;
    s._ipaLoading = true;
    try {
      const d = await api.sentenceIpa(s.en);
      s.ipa = d.ipa || '';
      s.ipaTips = d.tips || '';
      this.onDirty();
      if (this.ipa) this.renderIpa(i);
    } catch (e) {
      toast(`音标生成失败：${e.message}`);
    } finally {
      s._ipaLoading = false;
    }
  }

  renderIpa(i) {
    const s = this.sentences[i];
    const row = this.nodes.get(i);
    if (!s?.ipa || !row) return;
    const extra = row.querySelector('.sub-extra');
    if (!extra) return;
    let box = extra.querySelector('.ipa');
    if (!box) {
      box = el('div', { class: 'ipa' });
      extra.prepend(box);
    }
    box.innerHTML = `${escapeHtml(s.ipa)}${s.ipaTips ? `<em>${escapeHtml(s.ipaTips)}</em>` : ''}`;
  }

  /* ───────── 逐词释义 ───────── */
  setWordGloss(on) {
    this.wordGloss = on;
    this.nodes.forEach((row, i) => {
      const box = row.querySelector('.sub-en');
      if (!box) return;
      this.applyGlossTo(box, this.sentences[i]);
    });
    if (on && this.activeIdx >= 0) this.ensureGloss(this.activeIdx);
  }

  /** 把当前句的实词释义渲染成句末的词表行（不打断英文排版） */
  applyGlossTo(box, s) {
    const row = box.closest('.sub');
    const extra = row?.querySelector('.sub-extra');
    if (!extra || !s) return;
    let line = row.querySelector('.gloss-line');
    if (!this.wordGloss) {
      line?.remove();
      return;
    }
    const words = [...new Set(wordList(s.en).map((w) => w.toLowerCase()))].filter(
      (w) => w.length > 2 && !STOPWORDS.has(w) && /^[a-z]/.test(w)
    );
    const known = words
      .map((w) => {
        const c = api.getCachedWord(w);
        return [w, c?.gloss || c?.brief];
      })
      .filter(([, b]) => b);
    if (!known.length) {
      line?.remove();
      return;
    }
    if (!line) {
      line = el('div', { class: 'gloss-line' });
      extra.prepend(line);
    }
    line.innerHTML = known
      .map(([w, b]) => `<b>${escapeHtml(w)}</b> ${escapeHtml(b)}`)
      .join('<i>·</i>');
  }

  async ensureGloss(i) {
    const s = this.sentences[i];
    const row = this.nodes.get(i);
    if (!s || !row || !this.wordGloss) return;
    const box = row.querySelector('.sub-en');
    if (!box) return;
    const words = [
      ...new Set(
        wordList(s.en)
          .map((w) => w.toLowerCase())
          .filter((w) => w.length > 2 && !STOPWORDS.has(w) && /^[a-z]/.test(w))
      ),
    ];
    const missing = words.filter((w) => !api.getCachedWord(w));
    if (!missing.length) {
      this.applyGlossTo(box, s);
      return;
    }
    if (s._glossLoading) return;
    s._glossLoading = true;
    try {
      const data = await api.wordGlosses(missing, s.en);
      for (const it of data.items || []) {
        if (!it?.w) continue;
        api.setCachedWord(it.w, { gloss: it.b || '', pos: it.pos || '' });
      }
      if (this.wordGloss) this.applyGlossTo(box, s);
    } catch {
      /* 静默：逐词释义失败不影响主流程 */
    } finally {
      s._glossLoading = false;
    }
  }

  /* ───────── 挖空：AI 优化挖空点 ───────── */
  async ensureBlanks(i) {
    const s = this.sentences[i];
    if (!s || s.blanks || s._blanksLoading) return;
    s._blanksLoading = true;
    try {
      const words = wordList(s.en);
      if (words.length < 3) return;
      const d = await api.clozeBlanks(s.en, words);
      if (Array.isArray(d.blanks) && d.blanks.length >= 2) {
        s.blanks = d.blanks.filter((n) => n >= 0 && n < words.length);
        this.onDirty();
        this.rerenderCloze(i);
      }
    } catch {
      /* 保留规则结果 */
    } finally {
      s._blanksLoading = false;
    }
  }

  rerenderCloze(i) {
    if (this.mode !== 'cloze') return;
    const s = this.sentences[i];
    const row = this.nodes.get(i);
    const extra = row?.querySelector('.sub-extra');
    const old = extra?.querySelector('.cloze-en');
    if (!old || !s?.blanks?.length) return;
    // 用户已经动过手就不覆盖
    if ([...old.querySelectorAll('input')].some((inp) => inp.value.trim())) return;
    const c = buildClozeRow(s, s.blanks, { onCheck: () => row.classList.add('done') });
    old.replaceWith(c.node);
  }

  /* ───────── 跟读 + 评分 ───────── */
  ensureShadowPanel() {
    if (this.shadowPanel) return this.shadowPanel;
    const box = el('div', { class: 'shadow-box' });

    const head = el('div', { class: 'sh-head' });
    const btn = el('button', { class: 'rec-btn', text: '● 跟读一句' });
    const level = el('div', { class: 'sh-level' }, el('i'));
    const hint = el('span', { class: 'shadow-hint', text: '先听一遍原句，再点录音' });
    head.append(btn, level, hint);

    const result = el('div', { class: 'sh-result' });
    const audio = el('audio', { controls: 'controls' });
    audio.hidden = true;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleRecord();
    });

    box.append(head, result, audio);
    this.shadowPanel = box;
    this.shadowBtn = btn;
    this.shadowHint = hint;
    this.shadowLevel = level.firstChild;
    this.shadowResult = result;
    this.shadowAudio = audio;
    return box;
  }

  attachShadowPanel(i) {
    const row = this.nodes.get(i);
    const extra = row?.querySelector('.sub-extra');
    if (!extra) return;
    if (this.recorder.active) return;
    const panel = this.ensureShadowPanel();
    extra.append(panel);
    this.currentShadow = this.sentences[i];
    this.currentShadowIdx = i;

    // 这一句练过就先把上次成绩亮出来，知道自己在进步还是原地转
    const best = this.sentences[i]?.shadow;
    if (best?.score != null) {
      this.shadowResult.replaceChildren(
        el('div', { class: 'sh-last', text: `上次最好 ${best.score} 分` })
      );
    } else {
      this.shadowResult.replaceChildren();
    }
    this.shadowAudio.hidden = true;
    this.shadowHint.textContent = canRecord() ? '先听一遍原句，再点录音' : recordBlockedHint();
  }

  async toggleRecord() {
    if (this.recorder.active) {
      await this.stopRecord();
      return;
    }
    const s = this.currentShadow;
    if (!s) return;
    try {
      this.shadowBtn.classList.add('recording');
      this.shadowBtn.textContent = '■ 说完了';
      this.shadowHint.textContent = '正在听…读完会自动结束';
      this.shadowResult.replaceChildren();
      await this.recorder.start({
        onLevel: (v) => {
          if (this.shadowLevel) this.shadowLevel.style.width = `${Math.round(v * 100)}%`;
        },
        onAutoStop: () => this.stopRecord(),
        silenceMs: 1300,
        maxMs: Math.max(6000, (s.end - s.start) * 2600 + 2500),
      });
    } catch (e) {
      this.shadowBtn.classList.remove('recording');
      this.shadowBtn.textContent = '● 跟读一句';
      toast(e.message);
    }
  }

  async stopRecord() {
    if (!this.recorder.active) return;
    const blob = await this.recorder.stop();
    this.shadowBtn.classList.remove('recording');
    this.shadowBtn.textContent = '● 再跟读一次';
    if (this.shadowLevel) this.shadowLevel.style.width = '0%';
    if (!blob) {
      this.shadowHint.textContent = '没录到声音，再试一次';
      return;
    }

    if (this._audioUrl) URL.revokeObjectURL(this._audioUrl);
    this._audioUrl = URL.createObjectURL(blob);
    this.shadowAudio.src = this._audioUrl;
    this.shadowAudio.hidden = false;

    const s = this.currentShadow;
    if (!s) return;
    this.shadowHint.textContent = '正在听你说的…';
    this.shadowBtn.disabled = true;
    try {
      const heard = await transcribeClip(blob, { lang: 'en' });
      const res = scoreShadow(s.en, heard);
      if (!res) return;
      this.renderShadowScore(s, res, heard);
      if (!s.shadow || res.score > (s.shadow.score || 0)) {
        s.shadow = { score: res.score, at: Date.now() };
        this.onDirty?.();
      }
      this.shadowHint.textContent = !heard.words?.length
        ? quietNote(this.mic.stats)
        : res.score >= 85
          ? '过了，可以下一句'
          : '再跟一遍，注意红色和黄色的词';
    } catch (e) {
      if (e.code === 'ASR_DOWN') {
        this.shadowHint.textContent = '本地识别没就绪：先跑一次「安装语音识别.bat」';
        toast('跟读评分需要本地语音识别，见 README 的安装步骤', 4200);
      } else {
        this.shadowHint.textContent = `评分失败：${e.message}`;
      }
    } finally {
      this.shadowBtn.disabled = false;
    }
  }

  renderShadowScore(s, res, heard) {
    const box = this.shadowResult;
    box.replaceChildren();

    const top = el('div', { class: 'sh-top' });
    const score = el('div', { class: 'sh-score ' + scoreTone(res.score) });
    score.append(el('b', { text: String(res.score) }), el('em', { text: '分' }));
    const metrics = el('div', { class: 'sh-metrics' });
    const cells = [el('span', { text: rate('完整', res.accuracy) })];
    if (res.clarity != null) cells.push(el('span', { text: `清晰 ${Math.round(res.clarity * 100)}%` }));
    if (res.wpm) cells.push(el('span', { text: `语速 ${Math.round(res.wpm)} wpm` }));
    cells.push(el('em', { class: 'sh-grade', text: res.grade }));
    metrics.append(...cells);
    top.append(score, metrics);
    box.append(top);

    const diff = el('div', { class: 'sh-diff' });
    diff.append(renderWordDiff(res.ops));
    box.append(diff);

    if (heard?.text) {
      box.append(el('div', { class: 'sh-heard', text: `机器听到：${heard.text}` }));
    }

    if (res.tips.length) {
      const ul = el('div', { class: 'sh-tips' });
      res.tips.forEach((t) => ul.append(el('p', { text: '· ' + t })));
      box.append(ul);
    }

    const acts = el('div', { class: 'sh-acts' });
    const again = el('button', { class: 'btn small', text: '再跟一遍' });
    again.addEventListener('click', () => this.toggleRecord());
    const orig = el('button', { class: 'btn small', text: '▶ 听原句' });
    orig.addEventListener('click', () => this.player.seekToIndex(this.currentShadowIdx, { play: true }));
    const mine = el('button', { class: 'btn small', text: '▶ 听我的' });
    mine.addEventListener('click', () => this.shadowAudio.play().catch(() => {}));
    acts.append(again, orig, mine);
    box.append(acts);

    function rate(label, v) {
      return `${label} ${Math.round((v || 0) * 100)}%`;
    }
  }

  /** 句末自动进入跟读录音（由播放器回调触发） */
  autoShadow(i) {
    this.attachShadowPanel(i);
    setTimeout(() => {
      if (this.mode === 'shadow' && !this.recorder.active) this.toggleRecord();
    }, 700);
  }

  /** 生词本变化后刷新下划线标记 */
  refreshSaved(savedSet) {
    this.nodes.forEach((row) => {
      $$('.w', row).forEach((w) => {
        w.classList.toggle('saved', savedSet.has(api.normKey(w.dataset.w)));
      });
    });
  }
}
