// 学习记录：把课程、口语对话、跟读、收藏和生词汇总成一个可回看的学习日志
import { $, el, toast, fmtTime } from './util.js';
import { getJSON, mapLimit } from './api.js';

const DAY = 86400000;
const DIMS = [
  ['grammar', '语法'],
  ['naturalness', '自然'],
  ['fluency', '流畅'],
  ['relevance', '切题'],
  ['conversation', '接话'],
];

const dayStart = (value) => {
  const d = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const avg = (values) => {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
};

function userTurns(session) {
  return (session?.messages || []).filter((m) => m.role === 'user').length;
}

function reviewScore(review) {
  return avg(Object.values(review?.scores || {}));
}

function dateLabel(ts) {
  const d = new Date(ts || Date.now());
  const today = dayStart(Date.now());
  const day = dayStart(d);
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (day === today) return `今天 ${time}`;
  if (day === today - DAY) return `昨天 ${time}`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function statCard(label, value, detail, tone = '') {
  const card = el('div', { class: `record-stat ${tone}` });
  card.append(
    el('span', { text: label }),
    el('b', { text: String(value) }),
    el('em', { text: detail })
  );
  return card;
}

export class Records {
  constructor({ onOpenCourse, onOpenSpeaking, onOpenLibrary, onOpenVocab } = {}) {
    this.onOpenCourse = onOpenCourse;
    this.onOpenSpeaking = onOpenSpeaking;
    this.onOpenLibrary = onOpenLibrary;
    this.onOpenVocab = onOpenVocab;

    this.courses = [];
    this.courseDetails = [];
    this.speaking = [];
    this.expressions = [];
    this.vocab = [];
    this.range = 7;

    $('#btnRecordsBack').addEventListener('click', () => this.close());
    $('#btnRecordsRefresh').addEventListener('click', () => this.refresh());
    $('#recordsRange').addEventListener('change', (e) => {
      this.range = Number(e.target.value) || 0;
      this.render();
    });
  }

  async open() {
    $('#welcome').hidden = true;
    $('#study').hidden = true;
    $('#speaking').hidden = true;
    $('#records').hidden = false;
    $('#recordsRange').value = String(this.range);
    await this.refresh();
  }

  close() {
    $('#records').hidden = true;
    $('#welcome').hidden = false;
    document.querySelectorAll('.home-nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.id === 'btnNavPractice');
    });
  }

  async refresh() {
    const timeline = $('#recordsTimeline');
    timeline.replaceChildren(el('p', { class: 'records-loading', text: '正在整理学习记录…' }));
    try {
      const [courses, speaking, expressions, vocab] = await Promise.all([
        getJSON('/api/courses'),
        getJSON('/api/speaking'),
        getJSON('/api/expressions'),
        getJSON('/api/vocab'),
      ]);
      this.courses = Array.isArray(courses.items) ? courses.items : [];
      this.speaking = Array.isArray(speaking.items) ? speaking.items : [];
      this.expressions = Array.isArray(expressions.items) ? expressions.items : [];
      this.vocab = Array.isArray(vocab.items) ? vocab.items : [];

      // 课程索引只保存摘要；按需加载原课程，才能统计跟读和练习结果。
      this.courseDetails = await mapLimit(this.courses.slice(0, 40), 4, async (meta) => {
        try {
          const res = await getJSON(`/api/courses/${encodeURIComponent(meta.id)}`);
          return { ...meta, course: res.course };
        } catch {
          return { ...meta, course: null };
        }
      });
      this.render();
    } catch (e) {
      timeline.replaceChildren(el('p', { class: 'records-loading', text: `读取失败：${e.message}` }));
      toast(`学习记录读取失败：${e.message}`, 3600);
    }
  }

  inRange(ts) {
    if (!this.range) return true;
    return Number(ts || 0) >= Date.now() - this.range * DAY;
  }

  filteredData() {
    const speaking = this.speaking.filter((x) => this.inRange(x.at));
    const courses = this.courseDetails.filter((x) => this.inRange(x.updatedAt || x.createdAt));
    const expressions = this.expressions.filter((x) => this.inRange(x.createdAt));
    const vocab = this.vocab.filter((x) => this.inRange(x.addedAt));
    return { speaking, courses, expressions, vocab };
  }

  courseMetrics(item) {
    const sentences = item.course?.sentences || [];
    const shadowScores = sentences
      .map((s) => Number(s.shadow?.score))
      .filter(Number.isFinite);
    const expressions = item.course?.analysis?.expressions || [];
    let answered = 0;
    for (const x of expressions) answered += Object.keys(x.results || {}).length;
    return {
      sentences: sentences.length,
      shadowCount: shadowScores.length,
      shadowAvg: Math.round(avg(shadowScores)),
      expressions: expressions.length,
      answered,
    };
  }

  render() {
    const data = this.filteredData();
    const turns = data.speaking.reduce((sum, x) => sum + userTurns(x), 0);
    const shadowScores = data.courses.flatMap((c) =>
      (c.course?.sentences || []).map((s) => Number(s.shadow?.score)).filter(Number.isFinite)
    );
    const saved = data.expressions.length + data.vocab.length;
    const actions = data.speaking.length + data.courses.length + saved;

    const rangeText = this.range === 7 ? '近 7 天' : this.range === 30 ? '近 30 天' : '全部时间';
    $('#recordsHeadline').textContent = actions ? `${rangeText}，你留下了 ${actions} 个学习足迹。` : '从今天的第一段练习开始。';
    $('#recordsSummary').textContent = actions
      ? `学习过 ${data.courses.length} 个视频课程，完成 ${data.speaking.length} 次口语练习，开口 ${turns} 轮。`
      : '完成一次口语练习或导入一段视频后，这里会自动形成你的学习记录。';

    $('#recordsStats').replaceChildren(
      statCard('视频课程', data.courses.length, '打开过的精听课程'),
      statCard('口语练习', turns, `${data.speaking.length} 次完整对话`, 'accent'),
      statCard('跟读评分', shadowScores.length, shadowScores.length ? `平均 ${Math.round(avg(shadowScores))} 分` : '还没有跟读记录'),
      statCard('收藏积累', saved, `${data.expressions.length} 个表达 · ${data.vocab.length} 个生词`)
    );

    this.renderChart();
    this.renderReview(data.speaking);
    this.renderTimeline(data);
    $('#recordsStreak').replaceChildren(
      document.createTextNode(String(this.streakDays())),
      el('em', { text: ' 天' })
    );
  }

  renderChart() {
    const box = $('#recordsChart');
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (6 - i));
      return { d, ts: d.getTime(), count: 0 };
    });
    const dayMap = new Map(days.map((x) => [x.ts, x]));
    const add = (ts) => {
      const key = dayStart(ts);
      const day = dayMap.get(key);
      if (day) day.count++;
    };

    this.speaking.forEach((x) => add(x.at));
    this.courseDetails.forEach((x) => add(x.updatedAt || x.createdAt));
    this.expressions.forEach((x) => add(x.createdAt));
    this.vocab.forEach((x) => add(x.addedAt));
    this.courseDetails.forEach((x) => {
      (x.course?.sentences || []).forEach((s) => add(s.shadow?.at));
    });

    const max = Math.max(1, ...days.map((x) => x.count));
    box.replaceChildren();
    for (const d of days) {
      const col = el('div', { class: 'record-day' });
      const barWrap = el('div', { class: 'record-bar-wrap' });
      const bar = el('i');
      bar.style.height = `${Math.max(5, (d.count / max) * 100)}%`;
      if (d.count) bar.classList.add('active');
      barWrap.append(bar);
      col.append(
        barWrap,
        el('b', { text: String(d.count || '') }),
        el('span', { text: ['日', '一', '二', '三', '四', '五', '六'][d.d.getDay()] })
      );
      box.append(col);
    }
  }

  renderReview(speaking) {
    const box = $('#recordsReview');
    const latest = speaking
      .filter((x) => x.review)
      .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0];
    if (!latest) {
      box.replaceChildren(
        el('div', { class: 'records-empty compact' },
          el('b', { text: '还没有口语复盘' }),
          el('p', { text: '完成至少两轮口语练习后，这里会显示最近一次评分和改进建议。' })
        )
      );
      return;
    }

    const scores = latest.review.scores || {};
    const dims = DIMS.map(([key, label]) => ({ key, label, value: Number(scores[key]) || 0 }))
      .sort((a, b) => a.value - b.value);
    const weakest = dims.slice(0, 2);
    const wrap = el('div', { class: 'latest-review' });
    const top = el('div', { class: 'latest-review-top' });
    top.append(
      el('div', {}, el('b', { text: latest.title || '口语练习' }), el('span', { text: dateLabel(latest.at) })),
      el('strong', { text: reviewScore(latest.review).toFixed(1) })
    );
    wrap.append(top);

    const bars = el('div', { class: 'latest-review-bars' });
    for (const item of weakest) {
      const row = el('div');
      row.append(
        el('span', { text: item.label }),
        el('i', {}, el('b', { class: item.value <= 2 ? 'low' : item.value === 3 ? 'mid' : 'high' })),
        el('em', { text: `${item.value}/5` })
      );
      row.querySelector('i b').style.width = `${Math.max(8, (item.value / 5) * 100)}%`;
      bars.append(row);
    }
    wrap.append(bars);

    if (latest.review.nextTime) {
      wrap.append(el('p', { class: 'latest-review-tip', text: `下次注意：${latest.review.nextTime}` }));
    }
    const btn = el('button', { class: 'btn small', text: '查看完整复盘' });
    btn.addEventListener('click', () => this.onOpenSpeaking?.(latest));
    wrap.append(btn);
    box.replaceChildren(wrap);
  }

  renderTimeline(data) {
    const box = $('#recordsTimeline');
    const events = [];

    for (const item of data.courses) {
      const m = this.courseMetrics(item);
      events.push({
        ts: item.updatedAt || item.createdAt,
        type: 'course',
        title: item.title || '视频课程',
        detail: `${m.sentences || item.count || 0} 句${m.shadowCount ? ` · ${m.shadowCount} 次跟读，平均 ${m.shadowAvg} 分` : ''}`,
        item,
      });
    }
    for (const item of data.speaking) {
      const turns = userTurns(item);
      const score = reviewScore(item.review);
      events.push({
        ts: item.at,
        type: 'speaking',
        title: item.title || '口语练习',
        detail: `${turns} 轮${score ? ` · 综合 ${score.toFixed(1)} 分` : ''}`,
        item,
      });
    }
    for (const item of data.expressions) {
      events.push({
        ts: item.createdAt,
        type: 'saved',
        title: item.en || '收藏表达',
        detail: item.usage || '收藏的表达',
        action: this.onOpenLibrary,
      });
    }
    for (const item of data.vocab) {
      events.push({
        ts: item.addedAt,
        type: 'word',
        title: item.word || '生词',
        detail: item.brief || '加入生词本',
        action: this.onOpenVocab,
      });
    }

    events.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
    if (!events.length) {
      box.replaceChildren(
        el('div', { class: 'records-empty' },
          el('b', { text: '这段时间还没有学习记录' }),
          el('p', { text: '换个时间范围，或先完成一次口语练习。' })
        )
      );
      return;
    }

    box.replaceChildren();
    for (const event of events.slice(0, 30)) {
      const row = el(event.type === 'speaking' || event.type === 'course' || event.action ? 'button' : 'div', {
        class: `record-event is-${event.type}`,
      });
      const iconText = { course: '▶', speaking: '声', saved: '☆', word: 'A' }[event.type] || '·';
      row.append(
        el('span', { class: 'record-event-icon', text: iconText }),
        el('div', { class: 'record-event-copy' },
          el('b', { text: event.title }),
          el('span', { text: event.detail })
        ),
        el('time', { text: dateLabel(event.ts) }),
        event.type === 'speaking' || event.type === 'course' ? el('em', { text: '›' }) : null
      );
      if (event.type === 'speaking') row.addEventListener('click', () => this.onOpenSpeaking?.(event.item));
      if (event.type === 'course') row.addEventListener('click', () => this.onOpenCourse?.(event.item));
      if (event.action) row.addEventListener('click', () => event.action());
      box.append(row);
    }
  }

  streakDays() {
    const activeDays = new Set();
    this.speaking.forEach((x) => x.at && activeDays.add(dayStart(x.at)));
    this.courseDetails.forEach((x) => activeDays.add(dayStart(x.updatedAt || x.createdAt)));
    this.expressions.forEach((x) => x.createdAt && activeDays.add(dayStart(x.createdAt)));
    this.vocab.forEach((x) => x.addedAt && activeDays.add(dayStart(x.addedAt)));

    let cursor = dayStart(Date.now());
    if (!activeDays.has(cursor)) cursor -= DAY;
    let count = 0;
    while (activeDays.has(cursor)) {
      count++;
      cursor -= DAY;
    }
    return count;
  }
}
