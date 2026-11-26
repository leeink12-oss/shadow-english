// 个人表达库：收藏的是完整表达和句子，不是单词
import { $, el, toast, download } from './util.js';
import * as api from './api.js';

const KIND = { expression: '表达', sentence: '原句', fix: '纠错' };
const MASTERY = [
  ['new', '新收'],
  ['learning', '在练'],
  ['mastered', '会用'],
];
const MASTERY_CLS = { new: 'm-new', learning: 'm-learning', mastered: 'm-mastered' };

export class Library {
  constructor({ onChange } = {}) {
    this.items = [];
    this.onChange = onChange || (() => {});
    this.filter = 'all';
  }

  async load() {
    try {
      const r = await api.getJSON('/api/expressions');
      this.items = Array.isArray(r.items) ? r.items : [];
    } catch {
      this.items = [];
    }
    this.onChange(this.items.length);
    return this.items;
  }

  has(id) {
    return this.items.some((x) => x.id === id);
  }

  async add(item) {
    if (!item?.id || this.has(item.id)) return;
    this.items.unshift({
      kind: 'expression',
      mastery: 'new',
      createdAt: Date.now(),
      ...item,
    });
    await this.save();
  }

  async remove(id) {
    this.items = this.items.filter((x) => x.id !== id);
    await this.save();
    this.renderPanel();
  }

  async setMastery(id, mastery) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    it.mastery = mastery;
    await this.save();
    this.renderPanel();
  }

  async save() {
    try {
      await api.postJSON('/api/expressions', { items: this.items });
    } catch (e) {
      toast(`表达库保存失败：${e.message}`);
    }
    this.onChange(this.items.length);
  }

  /* ───────────── 面板 ───────────── */

  renderPanel() {
    const body = $('#libBody');
    if (!body) return;
    body.replaceChildren();

    const meta = $('#libMeta');
    if (meta) meta.textContent = this.items.length ? `${this.items.length} 条` : '';

    const filters = el('div', { class: 'lib-filters' });
    const counts = { all: this.items.length };
    for (const k of Object.keys(KIND)) counts[k] = this.items.filter((x) => x.kind === k).length;
    for (const [key, label] of [['all', '全部'], ...Object.entries(KIND)]) {
      const b = el('button', { class: 'lib-filter' + (this.filter === key ? ' on' : ''), text: `${label} ${counts[key] || 0}` });
      b.addEventListener('click', () => {
        this.filter = key;
        this.renderPanel();
      });
      filters.append(b);
    }
    body.append(filters);

    const list = this.filter === 'all' ? this.items : this.items.filter((x) => x.kind === this.filter);
    if (!list.length) {
      body.append(
        el('p', {
          class: 'hint',
          text: this.items.length
            ? '这一类还没有内容。'
            : '还没有收藏。在「实用表达」里点 ☆，或在字幕里收藏句子，都会进到这里。',
        })
      );
      return;
    }

    for (const it of list) {
      const card = el('div', { class: 'lib-item' });
      const top = el('div', { class: 'lib-top' });
      top.append(el('span', { class: `lib-kind k-${it.kind || 'expression'}`, text: KIND[it.kind] || '表达' }));
      top.append(el('span', { class: 'lib-date', text: new Date(it.createdAt || Date.now()).toLocaleDateString('zh-CN') }));
      card.append(top);

      card.append(el('div', { class: 'lib-en', text: it.en || '' }));
      if (it.zh) card.append(el('div', { class: 'lib-zh', text: it.zh }));
      if (it.full && it.full !== it.en) card.append(el('div', { class: 'lib-full', text: it.full }));
      if (it.usage) card.append(el('div', { class: 'lib-tags', text: it.usage }));

      if (it.source?.courseTitle) {
        const src = it.source;
        card.append(
          el('div', {
            class: 'lib-src',
            text: `来自《${src.courseTitle}》${src.time ? ` · ${fmtShort(src.time)}` : ''}`,
          })
        );
      }

      const foot = el('div', { class: 'lib-foot' });
      const mBtn = el('button', { class: `lib-mastery ${MASTERY_CLS[it.mastery] || 'm-new'}`, text: (MASTERY.find(([k]) => k === it.mastery) || MASTERY[0])[1] });
      mBtn.title = '点击切换掌握程度';
      mBtn.addEventListener('click', () => {
        const i = MASTERY.findIndex(([k]) => k === (it.mastery || 'new'));
        this.setMastery(it.id, MASTERY[(i + 1) % MASTERY.length][0]);
      });
      const sp = el('button', { class: 'mini-spk', text: '🔊', title: '朗读' });
      sp.addEventListener('click', () => {
        const t = String(it.en || '').replace(/…/g, ' something ');
        if (window.speechSynthesis) {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(t);
          u.lang = 'en-US';
          u.rate = 0.95;
          window.speechSynthesis.speak(u);
        }
      });
      const del = el('button', { class: 'lib-del', text: '移除' });
      del.addEventListener('click', () => this.remove(it.id));
      foot.append(mBtn, sp, del);
      card.append(foot);

      body.append(card);
    }

    const exp = el('button', { class: 'btn small', text: '导出 CSV' });
    exp.addEventListener('click', () => this.exportCSV());
    body.append(exp);
  }

  exportCSV() {
    const rows = [['类型', '英文表达', '中文', '原句', '使用场景', '来源课程', '时间', '掌握', '收藏日期']];
    for (const it of this.items) {
      rows.push([
        KIND[it.kind] || '表达',
        it.en || '',
        it.zh || '',
        it.full || '',
        it.usage || '',
        it.source?.courseTitle || '',
        it.source?.time ? fmtShort(it.source.time) : '',
        (MASTERY.find(([k]) => k === it.mastery) || MASTERY[0])[1],
        new Date(it.createdAt || Date.now()).toLocaleDateString('zh-CN'),
      ]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download('表达库.csv', '\ufeff' + csv);
  }
}

function fmtShort(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
