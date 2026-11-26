// 口语实战：选场景 → 跟 AI 扮演的对方真的聊起来 → 结束复盘
// 语音链路全部本地：麦克风 → faster-whisper 识别 → DeepSeek 回话 → 浏览器朗读
import { $, el, toast } from './util.js';
import * as api from './api.js';
import { AnalysisView } from './analysis.js';
import { Mic, transcribeClip, canRecord, recordBlockedHint } from './voice.js';
import { speak, stopSpeak } from './practice.js';
import { warmAsr } from './asr.js';

/* ══════════════ 场景库 ══════════════ */
const CATS = [
  {
    id: 'everyday',
    name: '日常生活',
    icon: '☕',
    desc: '点餐、购物、看病、租房这些必须开口的场合',
    items: [
      { id: 'food', title: '餐厅点餐', role: '一家美式简餐店的服务员，语气轻松随意', opener: "Hi there! Can I start you off with something to drink?", goal: '点菜、问推荐、要打包' },
      { id: 'shop', title: '购物与退换', role: '服装店店员，热情但不多话', opener: 'Hey, finding everything okay?', goal: '问尺码、问退换政策' },
      { id: 'way', title: '问路', role: '街上的本地人，正好顺路', opener: "Hey — you look a little lost. You need help with something?", goal: '问方向、听懂指路、确认' },
      { id: 'rent', title: '看房租房', role: '带你看房的房东，说话直接', opener: "Alright, so this is the unit. Any questions so far?", goal: '问租金、押金、水电、入住时间' },
      { id: 'appt', title: '打电话预约', role: '理发店前台，语速正常', opener: 'Thanks for calling Sharp Cuts. How can I help you today?', goal: '说时间、改期、确认' },
      { id: 'doctor', title: '看医生', role: '诊所的护士，边问边记录', opener: 'So what brings you in today?', goal: '描述症状、说持续时间、问药' },
      { id: 'hotel', title: '酒店入住', role: '酒店前台，礼貌高效', opener: 'Hi, welcome in. Checking in?', goal: '办入住、提要求、问设施' },
    ],
  },
  {
    id: 'smalltalk',
    name: '社交寒暄',
    icon: '🤝',
    desc: '第一次见面、聚会、跟同事闲聊，最容易尬住的场合',
    items: [
      { id: 'meet', title: '初次见面', role: '朋友的朋友，在聚会上，很外向', opener: "Hey! You must be Mike's friend. I'm Jess — nice to meet you.", goal: '接话、自我介绍、反问对方' },
      { id: 'newjob', title: '入职第一天', role: '同组的老同事，主动来打招呼', opener: "Oh hey, you're the new hire, right? I'm Dan.", goal: '介绍自己、说背景、记住对方' },
      { id: 'hobby', title: '聊兴趣爱好', role: '一起吃午饭的同事', opener: "So what do you do when you're not working? Any hobbies?", goal: '说爱好、讲细节、反问' },
      { id: 'weekend', title: '聊周末', role: '隔壁邻居，在楼道碰到', opener: 'Got any plans for the weekend?', goal: '说计划、给理由、把话题抛回去' },
      { id: 'party', title: '参加聚会', role: '派对主人，忙着招呼人', opener: 'Glad you could make it! Grab a drink — how do you know Kevin?', goal: '解释关系、加入话题' },
      { id: 'agree', title: '表达不同意见', role: '同事，观点跟你不一样，但很好说话', opener: "Honestly, I think we should just go with the cheaper option. What do you think?", goal: '委婉不同意、给理由、提替代' },
    ],
  },
  {
    id: 'story',
    name: '讲述与观点',
    icon: '🎤',
    desc: '把一件事讲完整，把想法说清楚——这是最难的',
    items: [
      { id: 'week', title: '说说你这周', role: '朋友， casually 关心你最近怎么样', opener: 'Hey! How was your week? Anything interesting happen?', goal: '讲一件完整的事，有起因经过结果' },
      { id: 'career', title: '讲工作经历', role: '面试官，在做背景了解', opener: 'So tell me a bit about your background — how did you get into this field?', goal: '按时间线讲清楚，别流水账' },
      { id: 'trip', title: '讲一次旅行', role: '朋友，刚听说你出去玩', opener: 'You went to Japan, right? How was it?', goal: '讲细节和感受，不只说"很好"' },
      { id: 'opinion', title: '表达一个观点', role: '同事，想听你的真实看法', opener: 'Curious — what do you think about working from home full time?', goal: '给立场 + 两个理由 + 让步' },
      { id: 'reason', title: '解释原因', role: '朋友，不理解你的选择', opener: 'Wait, you left your last job? Why?', goal: '分层解释，不只说"钱少"' },
      { id: 'compare', title: '比较两个选择', role: '朋友，帮你一起拿主意', opener: "So you're deciding between two places? Walk me through them.", goal: '对比利弊、给结论' },
    ],
  },
  {
    id: 'work',
    name: '职场沟通',
    icon: '💼',
    desc: '汇报、开会、跟同事协作、面试',
    items: [
      { id: 'interview', title: '求职面试', role: '招聘经理，专业但友好', opener: 'Thanks for coming in. So, walk me through your resume.', goal: '自我介绍、讲项目、答行为题' },
      { id: 'teamintro', title: '团队自我介绍', role: '新组长，让大家轮流介绍', opener: "Alright, let's go around — tell us who you are and what you do.", goal: '30 秒讲清自己负责什么' },
      { id: 'standup', title: '每日站会', role: '你的组长，赶时间', opener: "Morning. What did you get done yesterday, and what's on your plate today?", goal: '三句话说清进度和卡点' },
      { id: 'meeting', title: '项目会议', role: '客户方的项目经理，关注进度', opener: "Okay, before we dive in — where are we on the timeline?", goal: '报进度、说风险、给方案' },
      { id: 'help', title: '找同事帮忙', role: '同组同事，手上也有一堆活', opener: 'Hey, do you have five minutes? I need a hand with something.', goal: '提请求、说清要什么、给余地' },
      { id: 'delay', title: '解释延期', role: '你的经理，语气不算好', opener: 'I heard the delivery slipped. What happened?', goal: '认账、说原因、给补救' },
    ],
  },
  {
    id: 'sales',
    name: '销售沟通',
    icon: '📈',
    desc: '介绍产品、挖需求、谈价格、处理异议',
    items: [
      { id: 'pitch', title: '产品介绍', role: '展会上的潜在客户，边走边看', opener: 'So what exactly do you guys sell?', goal: '一句话说清价值，别念参数' },
      { id: 'discover', title: '挖需求', role: '客户，自称"现在挺好"', opener: "Thanks for the call. We're pretty happy with our current setup, but go ahead.", goal: '问出真实痛点' },
      { id: 'recommend', title: '推荐方案', role: '客户，在两个型号之间犹豫', opener: "I'm looking at two models. Which one would you put me in?", goal: '问场景、给理由、敢推荐' },
      { id: 'price', title: '谈价格', role: '采购，拿别家报价压你', opener: 'Honestly, your price is higher than the other quotes we got.', goal: '守价、拆价值、给条件' },
      { id: 'objection', title: '处理异议', role: ' skeptical 的客户', opener: "I'm not sure this would work for our team, to be honest.", goal: '先接住情绪，再给证据' },
      { id: 'follow', title: '跟进客户', role: '上周见过面的潜在客户', opener: "Hey, good to hear from you. What's up?", goal: '给由头、推进下一步' },
    ],
  },
  {
    id: 'trade',
    name: '外贸实务',
    icon: '🚢',
    desc: '开发客户、报价、MOQ、交期、投诉',
    items: [
      { id: 'cold', title: '开发海外客户', role: '采购经理，接了个陌生电话', opener: 'Hello? Who is this?', goal: '30 秒说清你是谁、为什么打' },
      { id: 'first', title: '初次联系', role: '回你邮件的买家', opener: 'Hi, I got your email. What are you offering exactly?', goal: '介绍产品、给差异点' },
      { id: 'inquiry', title: '回复询盘', role: '要细节的买家', opener: "We're interested in your item 3020. Can you send me the details?", goal: '给规格、给交期、给下一步' },
      { id: 'quote', title: '报价沟通', role: '看报价单的买家', opener: 'I got the quote. The unit price seems high for this quantity.', goal: '解释成本、给阶梯价' },
      { id: 'moq', title: 'MOQ 谈不下来', role: '想小单试水的买家', opener: 'We only need 500 pieces to start. Is that possible?', goal: '守 MOQ 或给替代方案' },
      { id: 'order', title: '订单确认', role: '准备下单的买家', opener: "Okay, we're ready to move forward. What do you need from us?", goal: '确认规格、数量、条款' },
      { id: 'lead', title: '交期沟通', role: '关心出货时间的买家', opener: 'If we order today, when can you ship?', goal: '给明确时间、说清前提' },
      { id: 'pay', title: '付款与物流', role: '想改付款条件的买家', opener: 'About payment — we usually do 30 days after delivery.', goal: '谈条件、给折中' },
      { id: 'claim', title: '处理投诉', role: '收到破损货物的买家，很生气', opener: 'We received the shipment and 12 units are damaged. This is not acceptable.', goal: '先安抚、认事实、给方案' },
    ],
  },
];

const ALL = CATS.flatMap((c) => c.items.map((it) => ({ ...it, cat: c.id, catName: c.name })));

export class Speaking {
  constructor({ library } = {}) {
    this.library = library;
    this.scenario = null;
    this.messages = [];
    this.review = null;
    this.sessionId = null;
    this.sending = false;
    this.readonly = false;
    this.ended = false;
    this.history = [];
    this.mic = new Mic();
    this.phase = 'idle'; // idle | listening | thinking | speaking
    this.handsFree = true; // 免提：对方说完自动开麦，你说完自动发送
    this.autoSpeak = true; // 自动朗读对方
    this.failCount = 0;
    this.from = 'welcome'; // 从哪进来，返回就回哪
    this.pickerFilter = 'all';

    // 切走标签页时把麦克风关掉，别让它一直听
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stopAll();
    });
  }

  /* ───────────── 页面入口 ───────────── */

  async open(scenarioId, { from = 'welcome' } = {}) {
    this.from = from;
    $('#welcome').hidden = true;
    $('#study').hidden = true;
    $('#speaking').hidden = false;
    if (!this.history.length) await this.loadHistory();
    if (scenarioId) {
      const sc = ALL.find((x) => x.id === scenarioId);
      if (sc) return this.start(sc);
    }
    this.renderPicker();
  }

  async loadHistory() {
    try {
      const r = await api.getJSON('/api/speaking');
      this.history = Array.isArray(r.items) ? r.items : [];
    } catch {
      this.history = [];
    }
  }

  close() {
    this.stopAll();
    $('#speaking').hidden = true;
    if (this.from === 'study') {
      $('#study').hidden = false;
    } else if (this.from === 'records') {
      $('#records').hidden = false;
    } else {
      $('#welcome').hidden = false;
    }
  }

  /** 离开对话：停麦、停朗读，别让它在后台继续听 */
  stopAll() {
    try {
      this.mic.stop();
    } catch {
      /* ignore */
    }
    stopSpeak();
    this.phase = 'idle';
  }

  /* ───────────── 场景选择 ───────────── */

  renderPicker() {
    this.stopAll();
    const body = $('#speakBody');
    body.replaceChildren();
    $('#speakTitle').textContent = '场景库';
    $('#btnSpeakNew').hidden = true;

    const wrap = el('div', { class: 'sp-pick' });

    const hero = el('section', { class: 'scene-library-hero' });
    const heroCopy = el('div', { class: 'scene-library-copy' });
    heroCopy.append(
      el('span', { class: 'scene-library-kicker', text: 'SCENE LIBRARY' }),
      el('h2', { text: '选一个真实场景，直接开口。' }),
      el('p', { text: '对方会先说话，你只要接住。没有标准答案，也不用背模板。' })
    );
    const stats = el('div', { class: 'scene-library-stats' });
    stats.append(
      el('div', {}, el('b', { text: String(CATS.length) }), el('span', { text: '训练分类' })),
      el('div', {}, el('b', { text: String(ALL.length) }), el('span', { text: '真实场景' })),
      el('div', {}, el('b', { text: '本地' }), el('span', { text: '语音识别' }))
    );
    hero.append(heroCopy, stats);
    wrap.append(hero);

    const filters = el('nav', { class: 'scene-library-filters', 'aria-label': '场景分类' });
    const addFilter = (id, label) => {
      const btn = el('button', {
        class: id === this.pickerFilter ? 'active' : '',
        text: label,
      });
      btn.addEventListener('click', () => {
        this.pickerFilter = id;
        this.renderPicker();
      });
      filters.append(btn);
    };
    addFilter('all', '全部');
    for (const cat of CATS) addFilter(cat.id, cat.name);
    wrap.append(filters);

    const visibleCats = this.pickerFilter === 'all' ? CATS : CATS.filter((cat) => cat.id === this.pickerFilter);
    for (const cat of visibleCats) {
      const sec = el('div', { class: `sp-cat cat-${cat.id}` });
      const head = el('div', { class: 'sp-cat-head' });
      head.append(
        el('span', { class: 'sp-ico', text: cat.icon }),
        el('div', {}, el('b', { text: cat.name }), el('em', { text: cat.desc })),
        el('span', { class: 'sp-count', text: `${cat.items.length} 个场景` })
      );
      sec.append(head);
      const grid = el('div', { class: 'sp-grid' });
      for (const [index, it] of cat.items.entries()) {
        const b = el('button', { class: 'sp-scene-btn' });
        const top = el('span', { class: 'sp-scene-top' });
        top.append(el('em', { text: String(index + 1).padStart(2, '0') }), el('i', { text: '开始 ›' }));
        b.append(top, el('b', { text: it.title }), el('span', { class: 'sp-scene-goal', text: it.goal }));
        b.addEventListener('click', () => this.start({ ...it, cat: cat.id, catName: cat.name }));
        grid.append(b);
      }
      sec.append(grid);
      wrap.append(sec);
    }

    if (this.history.length) {
      const sec = el('div', { class: 'sp-cat scene-history' });
      const head = el('div', { class: 'sp-cat-head' });
      head.append(
        el('span', { class: 'sp-ico', text: '↺' }),
        el('div', {}, el('b', { text: '最近练过' }), el('em', { text: '点开可以查看当时的完整复盘' })),
        el('span', { class: 'sp-count', text: `${this.history.length} 次` })
      );
      sec.append(head);
      const list = el('div', { class: 'sp-hist' });
      for (const h of this.history.slice(0, 6)) {
        const row = el('button', { class: 'sp-hist-row' });
        row.append(
          el('b', { text: h.title || '对话练习' }),
          el('span', { text: `${new Date(h.at || Date.now()).toLocaleDateString('zh-CN')} · ${(h.messages || []).filter((m) => m.role === 'user').length} 轮` })
        );
        row.addEventListener('click', () => this.openSession(h));
        list.append(row);
      }
      sec.append(list);
      wrap.append(sec);
    }

    body.append(wrap);
  }

  openSession(h) {
    this.stopAll();
    this.readonly = true;
    this.ended = true;
    this.scenario = { title: h.title, role: h.role || '', opener: '', goal: h.goal || '' };
    this.messages = h.messages || [];
    this.review = h.review || null;
    this.sessionId = h.id;
    this.renderChat();
  }

  /* ───────────── 开始对话 ───────────── */

  start(sc) {
    this.stopAll();
    warmAsr().catch(() => {});
    this.readonly = false;
    this.ended = false;
    this.scenario = sc;
    this.review = null;
    this.sessionId = null;
    this.failCount = 0;
    this.messages = [{ role: 'assistant', content: sc.opener, opening: true }];
    this.renderChat();
    // 对方先开口：朗读开场白，说完自动开麦，用户张嘴就能接
    this.speakReply(sc.opener);
  }

  renderChat() {
    const body = $('#speakBody');
    body.replaceChildren();
    $('#btnSpeakNew').hidden = false;
    const sc = this.scenario;
    $('#speakTitle').textContent = sc.title || '口语实战';

    const box = el('div', { class: 'sp-chat' });

    const scene = el('div', { class: 'sp-scene' });
    scene.append(el('b', { text: sc.title || '' }), el('span', { text: this.readonly ? '历史记录' : `对方：${sc.role || ''}` }));
    if (sc.goal && !this.readonly) scene.append(el('em', { text: `本次目标：${sc.goal}` }));
    box.append(scene);

    const msgs = el('div', { class: 'sp-msgs' });
    this.renderMessages(msgs);
    box.append(msgs);

    if (this.readonly || this.ended) {
      const acts = el('div', { class: 'sp-actions' });
      if (!this.readonly) {
        const again = el('button', { class: 'btn small primary', text: '再练一次' });
        again.addEventListener('click', () => this.start(this.scenario));
        acts.append(again);
      }
      const back = el('button', {
        class: 'btn small',
        text: this.from === 'records' ? '返回学习记录' : '回到场景列表',
      });
      back.addEventListener('click', () => {
        this.readonly = false;
        this.ended = false;
        if (this.from === 'records') this.close();
        else this.renderPicker();
      });
      acts.append(back);
      box.append(acts);
    } else {
      const inputRow = el('div', { class: 'sp-input' });
      const ta = el('textarea', { id: 'spInput', rows: '1', placeholder: '直接说；也可以打字' });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.send();
        }
      });
      const mic = el('button', { class: 'sp-mic', id: 'spMic', title: '点一下开始说，说完自动发出去' });
      mic.append(el('span', { class: 'sp-mic-ico', text: '🎙' }));
      mic.addEventListener('click', () => this.onMicClick());
      const send = el('button', { class: 'sp-send', text: '发送' });
      send.addEventListener('click', () => this.send());
      inputRow.append(ta, mic, send);

      const bar = el('div', { class: 'sp-bar' });
      const status = el('div', { class: 'sp-status', id: 'spStatus', text: '点麦克风开始说，说完自动发出去' });
      const hands = el('button', { class: 'sp-tg' + (this.handsFree ? ' on' : ''), text: '免提' });
      hands.title = '开着：对方说完自动开麦，你说完自动发送，全程不用点';
      hands.addEventListener('click', () => {
        this.handsFree = !this.handsFree;
        hands.classList.toggle('on', this.handsFree);
        if (!this.handsFree) {
          this.stopListening();
          this.updateStatus('免提已关：点麦克风才说话');
        } else if (this.phase === 'idle') {
          this.armMic();
        }
      });
      const tts = el('button', { class: 'sp-tg' + (this.autoSpeak ? ' on' : ''), text: '朗读' });
      tts.title = '对方的话自动读出来';
      tts.addEventListener('click', () => {
        this.autoSpeak = !this.autoSpeak;
        tts.classList.toggle('on', this.autoSpeak);
        if (!this.autoSpeak) stopSpeak();
      });
      bar.append(hands, tts, status);

      const actions = el('div', { class: 'sp-actions' });
      const end = el('button', { class: 'btn small', text: '结束并复盘' });
      end.addEventListener('click', () => this.endSession());
      const swap = el('button', { class: 'btn small', text: '换场景' });
      swap.addEventListener('click', () => {
        const n = this.messages.filter((m) => m.role === 'user').length;
        if (n && !confirm('换场景会丢掉当前对话，确定？')) return;
        this.renderPicker();
      });
      actions.append(end, swap, el('span', { class: 'sp-count', id: 'spCount', text: this.countText() }));

      // 输入、开关、操作合成一个托盘，左右边距和圆角才对得齐
      const tray = el('div', { class: 'sp-tray' });
      tray.append(inputRow, bar, actions);
      box.append(tray);
    }

    body.append(box);
    this.scrollMsgs();
    this.paintPhase();
    if (this.review) this.appendReview();
  }

  countText() {
    const n = this.messages.filter((m) => m.role === 'user').length;
    return n ? `已聊 ${n} 轮` : '还没开始';
  }

  renderMessages(container) {
    container.replaceChildren();
    for (const m of this.messages) {
      const row = el('div', { class: 'sp-msg ' + (m.role === 'user' ? 'me' : 'them') });
      const bubble = el('div', { class: 'sp-bubble' });
      bubble.append(el('p', { text: m.content }));
      if (m.role === 'assistant' && !m.opening) {
        const sp = el('button', { class: 'mini-spk', text: '🔊', title: '朗读' });
        sp.addEventListener('click', () => speak(m.content));
        bubble.append(sp);
      }
      row.append(bubble);
      container.append(row);
    }
  }

  scrollMsgs() {
    const box = $('.sp-msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }

  /* ───────────── 发消息 ───────────── */

  async send(preset) {
    if (this.sending || this.readonly) return;
    const ta = $('#spInput');
    const text = String(preset ?? ta?.value ?? '').trim();
    if (!text) return;
    if (ta) {
      ta.value = '';
      ta.style.height = 'auto';
    }
    this.messages.push({ role: 'user', content: text });
    this.renderMessages($('.sp-msgs'));
    this.scrollMsgs();
    this.setTyping(true);
    this.phase = 'thinking';
    this.paintPhase();
    this.updateStatus('稍等，对方在想…');

    let replied = '';
    try {
      const res = await api.chatReply({
        scenario: `${this.scenario.catName || ''} · ${this.scenario.title}：${this.scenario.goal || ''}`,
        role: this.scenario.role,
        messages: this.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      if (!res.reply) throw new Error('对方没有回应，再试一次');
      this.messages.push({ role: 'assistant', content: res.reply });
      replied = res.reply;
    } catch (e) {
      this.messages.push({ role: 'assistant', content: `（连接失败：${e.message}）`, error: true });
      toast(`对方没接上：${e.message}`, 3600);
    } finally {
      this.setTyping(false);
      this.renderMessages($('.sp-msgs'));
      const cnt = $('#spCount');
      if (cnt) cnt.textContent = this.countText();
      this.scrollMsgs();
    }

    if (replied) this.speakReply(replied);
    else {
      this.phase = 'idle';
      this.paintPhase();
      this.updateStatus('没连上，检查一下 API Key 或网络');
    }
  }

  setTyping(on) {
    this.sending = on;
    const box = $('.sp-msgs');
    if (!box) return;
    let dot = box.querySelector('.sp-typing');
    if (on) {
      if (!dot) {
        dot = el('div', { class: 'sp-msg them sp-typing' }, el('div', { class: 'sp-bubble' }, el('span', { text: '对方正在想…' })));
        box.append(dot);
        box.scrollTop = box.scrollHeight;
      }
    } else {
      dot?.remove();
    }
  }

  /* ───────────── 语音对话：免提、自动断句、自动发送 ─────────────
     一整套循环：对方说完 → 自动开麦 → 你说完（静音 1.5 秒）→ 自动停
     → 本地识别 → 自动发送 → AI 回话 → 自动朗读 → 再开麦。 */

  onMicClick() {
    if (this.readonly || this.ended) return;
    if (this.phase === 'listening') {
      this.finishUtterance();
      return;
    }
    stopSpeak();
    this.failCount = 0;
    this.armMic();
  }

  async armMic() {
    if (this.readonly || this.ended || this.sending || this.mic.active) return;
    if (!canRecord()) return toast(recordBlockedHint());
    this.phase = 'listening';
    this.paintPhase();
    try {
      await this.mic.start({
        onLevel: (v) => {
          const mic = $('#spMic');
          if (mic) mic.style.setProperty('--lv', String(v));
        },
        onAutoStop: () => this.finishUtterance(),
        silenceMs: 1100,
        minSpeechMs: 300,
        maxMs: 30000,
      });
      if (this.phase !== 'listening') this.mic.stop(); // 启动过程中被打断
    } catch (e) {
      this.phase = 'idle';
      this.paintPhase();
      this.updateStatus(`麦克风打不开：${e.message}`);
    }
  }

  async finishUtterance() {
    if (this.phase !== 'listening') return;
    this.phase = 'thinking';
    this.paintPhase();
      this.updateStatus('正在识别…');
    const blob = await this.mic.stop();
    if (!blob) return this.noSpeech('没听到声音');

    try {
      const heard = await transcribeClip(blob, { lang: 'en' });
      const text = (heard.text || '').trim();
      if (!text) return this.noSpeech('没听清');
      this.failCount = 0;
      this.phase = 'idle';
      await this.send(text);
    } catch (e) {
      this.phase = 'idle';
      this.paintPhase();
      if (e.code === 'ASR_DOWN') {
        this.updateStatus('本地识别没就绪：先跑一次「安装语音识别.bat」，也可以先打字');
        toast('语音对话需要本地识别，见 README 的安装步骤', 4200);
      } else {
        this.updateStatus(`识别失败：${e.message}，再说一次`);
      }
    }
  }

  /** 没听到东西：别立刻重开麦，连着两次就停下来让用户自己点 */
  noSpeech(msg) {
    this.phase = 'idle';
    this.paintPhase();
    this.failCount = (this.failCount || 0) + 1;
    if (this.failCount >= 2) {
      this.updateStatus(`${msg}。点麦克风再说一次，或者直接打字`);
      return;
    }
    this.updateStatus(`${msg}，再说一次`);
    if (this.handsFree) {
      setTimeout(() => {
        if (this.phase === 'idle' && !this.ended) this.armMic();
      }, 850);
    }
  }

  speakReply(text) {
    if (!text) return;
    if (!this.autoSpeak) {
      this.phase = 'idle';
      this.paintPhase();
      this.updateStatus(this.handsFree ? '轮到你说' : '点麦克风接着说');
      if (this.handsFree) setTimeout(() => this.phase === 'idle' && this.armMic(), 400);
      return;
    }
    this.phase = 'speaking';
    this.paintPhase();
    this.updateStatus('对方在说…（点麦克风可打断）');

    let done = false;
    let timer = null;
    const next = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (this.phase !== 'speaking') return; // 被打断了，别重复开麦
      this.phase = 'idle';
      this.paintPhase();
      this.updateStatus(this.handsFree ? '轮到你说' : '点麦克风接着说');
      if (this.handsFree) setTimeout(() => this.phase === 'idle' && this.armMic(), 450);
    };
    // 等音频真正开始后再计时；网络生成语音时不能提前结束当前回合。
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(next, Math.min(20000, 1400 + text.length * 78));
    };
    speak(text, { onStart: armTimer, onEnd: next });
  }

  stopListening() {
    if (this.mic.active) this.mic.stop();
    this.phase = 'idle';
    this.paintPhase();
  }

  updateStatus(text) {
    const st = $('#spStatus');
    if (st) st.textContent = text;
  }

  paintPhase() {
    const mic = $('#spMic');
    if (mic) {
      mic.classList.toggle('rec', this.phase === 'listening');
      mic.classList.toggle('think', this.phase === 'thinking' || this.phase === 'speaking');
      if (this.phase !== 'listening') mic.style.setProperty('--lv', '0');
    }
    if (this.phase === 'listening') this.updateStatus('正在听…说完自动发出去');
  }

  /* ───────────── 复盘 ───────────── */

  async endSession() {
    if (this.sending) return;
    const turns = this.messages.filter((m) => m.role === 'user').length;
    if (turns < 2) return toast('再聊两轮吧，太短的对话看不出问题', 3000);
    this.stopAll();

    const body = $('#speakBody');
    const overlay = el('div', { class: 'sp-loading', id: 'spReviewLoading' }, el('span', { text: '正在复盘这段对话…' }));
    body.append(overlay);

    try {
      const rv = await api.chatReview({
        scenario: `${this.scenario.catName || ''} · ${this.scenario.title}：${this.scenario.goal || ''}`,
        messages: this.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      this.review = rv;
      this.ended = true;
      this.sessionId = this.sessionId || `sp-${Date.now().toString(36)}`;
      await api
        .postJSON('/api/speaking', {
          item: {
            id: this.sessionId,
            at: Date.now(),
            title: this.scenario.title,
            role: this.scenario.role,
            goal: this.scenario.goal,
            messages: this.messages,
            review: rv,
          },
        })
        .catch(() => {});
      this.history = [];
      this.renderChat();
      toast('复盘好了，往下滑看问题', 3000);
    } catch (e) {
      toast(`复盘失败：${e.message}`, 4200);
    } finally {
      overlay.remove();
    }
  }

  appendReview() {
    const msgs = $('.sp-msgs');
    if (!msgs || msgs.querySelector('.rv')) return;
    const holder = el('div', { class: 'sp-review' });
    holder.append(el('div', { class: 'sp-review-title', text: '这段对话的复盘' }));
    AnalysisView.renderReview(holder, this.review, {
      scenario: `${this.scenario.title || ''}${this.scenario.goal ? ` · ${this.scenario.goal}` : ''}`,
    });
    msgs.append(holder);
    msgs.scrollTop = msgs.scrollHeight;
  }
}
