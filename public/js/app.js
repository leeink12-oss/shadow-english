// 主编排
import { $, $$, el, toast, busy, debounce, fmtTime, escapeHtml, hashId } from './util.js';
import { decodeBuffer, parseSubtitles, mergeFragments } from './srt.js';
import { Player } from './player.js';
import { SubtitleView } from './render.js';
import { Vocab } from './vocab.js';
import * as api from './api.js';
import { getAsrEnv, uploadVideo, waitJob, cancelJob } from './asr.js';
import { speak } from './practice.js';
import { AnalysisView } from './analysis.js';
import { Library } from './library.js';
import { Speaking } from './speaking.js';
import { Records } from './records.js';
import { VOICE_PROFILES, setVoiceProfile, setSpeechRate } from './tts.js';

const MODE_GAP = {
  bilingual: 'none',
  blind: 'none',
  intensive: 'delay',
  shadow: 'pause',
  dictation: 'pause',
  cloze: 'pause',
};
const MODE_LABEL = {
  intensive: '精听',
  bilingual: '双语',
  blind: '盲听',
  shadow: '跟读',
  dictation: '听写',
  cloze: '挖空',
};
const RATES = [1, 1.25, 1.5, 0.75, 0.5];

const state = {
  course: null,
  courseId: null,
  mode: 'bilingual',
  tab: 'subs',
  continuous: true,
  rate: 1,
  settings: { autoScroll: true, overlayCaption: true, zhDelay: 0, ttsVoice: 'young-female', ttsRate: 1 },
  player: null,
  view: null,
  vocab: null,
  library: null,
  analysis: null,
  speaking: null,
  records: null,
  videoFile: null,
  videoUrl: null,
  ab: { a: null, b: null },
  _gapTimer: null,
};

/* ════════════════════ 启动 ════════════════════ */
async function init() {
  state.vocab = new Vocab({
    onChange: () => {
      $('#vocabCount').textContent = state.vocab.items.length;
      state.view?.refreshSaved(new Set(state.vocab.items.map((it) => api.normKey(it.word))));
    },
  });

  state.library = new Library({
    onChange: (n) => {
      const a = $('#libCount');
      const b = $('#libCount2');
      if (a) a.textContent = n;
      if (b) b.textContent = n;
    },
  });
  state.speaking = new Speaking({ library: state.library });
  state.records = new Records({
    onOpenCourse: async ({ id, title, videoName }) => {
      try {
        busy.show('读取课程…', 30);
        const res = await api.getJSON(`/api/courses/${encodeURIComponent(id)}`);
        busy.hide();
        if (!res.course) throw new Error('课程不存在');
        await openCourse(res.course, null);
        toast(videoName ? `请选择视频文件：${videoName}` : `继续学习「${title || res.course.title}」`, 3200);
      } catch (e) {
        busy.hide();
        toast(`打开课程失败：${e.message}`, 3600);
      }
    },
    onOpenSpeaking: (session) => {
      $('#records').hidden = true;
      $('#welcome').hidden = true;
      $('#study').hidden = true;
      $('#speaking').hidden = false;
      state.speaking.from = 'records';
      state.speaking.history = state.records.speaking || [];
      state.speaking.openSession(session);
    },
    onOpenLibrary: () => {
      $('#records').hidden = true;
      $('#welcome').hidden = false;
      openSheet('maskLib');
      state.library.renderPanel();
    },
    onOpenVocab: () => {
      $('#records').hidden = true;
      $('#welcome').hidden = false;
      openSheet('maskVocab');
      state.vocab.renderPanel();
    },
  });

  state.player = new Player($('#video'), {
    onIndexChange: (idx) => {
      state.view?.setActive(idx);
      updateTimeUI();
    },
    onSegmentEnd: handleSegmentEnd,
    onPlayState: (playing) => updatePlayIcon(playing),
    onEnded: () => updatePlayIcon(false),
    onTime: (t) => updateProgress(t),
  });

  bindImport();
  bindStudy();
  bindSheets();
  bindTabs();
  initVoiceControls();

  try {
    const [cfg, courses] = await Promise.all([api.getJSON('/api/config'), api.getJSON('/api/courses')]);
    state.settings = {
      autoScroll: true,
      overlayCaption: true,
      zhDelay: 0,
      ttsVoice: 'young-female',
      ttsRate: 1,
      ...(cfg.settings || {}),
    };
    applySettingsToUI();
    if (!cfg.hasKey) setTimeout(() => toast('还没配置 DeepSeek API Key，点右上角 ⚙ 填写后才能用 AI 功能', 4200), 800);
    renderCourseList(courses.items || []);
    renderPicked();
  } catch (e) {
    toast(`本地服务连接失败：${e.message}`);
  }

  loadAsrEnv(); // 后台探测语音识别环境，不阻塞首页

  await api.loadWordCache();
  await state.vocab.load();
  $('#vocabCount').textContent = state.vocab.items.length;
  await state.library.load();
}

/* ════════════════════ Tab 切换 ════════════════════ */
function bindTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  const openScenes = () => state.speaking.open(null, { from: 'welcome' });
  const setActiveNav = (id) => {
    $$('.home-nav-item').forEach((btn) => btn.classList.toggle('active', btn.id === id));
  };

  $('#btnGoSpeaking').addEventListener('click', () => {
    setActiveNav('btnNavPractice');
    state.speaking.open('weekend', { from: 'welcome' });
  });
  $('#btnHeroScenes').addEventListener('click', openScenes);
  $('#btnNavPractice').addEventListener('click', () => {
    setActiveNav('btnNavPractice');
    openScenes();
  });
  $('#btnNavScenes').addEventListener('click', () => {
    setActiveNav('btnNavScenes');
    openScenes();
  });
  $('#btnQuickFood').addEventListener('click', () => state.speaking.open('food', { from: 'welcome' }));
  $('#btnQuickTravel').addEventListener('click', () => state.speaking.open('way', { from: 'welcome' }));
  $('#btnQuickWork').addEventListener('click', () => state.speaking.open('standup', { from: 'welcome' }));
  $('#btnQuickFilm').addEventListener('click', () => {
    toast('选择一段视频或影视片段，之后可以逐句跟读和复述', 3000);
    $('#btnPickVideo').click();
  });
  $$('.home-filter button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const category = btn.dataset.category;
      $$('.home-filter button').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      $$('.practice-grid > [data-group]').forEach((card) => {
        card.hidden = !card.dataset.group.split(/\s+/).includes(category);
      });
    });
  });
  $('#btnNavCourses').addEventListener('click', () => {
    setActiveNav('btnNavCourses');
    state.records.open();
  });
  $('#speakingVoice').addEventListener('change', (e) => {
    state.settings.ttsVoice = e.target.value;
    setVoiceProfile(e.target.value);
    persistSettings();
    const profile = VOICE_PROFILES.find((v) => v.id === e.target.value);
    if (profile) toast(`对话声音已切换为${profile.label}，下一次回复生效`, 2600);
    const status = $('#voiceEngineStatus');
    if (status) status.lastChild.textContent = e.target.value === 'browser' ? ' 本地系统语音' : ' 神经网络语音';
  });
  $('#speakingRate').addEventListener('change', (e) => {
    state.settings.ttsRate = Number(e.target.value) || 1;
    setSpeechRate(state.settings.ttsRate);
    persistSettings();
  });
  for (const id of ['btnGoLibrary', 'btnLib']) {
    const btn = $('#' + id);
    btn?.addEventListener('click', () => {
      openSheet('maskLib');
      state.library.renderPanel();
    });
  }

  $('#btnSpeakBack').addEventListener('click', () => {
    if (state.speaking.from === 'records' && !$('#speakBody .sp-pick')) {
      state.speaking.close();
      return;
    }
    if ($('#speakBody .sp-pick')) state.speaking.close();
    else state.speaking.renderPicker();
  });
  $('#btnSpeakNew').addEventListener('click', () => {
    if ($('#speakBody .sp-pick')) return;
    const n = state.speaking.messages.filter((m) => m.role === 'user').length;
    if (n && !confirm('换场景会丢掉当前对话，确定？')) return;
    state.speaking.renderPicker();
  });
}

const PANE_ID = { expr: 'paneExpr', dialog: 'paneDialog', practice: 'panePractice' };

function switchTab(tab, focusId) {
  if (!state.course) return;
  // 实战口语不是课程内的面板，点它直接进场景列表，回来后仍停在原来的 tab
  if (tab === 'speaking') {
    state.speaking.open(null, { from: 'study' });
    return;
  }
  state.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#study').dataset.tab = tab;
  $('#subs').hidden = tab !== 'subs';
  $('#modes').hidden = tab !== 'subs';
  for (const [k, id] of Object.entries(PANE_ID)) $('#' + id).hidden = k !== tab;
  state.analysis?.show(tab);
  if (focusId) {
    const pane = $('#' + (PANE_ID[tab] || 'subs'));
    const card = pane?.querySelector(`[data-x="${focusId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1400);
    }
  }
}

/* ════════════════════ 导入 ════════════════════ */
const picked = { video: null, sub: null };
let videoPickMode = 'import';

function bindImport() {
  const drop = $('#dropZone');
  const fileVideo = $('#fileVideo');
  const fileSub = $('#fileSub');

  $('#btnPickVideo').addEventListener('click', () => {
    videoPickMode = 'import';
    fileVideo.click();
  });
  $('#btnPickSub').addEventListener('click', () => fileSub.click());

  fileVideo.addEventListener('change', () => {
    const f = fileVideo.files?.[0];
    fileVideo.value = '';
    if (!f) return;
    if (videoPickMode === 'reload') {
      attachVideo(f);
      return;
    }
    picked.video = f;
    renderPicked();
  });

  fileSub.addEventListener('change', () => {
    const f = fileSub.files?.[0];
    fileSub.value = '';
    if (!f) return;
    picked.sub = f;
    renderPicked();
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    })
  );
  drop.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    for (const f of files) {
      if (/\.(srt|vtt|txt)$/i.test(f.name)) picked.sub = f;
      else if (f.type.startsWith('video') || f.type.startsWith('audio') || /\.(mp4|mkv|webm|mov|m4a|mp3|wav|flv|avi)$/i.test(f.name)) picked.video = f;
      else toast(`不认识这个文件：${f.name}`);
    }
    renderPicked();
  });

  $('#btnBuild').addEventListener('click', buildCourse);
  $('#selModel').addEventListener('change', () => {
    const v = asrInfo?.options?.[$('#selModel').value];
    if (v) $('#asrTip').textContent = `${asrTipFor($('#selModel').value)}`;
  });
}

/* ──────────────── 语音识别环境 ──────────────── */
let asrInfo = null;

async function loadAsrEnv() {
  try {
    asrInfo = await getAsrEnv();
  } catch {
    asrInfo = { ready: false, reason: '无法连接本地服务' };
  }
  const sel = $('#selModel');
  sel.replaceChildren();
  const opts = asrInfo.options || {};
  for (const [key, v] of Object.entries(opts)) {
    const downloaded = (asrInfo.models || []).includes(key);
    sel.append(
      el('option', {
        value: key,
        text: `${v.label} · ${key}${downloaded ? ' ✓ 已下载' : ` · 需下载 ${v.size}`}`,
      })
    );
  }
  // 默认 medium：字幕准确性优先，显卡上速度完全够用
  const preferred = 'medium';
  sel.value = opts[preferred] ? preferred : asrInfo.defaultModel || 'small';

  $('#asrEnv').textContent = asrInfo.ready ? '本地识别已就绪' : `不可用：${asrInfo.reason || '未知原因'}`;
  $('#asrEnv').classList.toggle('bad', !asrInfo.ready);
  const homeAsr = $('#homeAsrStatus');
  if (homeAsr) {
    homeAsr.lastChild.textContent = asrInfo.ready ? ' 识别服务已就绪' : ' 识别服务未就绪';
    homeAsr.classList.toggle('bad', !asrInfo.ready);
  }
  $('#asrTip').textContent = asrTipFor(sel.value);
}

function asrTipFor(model) {
  const v = asrInfo?.options?.[model];
  const downloaded = (asrInfo?.models || []).includes(model);
  const hint = v?.hint || '';
  const dl = downloaded ? '模型已下载，可直接用。' : `首次使用需下载 ${v?.size || ''}（一次性，之后完全离线）。`;
  return `${hint}。${dl}识别在本机完成，视频不会上传到任何服务器。`;
}

/** 视频没有字幕时走这条路：上传 → 本地识别 → 翻译 → 建课 */
async function buildCourseFromAsr() {
  const video = picked.video;
  const model = $('#selModel').value || 'medium';
  if (!video) return;
  let jobId = null;
  try {
    busy.show('正在上传视频到本机服务…', 1);
    jobId = await uploadVideo(video, {
      model,
      lang: 'auto',
      onProgress: (p) => {
        busy.text(`正在准备视频（${Math.round(p * 100)}%）…`);
        busy.progress(1 + p * 19);
      },
    });

    let lastMsg = '';
    const job = await waitJob(jobId, (j) => {
      if (j.stage === 'download') {
        busy.text(j.msg);
        busy.progress(20 + (j.percent || 0) * 0.2);
        return;
      }
      if (j.msg && j.msg !== lastMsg) {
        lastMsg = j.msg;
        busy.text(j.msg);
      }
      // 识别阶段没有总量信息，用句数做渐近进度，避免看起来卡死
      const n = j.count || 0;
      busy.progress(Math.min(80, 42 + Math.log10(n + 1) * 16));
    });

    let sentences = (job.segments || [])
      .map((s, i) => ({ start: s.start, end: s.end, en: String(s.text || '').trim(), zh: '', i }))
      .filter((s) => s.en);

    if (!sentences.length) throw new Error('没有识别到语音内容');
    busy.text(`识别到 ${sentences.length} 句，正在整理…`);
    busy.progress(82);

    // 合并被切成半句的碎片
    sentences = mergeFragments(sentences).filter((s) => s.en && s.en.trim());
    sentences.forEach((s, i) => (s.i = i));

    if ($('#optAsrTranslate').checked) {
      busy.text(`AI 正在翻译 ${sentences.length} 句…`);
      try {
        await api.translateSentences(sentences, (d, t) => busy.progress(84 + (d / t) * 13));
      } catch (e) {
        if (e.code === 'NO_KEY') toast('没有 API Key，暂时没有中文字幕（可之后补）');
        else toast(`翻译未完成：${e.message}`, 3400);
      }
    }

    busy.progress(99);
    const title = video.name.replace(/\.[^.]+$/, '') || '未命名课程';
    const course = {
      id: `${hashId(title + video.size)}-${Date.now().toString(36).slice(-4)}`,
      title,
      videoName: video.name,
      sentences,
      createdAt: Date.now(),
      lastPos: 0,
      asr: { model: job.model, device: job.device, elapsed: job.elapsed },
    };
    await api.postJSON('/api/courses', course);
    busy.hide();

    picked.video = null;
    picked.sub = null;
    renderPicked();
    await openCourse(course, video);
    const dev = job.device === 'cuda' ? '显卡' : 'CPU';
    toast(`字幕已生成：${course.sentences.length} 句（${dev}识别，用时 ${Math.round(job.elapsed || 0)} 秒）`, 3600);
  } catch (e) {
    busy.hide();
    if (jobId) cancelJob(jobId);
    toast(`语音识别失败：${e.message}`, 5000);
  }
}

function renderPicked() {
  const box = $('#pickedList');
  box.replaceChildren();
  const add = (label, file) => {
    if (!file) return;
    const size = file.size > 1024 * 1024 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    const item = el('div', { class: 'picked-item' });
    item.append(el('span', { text: `${label}：${file.name}` }), el('em', { text: size }));
    box.append(item);
  };
  add('视频', picked.video);
  add('字幕', picked.sub);

  const hasSub = Boolean(picked.sub);
  const hasVideo = Boolean(picked.video);

  // 有字幕走字幕流程，没字幕但有视频走本地语音识别流程
  $('#optSubBox').hidden = !hasSub;
  $('#optAsrBox').hidden = hasSub || !hasVideo;
  $('#btnBuild').disabled = !hasSub && !hasVideo;

  if (hasSub) {
    $('#importNote').textContent = hasVideo ? '视频 + 字幕已就位，点右边生成课程' : '只有字幕也能建课（点击时再选视频）';
  } else if (hasVideo) {
    $('#importNote').textContent = '没有字幕，将用本地 AI 识别语音生成';
  } else {
    $('#importNote').textContent = '把视频拖进来就行';
  }
}

function setImportNote(text) {
  $('#importNote').textContent = text;
}

async function buildCourse() {
  // 没有字幕文件 → 走本地语音识别
  if (!picked.sub) {
    if (picked.video) return buildCourseFromAsr();
    return;
  }
  const optOrganize = $('#optOrganize').checked;
  const optTranslate = $('#optTranslate').checked;

  try {
    busy.show('正在读取字幕…', 4);
    const buf = await picked.sub.arrayBuffer();
    const text = decodeBuffer(buf);
    const parsed = parseSubtitles(text);
    if (!parsed.entries.length) {
      busy.hide();
      toast(parsed.warn || '字幕解析失败，请确认是 SRT/VTT 格式');
      return;
    }
    if (parsed.warn) toast(parsed.warn, 3000);

    let sentences = parsed.entries;
    busy.text(`解析到 ${sentences.length} 条字幕`);

    if (optOrganize) {
      busy.text('AI 正在整理断句（把半句合并成完整句子）…');
      try {
        sentences = await api.organizeLines(sentences, (d, t) => busy.progress(5 + (d / t) * 55));
      } catch (e) {
        if (e.code === 'NO_KEY') toast('没有 API Key，跳过智能断句');
        else toast(`智能断句失败，按原始字幕继续：${e.message}`, 3200);
        sentences = mergeFragments(parsed.entries);
      }
    } else {
      sentences = mergeFragments(parsed.entries);
    }

    sentences = sentences.filter((s) => s.en && s.en.trim().length > 0);
    sentences.forEach((s, i) => (s.i = i));
    if (!sentences.length) throw new Error('整理后没有有效的英文句子');

    if (optTranslate) {
      const need = sentences.filter((s) => !s.zh).length;
      if (need) {
        busy.text(`AI 正在翻译 ${need} 句字幕…`);
        try {
          await api.translateSentences(sentences, (d, t) => busy.progress(62 + (d / t) * 34));
        } catch (e) {
          if (e.code === 'NO_KEY') toast('没有 API Key，暂时没有中文字幕');
          else toast(`翻译未完成：${e.message}`, 3200);
        }
      }
    }

    busy.progress(99);
    const title = picked.sub.name.replace(/\.(srt|vtt|txt)$/i, '') || '未命名课程';
    const course = {
      id: `${hashId(title + (picked.video?.name || '') + picked.sub.size)}-${Date.now().toString(36).slice(-4)}`,
      title,
      videoName: picked.video?.name || '',
      sentences,
      createdAt: Date.now(),
      lastPos: 0,
    };
    await api.postJSON('/api/courses', course);
    busy.hide();

    const vf = picked.video;
    picked.video = null;
    picked.sub = null;
    renderPicked();
    await openCourse(course, vf);
    toast(`课程已生成：${course.sentences.length} 句`);
  } catch (e) {
    busy.hide();
    toast(`导入失败：${e.message}`, 4000);
  }
}

/* ════════════════════ 课程列表 ════════════════════ */
function renderCourseList(items) {
  const box = $('#courseList');
  const title = $('#courseListTitle');
  box.replaceChildren();
  title.hidden = !items.length;
  if (!items.length) return;
  for (const c of items) {
    const card = el('button', { class: 'course-card' });
    const main = el('div', { class: 'cc-main' });
    main.append(
      el('div', { class: 'cc-title', text: c.title }),
      el('div', {
        class: 'cc-meta',
        text: `${c.count} 句 · ${new Date(c.createdAt || Date.now()).toLocaleDateString('zh-CN')}${c.videoName ? ` · ${c.videoName}` : ''}`,
      })
    );
    const del = el('button', { class: 'icon-btn cc-del', title: '删除课程', html: '✕' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除课程「${c.title}」？\n文件会挪到 data/trash，误删还能捞回来；生词本不受影响。`)) return;
      await api.delJSON(`/api/courses/${encodeURIComponent(c.id)}`);
      card.remove();
      toast('已删除');
    });
    card.append(main, del);
    card.addEventListener('click', async () => {
      try {
        busy.show('读取课程…', 30);
        const res = await api.getJSON(`/api/courses/${encodeURIComponent(c.id)}`);
        busy.hide();
        if (!res.course) throw new Error('课程不存在');
        await openCourse(res.course, null);
        toast(c.videoName ? `请选择视频文件：${c.videoName}` : '请选择这个课程对应的视频文件', 3600);
      } catch (e) {
        busy.hide();
        toast(`打开失败：${e.message}`);
      }
    });
    box.append(card);
  }
}

/* ════════════════════ 打开课程 ════════════════════ */
async function openCourse(course, videoFile) {
  const prevId = state.courseId;
  state.course = course;
  state.courseId = course.id;
  if (!Array.isArray(course.sentences)) course.sentences = [];

  $('#welcome').hidden = true;
  $('#study').hidden = false;
  $('#courseTitle').textContent = course.title;

  state.mode = 'bilingual';
  state.continuous = true;
  state.ab = { a: null, b: null };
  state.tab = 'subs';
  setModeUI('bilingual');
  switchTab('subs');
  updateProgress(0);

  state.view = null;
  state.player.setSentences(course.sentences);
  state.view = new SubtitleView($('#subs'), {
    course,
    player: state.player,
    onWord: (word, anchor) => {
      const s = course.sentences[state.player.index];
      state.vocab.openCard(word, s?.en || '', anchor);
    },
    onDirty: scheduleSave,
    getSettings: () => state.settings,
    isSaved: (w) => state.vocab.has(w),
  });
  state.view.renderAll();
  state.view.refreshSaved(new Set(state.vocab.items.map((it) => api.normKey(it.word))));
  state.view.setActive(0, { force: true });

  state.analysis = new AnalysisView(course, {
    onDirty: scheduleSave,
    onSeek: (si) => {
      if (!state.videoUrl) return toast('先选一下这个课程对应的视频文件');
      state.player.seekToIndex(si, { play: true });
    },
    library: state.library,
    goTab: (t, id) => switchTab(t, id),
    goSpeaking: () => state.speaking.open(null, { from: 'study' }),
  });
  state.analysis.renderAll();

  applyModeGap();
  state.player.setRate(state.rate);

  // 视频来源：新选的 / 同一课程沿用旧的 / 否则清空等用户选
  if (videoFile) {
    attachVideo(videoFile);
  } else if (!(prevId === course.id && state.videoUrl)) {
    clearVideo();
  } else {
    $('#videoPlaceholder').hidden = true;
    $('#videoShell').classList.add('has-video');
  }

  // 回到上次播放位置
  if (course.lastPos > 3) {
    const resume = () => {
      state.player.seek(course.lastPos);
      state.view.setActive(state.player.index >= 0 ? state.player.index : 0, { force: true });
    };
    if ($('#video').readyState >= 1) setTimeout(resume, 120);
    else $('#video').addEventListener('loadedmetadata', resume, { once: true });
  }
}

/**
 * 让画面按视频真实比例撑开：宽高一起算，容器比例等于视频比例，才不会有黑边。
 * 横屏片按宽度铺满，竖屏片按高度贴边——两种情况都居中。
 */
function fitStage() {
  const v = $('#video');
  const shell = $('#videoShell');
  if (!shell || !v?.videoWidth) return;
  const host = shell.parentElement;
  const availW = (host?.clientWidth || window.innerWidth) - 20;
  if (availW <= 0) return;
  const ratio = v.videoWidth / v.videoHeight;
  const maxH = Math.min(window.innerHeight * 0.32, 320);
  let w = availW;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  shell.style.setProperty('--stage-w', Math.round(w) + 'px');
  shell.style.setProperty('--stage-h', Math.round(h) + 'px');
}

let _fitTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(_fitTimer);
  _fitTimer = setTimeout(fitStage, 140);
});

function clearVideo() {
  const video = $('#video');
  try {
    video.pause();
  } catch { /* ignore */ }
  if (state.videoUrl) {
    URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = null;
  }
  state.videoFile = null;
  video.removeAttribute('src');
  try {
    video.load();
  } catch { /* ignore */ }
  $('#videoPlaceholder').hidden = false;
  $('#videoShell').classList.remove('has-video');
  $('#videoShell').style.removeProperty('--stage-h');
  $('#videoShell').style.removeProperty('--stage-w');
  updateProgress(0);
}

function attachVideo(file) {
  const video = $('#video');
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  state.videoFile = file;
  video.src = state.videoUrl;
  video.load();
  $('#videoPlaceholder').hidden = true;
  $('#videoShell').classList.add('has-video');
  if (state.course && !state.course.videoName) {
    state.course.videoName = file.name;
    scheduleSave();
  }
  video.addEventListener(
    'loadedmetadata',
    () => {
      if (state.course) {
        state.course.duration = video.duration || 0;
        scheduleSave();
      }
      fitStage();
      updateProgress(video.currentTime || 0);
    },
    { once: true }
  );
  video.addEventListener('error', () => toast('这个视频浏览器可能不支持，试试转成 mp4（H.264）', 4000), { once: true });
}

function updateProgress(t) {
  const fill = $('#vbarFill');
  const d = state.player?.duration || $('#video').duration || 0;
  if (fill) fill.style.width = d ? `${Math.min(100, (t / d) * 100)}%` : '0%';
  const cur = $('#stageTime');
  if (cur) cur.textContent = fmtTime(t);
  const dur = $('#stageDur');
  if (dur && d) dur.textContent = fmtTime(d);
}

/* ════════════════════ 学习界面控件 ════════════════════ */
function bindStudy() {
  $('#btnHome').addEventListener('click', backHome);
  $('#btnPlay').addEventListener('click', () => {
    if (!state.videoUrl) return toast('先选一下这个课程对应的视频文件');
    state.player.toggle();
  });
  $('#btnStagePlay').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.videoUrl) return toast('先选一下这个课程对应的视频文件');
    state.player.toggle();
  });
  $('#btnPrev').addEventListener('click', () => {
    if (!state.videoUrl) return toast('先选一下视频文件');
    state.player.prev();
    updateTimeUI();
  });
  $('#btnNext').addEventListener('click', () => {
    if (!state.videoUrl) return toast('先选一下视频文件');
    state.player.next();
    updateTimeUI();
  });
  $('#btnPrevCourse').addEventListener('click', () => switchCourse(-1));
  $('#btnNextCourse').addEventListener('click', () => switchCourse(1));
  $('#video').addEventListener('click', () => {
    if (!state.videoUrl) return;
    state.player.toggle();
  });
  $('#video').addEventListener('dblclick', () => {
    const v = $('#video');
    if (document.fullscreenElement) document.exitFullscreen();
    else v.requestFullscreen?.().catch(() => toast('这个浏览器不支持全屏'));
  });
  $('#vbar').addEventListener('click', (e) => {
    const d = state.player.duration;
    if (!d) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    state.player.seek(ratio * d);
  });
  $('#btnReloadVideo').addEventListener('click', () => {
    videoPickMode = 'reload';
    $('#fileVideo').click();
  });

  $('#modes').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    applyMode(btn.dataset.mode);
  });

  $('#btnRate').addEventListener('click', () => {
    const i = RATES.indexOf(state.rate);
    state.rate = RATES[(i + 1) % RATES.length];
    state.player.setRate(state.rate);
    $('#btnRate').textContent = `${state.rate.toFixed(2).replace(/0$/, '')}x`;
    toast(`播放速度 ${state.rate}x`);
  });

  $('#btnLoopOne').addEventListener('click', (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    state.player.loopOne = on;
    toast(on ? '单句循环：开' : '单句循环：关');
  });

  $('#btnLoopAll').addEventListener('click', (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    state.player.loopAll = on;
    toast(on ? '全片循环：开' : '全片循环：关');
  });

  $('#btnAuto').addEventListener('click', (e) => {
    state.continuous = !state.continuous;
    e.currentTarget.classList.toggle('on', state.continuous);
    applyModeGap();
    toast(state.continuous ? '连播：开（句末不停）' : '连播：关（句末停顿）');
  });

  $('#btnWordGloss').addEventListener('click', (e) => {
    const on = !state.view.wordGloss;
    e.currentTarget.classList.toggle('on', on);
    state.view.setWordGloss(on);
    toast(on ? '逐词释义：开' : '逐词释义：关');
  });

  $('#btnIpa').addEventListener('click', (e) => {
    const on = !state.view.ipa;
    e.currentTarget.classList.toggle('on', on);
    state.view.setIpa(on);
    toast(on ? '整句音标：开（按当前句生成）' : '整句音标：关');
  });

  $('#btnAB').addEventListener('click', onABClick);

  $('#btnMore').addEventListener('click', () => {
    openSheet('maskVocab');
    state.vocab.renderPanel();
  });

  $('#btnVocab').addEventListener('click', () => {
    openSheet('maskVocab');
    state.vocab.renderPanel();
  });

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    if ($('#study').hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === ' ') {
      e.preventDefault();
      state.player.toggle();
    } else if (e.key === 'ArrowLeft') {
      state.player.prev();
    } else if (e.key === 'ArrowRight') {
      state.player.next();
    } else if (e.key === 'ArrowUp') {
      state.player.seekToIndex(Math.max(0, state.player.index - 1), { play: true });
    } else if (e.key === 'ArrowDown') {
      state.player.seekToIndex(Math.min(course_len() - 1, state.player.index + 1), { play: true });
    } else if (e.key === 'r' || e.key === 'R') {
      state.player.seekToIndex(state.player.index, { play: true });
    } else if (e.key.toLowerCase() === 'j') {
      state.player.seek(Math.max(0, $('#video').currentTime - 3));
    } else if (e.key.toLowerCase() === 'l') {
      state.player.seek($('#video').currentTime + 3);
    }
  });

  setInterval(() => {
    if (state.course && !$('#study').hidden) {
      state.course.lastPos = $('#video').currentTime || 0;
      scheduleSave();
    }
  }, 20000);
}

const course_len = () => state.course?.sentences.length || 0;

function applyMode(mode) {
  if (!MODE_GAP[mode]) return;
  state.mode = mode;
  if (mode === 'shadow' && !navigator.mediaDevices?.getUserMedia) toast('这个浏览器不支持录音');
  // 练习类模式默认句末停，通读类默认连播
  state.continuous = MODE_GAP[mode] === 'none';
  setModeUI(mode);
  state.view.setMode(mode);
  applyModeGap();
  $('#btnAuto').classList.toggle('on', state.continuous);
}

function setModeUI(mode) {
  $$('#modes button[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#study').dataset.mode = mode;
}

function applyModeGap() {
  const p = state.player;
  if (!p) return;
  if (state.continuous) {
    p.gapMode = 'none';
  } else {
    p.gapMode = MODE_GAP[state.mode] === 'none' ? 'pause' : MODE_GAP[state.mode];
  }
  p.gapMs = 600;
}

function handleSegmentEnd(idx) {
  clearTimeout(state._gapTimer);
  if (state.mode === 'intensive') {
    state._gapTimer = setTimeout(() => {
      if (state.player.inGap && state.player.index === idx) {
        state.player.seekToIndex(Math.min(idx + 1, course_len() - 1), { play: true });
      }
    }, 620);
  } else if (state.mode === 'shadow') {
    state.view.autoShadow(idx);
  } else if (state.mode === 'dictation') {
    state.view.scrollToIndex(idx);
  }
  updatePlayIcon(false);
}

function updatePlayIcon(playing) {
  const PLAY = '<path d="M8 4.8l11.4 7.2L8 19.2z" fill="currentColor" stroke="none"/>';
  const PAUSE = '<rect x="7" y="4.6" width="3.6" height="14.8" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.4" y="4.6" width="3.6" height="14.8" rx="1.3" fill="currentColor" stroke="none"/>';
  const icon = $('#playIcon');
  if (icon) icon.innerHTML = playing ? PAUSE : PLAY;
  const stage = $('#stageIcon');
  if (stage) stage.innerHTML = playing ? PAUSE : PLAY;
  $('#videoShell')?.classList.toggle('is-playing', playing);
  $('#btnStagePlay')?.classList.toggle('is-playing', playing);
}

function updateTimeUI() {
  updatePlayIcon(!$('#video').paused);
}

function onABClick(e) {
  const btn = e.currentTarget;
  const t = $('#video').currentTime;
  if (state.ab.a == null) {
    state.ab.a = t;
    btn.classList.add('on');
    btn.textContent = `A ${fmtTime(t)}`;
    toast(`A 点：${fmtTime(t, true)}，再点一次设置 B 点`);
  } else if (state.ab.b == null) {
    state.ab.b = Math.max(t, state.ab.a + 0.4);
    state.player.ab = { a: state.ab.a, b: state.ab.b };
    btn.textContent = `B ${fmtTime(state.ab.b)}`;
    toast(`AB 段落 ${fmtTime(state.ab.a)} → ${fmtTime(state.ab.b)}，循环播放中`);
    state.player.play();
  } else {
    state.ab = { a: null, b: null };
    state.player.ab = { a: null, b: null };
    btn.classList.remove('on');
    btn.textContent = 'AB 点';
    toast('已清除 AB 段落');
  }
}

async function switchCourse(dir) {
  if (!state.course) return;
  try {
    const { items } = await api.getJSON('/api/courses');
    const i = items.findIndex((c) => c.id === state.course.id);
    if (i < 0) return toast('课程列表里找不到当前课程');
    const target = items[i + dir];
    if (!target) return toast(dir > 0 ? '已经是最后一课了' : '已经是第一课了');
    state.player.pause();
    await saveCourseNow();
    const res = await api.getJSON(`/api/courses/${encodeURIComponent(target.id)}`);
    if (!res.course) throw new Error('课程文件丢失');
    await openCourse(res.course, null);
    toast(`已切到「${target.title}」，请选择对应视频文件`, 3200);
  } catch (e) {
    toast(`切换失败：${e.message}`);
  }
}

async function backHome() {  state.player.pause();
  $('#study').hidden = true;
  $('#welcome').hidden = false;
  if (state.course) {
    state.course.lastPos = $('#video').currentTime || 0;
    await saveCourseNow();
  }
  try {
    const courses = await api.getJSON('/api/courses');
    renderCourseList(courses.items || []);
  } catch { /* ignore */ }
}

/* ════════════════════ 保存 ════════════════════ */
async function saveCourseNow() {
  if (!state.course) return;
  try {
    await api.postJSON('/api/courses', state.course);
  } catch (e) {
    console.warn('保存失败', e);
  }
}
const scheduleSave = debounce(saveCourseNow, 1500);

/* ════════════════════ 设置面板 ════════════════════ */
function bindSheets() {
  $$('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.close;
      $('#' + id).hidden = true;
    })
  );
  $$('.sheet-mask').forEach((mask) =>
    mask.addEventListener('click', (e) => {
      if (e.target === mask) mask.hidden = true;
    })
  );

  const openSettings = async () => {
    openSheet('maskSettings');
    try {
      const cfg = await api.getJSON('/api/config');
      $('#inpKey').value = '';
      $('#inpKey').placeholder = cfg.hasKey ? `已保存 ${cfg.keyPreview}（留空不改）` : 'sk-...';
      $('#keyStatus').textContent = cfg.hasKey ? '已配置，可以使用 AI 功能' : '未配置，AI 功能不可用';
      $('#inpBase').value = cfg.baseUrl || 'https://api.deepseek.com';
      $('#inpModel').value = cfg.model || 'deepseek-chat';
    } catch { /* ignore */ }
  };

  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnSettingsHome').addEventListener('click', openSettings);

  $('#btnProfile').addEventListener('click', async () => {
    openSheet('maskProfile');
    const values = $$('#profileMetrics b');
    values.forEach((node) => (node.textContent = '…'));
    try {
      const [courses, speaking, expressions, vocab] = await Promise.all([
        api.getJSON('/api/courses'),
        api.getJSON('/api/speaking'),
        api.getJSON('/api/expressions'),
        api.getJSON('/api/vocab'),
      ]);
      const courseItems = Array.isArray(courses.items) ? courses.items : [];
      const details = await api.mapLimit(courseItems.slice(0, 40), 4, async (course) => {
        try {
          return (await api.getJSON(`/api/courses/${encodeURIComponent(course.id)}`)).course;
        } catch {
          return null;
        }
      });
      const turns = (speaking.items || []).reduce(
        (sum, item) => sum + (item.messages || []).filter((m) => m.role === 'user').length,
        0
      );
      const shadows = details.reduce(
        (sum, course) =>
          sum + (course?.sentences || []).filter((s) => Number.isFinite(Number(s.shadow?.score))).length,
        0
      );
      const saved = (expressions.items || []).length + (vocab.items || []).length;
      [courseItems.length, turns, shadows, saved].forEach((value, i) => {
        if (values[i]) values[i].textContent = String(value);
      });
    } catch {
      values.forEach((node) => (node.textContent = '—'));
    }
  });
  $('#btnProfileRecords').addEventListener('click', () => {
    $('#maskProfile').hidden = true;
    state.records.open();
  });
  $('#btnProfileLibrary').addEventListener('click', () => {
    $('#maskProfile').hidden = true;
    openSheet('maskLib');
    state.library.renderPanel();
  });
  $('#btnProfileVocab').addEventListener('click', () => {
    $('#maskProfile').hidden = true;
    openSheet('maskVocab');
    state.vocab.renderPanel();
  });
  $('#btnProfileSettings').addEventListener('click', () => {
    $('#maskProfile').hidden = true;
    openSettings();
  });

  $('#btnSaveKey').addEventListener('click', async () => {
    const body = {
      baseUrl: $('#inpBase').value.trim(),
      model: $('#inpModel').value.trim(),
      settings: state.settings,
    };
    const key = $('#inpKey').value.trim();
    if (key) body.apiKey = key;
    try {
      await api.postJSON('/api/config', body);
      toast(key ? 'Key 已保存' : '设置已保存');
      $('#maskSettings').hidden = true;
    } catch (e) {
      toast(`保存失败：${e.message}`);
    }
  });

  $('#selZhDelay').addEventListener('change', (e) => {
    state.settings.zhDelay = Number(e.target.value);
    persistSettings();
  });
  $('#optAutoScroll').addEventListener('change', (e) => {
    state.settings.autoScroll = e.target.checked;
    persistSettings();
  });
  $('#optOverlayCaption').addEventListener('change', (e) => {
    state.settings.overlayCaption = e.target.checked;
    $('#videoOverlay').style.display = e.target.checked ? '' : 'none';
    persistSettings();
  });

  $('#btnExportVocab').addEventListener('click', () => state.vocab.exportCSV());
  $('#btnDeleteCourse').addEventListener('click', async () => {
    if (!state.course) return;
    if (!confirm(`删除课程「${state.course.title}」？`)) return;
    await api.delJSON(`/api/courses/${encodeURIComponent(state.course.id)}`);
    $('#maskSettings').hidden = true;
    toast('课程已删除');
    backHome();
  });

  $('#btnBusyCancel').addEventListener('click', () => busy.hide());
}

async function persistSettings() {
  try {
    await api.postJSON('/api/config', { settings: state.settings });
  } catch { /* ignore */ }
}

function applySettingsToUI() {
  $('#selZhDelay').value = String(state.settings.zhDelay || 0);
  $('#optAutoScroll').checked = state.settings.autoScroll !== false;
  $('#optOverlayCaption').checked = state.settings.overlayCaption !== false;
  $('#videoOverlay').style.display = state.settings.overlayCaption === false ? 'none' : '';
  $('#speakingVoice').value = state.settings.ttsVoice || 'young-female';
  $('#speakingRate').value = String(state.settings.ttsRate || 1);
  setVoiceProfile(state.settings.ttsVoice || 'young-female');
  setSpeechRate(state.settings.ttsRate || 1);
  const voiceEngine = $('#voiceEngineStatus');
  if (voiceEngine) {
    voiceEngine.lastChild.textContent =
      state.settings.ttsVoice === 'browser' ? ' 本地系统语音' : ' 神经网络语音';
  }
}

function initVoiceControls() {
  const select = $('#speakingVoice');
  select.replaceChildren(
    ...VOICE_PROFILES.map((voice) =>
      el('option', {
        value: voice.id,
        text: voice.label,
        title: voice.detail,
      })
    )
  );
  select.value = state.settings.ttsVoice || 'young-female';
  $('#speakingRate').value = String(state.settings.ttsRate || 1);
  setVoiceProfile(select.value);
  setSpeechRate(Number($('#speakingRate').value));
  const engine = $('#voiceEngineStatus');
  if (engine) engine.lastChild.textContent = select.value === 'browser' ? ' 本地系统语音' : ' 神经网络语音';
  window.addEventListener('tts-neural', () => {
    const status = $('#voiceEngineStatus');
    if (status) status.lastChild.textContent = ' 神经网络语音';
  });
  window.addEventListener('tts-fallback', () => {
    const status = $('#voiceEngineStatus');
    if (status) status.lastChild.textContent = ' 本地系统语音';
  });
}

function openSheet(id) {
  $('#' + id).hidden = false;
}

init();
