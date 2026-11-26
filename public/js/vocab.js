// 单词卡 + 生词本
import { el, $, toast, download, escapeHtml } from './util.js';
import * as api from './api.js';
import { speak } from './practice.js';

export class Vocab {
  constructor(opts = {}) {
    this.items = [];
    this.onChange = opts.onChange || (() => {});
    this._req = 0;
    this._saveTimer = null;
    this._bindOutside();
  }

  /* ───────── 数据 ───────── */
  async load() {
    try {
      const res = await api.getJSON('/api/vocab');
      this.items = res.items || [];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      try {
        await api.postJSON('/api/vocab', { items: this.items });
      } catch {
        /* ignore */
      }
    }, 600);
  }

  keyOf(word) {
    return api.normKey(word);
  }

  has(word) {
    const k = this.keyOf(word);
    return this.items.some((it) => this.keyOf(it.word) === k);
  }

  find(word) {
    const k = this.keyOf(word);
    return this.items.find((it) => this.keyOf(it.word) === k);
  }

  add(card, source) {
    const k = this.keyOf(card.word);
    const exist = this.items.find((it) => this.keyOf(it.word) === k);
    if (exist) {
      if (source) exist.source = source;
      this.save();
      this.onChange();
      return false;
    }
    this.items.unshift({
      word: card.word,
      phonetic: card.phonetic || '',
      pos: card.pos || '',
      brief: card.brief || '',
      defs: card.defs || [],
      example: card.example || '',
      exampleZh: card.exampleZh || '',
      note: card.note || '',
      source: source || '',
      addedAt: Date.now(),
    });
    this.save();
    this.onChange();
    return true;
  }

  remove(word) {
    const k = this.keyOf(word);
    this.items = this.items.filter((it) => this.keyOf(it.word) !== k);
    this.save();
    this.onChange();
  }

  toCSV() {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['单词', '音标', '词性', '释义', '例句', '例句中文', '来源', '添加时间']];
    for (const it of this.items) {
      rows.push([
        it.word,
        it.phonetic,
        it.pos,
        [it.brief, ...(it.defs || [])].filter(Boolean).join(' / '),
        it.example,
        it.exampleZh,
        it.source,
        new Date(it.addedAt || Date.now()).toLocaleString('zh-CN'),
      ]);
    }
    return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  }

  exportCSV() {
    if (!this.items.length) {
      toast('生词本还是空的');
      return;
    }
    download(`生词本_${new Date().toISOString().slice(0, 10)}.csv`, this.toCSV());
  }

  /* ───────── 单词卡浮层 ───────── */
  _bindOutside() {
    document.addEventListener('click', (e) => {
      const pop = $('#wordPop');
      if (pop.hidden) return;
      if (pop.contains(e.target) || e.target.closest('.w')) return;
      pop.hidden = true;
    });
    window.addEventListener('resize', () => {
      $('#wordPop').hidden = true;
    });
    const box = $('#subs') || document.body;
    box.addEventListener('scroll', () => {
      $('#wordPop').hidden = true;
    }, { passive: true });
  }

  async openCard(word, sentence, anchor) {
    const pop = $('#wordPop');
    const token = ++this._req;
    pop.hidden = false;
    pop.innerHTML = `<div class="pop-head"><span class="pop-word">${escapeHtml(word)}</span></div><div class="pop-loading">查询中…</div>`;
    this._place(pop, anchor);

    let card = api.getCachedWord(word);
    const complete = card && (card.phonetic || (card.defs && card.defs.length));
    if (!complete) {
      try {
        const data = await api.wordCard(word, sentence || '');
        if (!data || !data.word) throw new Error('没有拿到释义');
        api.setCachedWord(word, data);
        card = data;
      } catch (e) {
        if (token !== this._req) return;
        pop.innerHTML = `<div class="pop-head"><span class="pop-word">${escapeHtml(word)}</span></div>
          <div class="pop-loading">释义获取失败：${escapeHtml(e.message)}</div>`;
        return;
      }
    }
    if (token !== this._req) return;
    this._renderCard(pop, word, card, sentence, anchor);
  }

  _renderCard(pop, word, card, sentence, anchor) {
    const clean = (v) => (typeof v === 'string' && v.trim() && v !== 'null' && v !== 'undefined' ? v.trim() : '');
    card = {
      ...card,
      word: clean(card.word) || word,
      phonetic: clean(card.phonetic),
      pos: clean(card.pos),
      brief: clean(card.brief),
      note: clean(card.note),
      example: clean(card.example),
      exampleZh: clean(card.exampleZh),
      defs: Array.isArray(card.defs) ? card.defs.map(clean).filter(Boolean) : [],
    };
    const saved = this.has(card.word || word);
    pop.innerHTML = '';
    const head = el('div', { class: 'pop-head' });
    head.append(
      el('span', { class: 'pop-word', text: card.word || word }),
      card.phonetic ? el('span', { class: 'pop-phon', text: card.phonetic }) : null,
      card.pos ? el('span', { class: 'pop-pos', text: card.pos }) : null
    );
    pop.append(head);

    if (card.brief) pop.append(el('div', { class: 'pop-brief', text: card.brief }));

    const defs = (card.defs || []).filter(Boolean);
    if (defs.length) {
      const ul = el('ul', { class: 'pop-defs' });
      defs.forEach((d) => ul.append(el('li', { text: d })));
      pop.append(ul);
    }

    if (card.example) {
      const ex = el('div', { class: 'pop-ex' });
      ex.append(el('div', { class: 'ex-en', text: card.example }));
      if (card.exampleZh) ex.append(el('div', { class: 'ex-zh', text: card.exampleZh }));
      pop.append(ex);
    }

    if (card.note) pop.append(el('div', { class: 'pop-note', text: card.note }));

    const actions = el('div', { class: 'pop-actions' });
    const btnSpeak = el('button', { class: 'btn small', text: '🔊 朗读' });
    btnSpeak.addEventListener('click', () => speak(card.word || word, { rate: 0.9 }));
    const btnSave = el('button', { class: `btn small ${saved ? '' : 'primary'}`, text: saved ? '已在生词本' : '＋ 加入生词本' });
    btnSave.addEventListener('click', () => {
      if (this.has(card.word || word)) {
        this.remove(card.word || word);
        btnSave.textContent = '＋ 加入生词本';
        btnSave.classList.add('primary');
        toast('已移出生词本');
      } else {
        this.add(card, sentence || '');
        btnSave.textContent = '已在生词本';
        btnSave.classList.remove('primary');
        toast('已加入生词本');
      }
      this.renderPanel();
    });
    actions.append(btnSpeak, btnSave);
    pop.append(actions);

    this._place(pop, anchor);
  }

  _place(pop, anchor) {
    const rect = anchor?.getBoundingClientRect?.();
    pop.style.visibility = 'hidden';
    pop.hidden = false;
    const w = pop.offsetWidth || 288;
    const h = pop.offsetHeight || 200;
    let left = rect ? rect.left + rect.width / 2 - w / 2 : window.innerWidth / 2 - w / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
    let top = rect ? rect.bottom + 8 : 120;
    if (top + h > window.innerHeight - 10) {
      top = Math.max(10, (rect ? rect.top : 300) - h - 8);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.visibility = '';
  }

  /* ───────── 生词本面板 ───────── */
  renderPanel() {
    const body = $('#vocabBody');
    const meta = $('#vocabMeta');
    if (!body) return;
    if (meta) meta.textContent = this.items.length ? `共 ${this.items.length} 个` : '';
    body.replaceChildren();
    if (!this.items.length) {
      body.append(el('p', { class: 'hint', text: '点字幕里的任意单词就能查词，按「＋ 加入生词本」收藏到这里。' }));
      return;
    }
    const sorted = [...this.items].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    for (const it of sorted) {
      const row = el('div', { class: 'vocab-item' });
      const main = el('div', { class: 'vi-main' });
      const wordRow = el('div', { class: 'vi-word' });
      wordRow.append(document.createTextNode(it.word));
      if (it.phonetic) wordRow.append(el('em', { text: it.phonetic }));
      main.append(wordRow);
      const defText = [it.pos, it.brief].filter(Boolean).join(' ') + (it.defs?.length ? `　${it.defs[0]}` : '');
      if (defText) main.append(el('div', { class: 'vi-def', text: defText }));
      if (it.source) main.append(el('div', { class: 'vi-src', text: it.source }));
      const acts = el('div', { class: 'vi-act' });
      const b1 = el('button', { class: 'icon-btn', title: '朗读', html: '🔊' });
      b1.style.fontSize = '13px';
      b1.addEventListener('click', () => speak(it.word, { rate: 0.9 }));
      const b2 = el('button', { class: 'icon-btn', title: '删除', html: '✕' });
      b2.style.fontSize = '13px';
      b2.addEventListener('click', () => {
        this.remove(it.word);
        this.renderPanel();
      });
      acts.append(b1, b2);
      row.append(main, acts);
      body.append(row);
    }
  }
}
