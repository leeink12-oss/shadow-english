'use strict';

/**
 * 影读英语 · 语音识别服务（本地 faster-whisper）
 *
 * 流程：浏览器把视频原始字节 POST 到 /api/asr/upload → 落盘 → 起子进程跑 whisper
 *      → 逐条 segment 回传 → 前端轮询 /api/asr/job/:id 拿进度和结果
 *
 * 之所以要走上传，是因为浏览器出于安全不给网页真实文件路径，
 * Python 读不到 File 对象。localhost 上传不限速，实测不会卡。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

// 画质/体积取舍：模型越大越准也越慢，首次下载体积见注释
const MODELS = {
  tiny: { label: '极速', size: '75 MB', hint: '适合试水，准确率一般' },
  base: { label: '快速', size: '145 MB', hint: 'CPU 推荐，普通英文口播速度最快' },
  small: { label: '均衡', size: '466 MB', hint: '准确度与速度平衡' },
  medium: { label: '精准', size: '1.5 GB', hint: '口音或术语较多时使用；CPU 上较慢' },
  'large-v3': { label: '最准', size: '3.1 GB', hint: '16G 显存跑得动，最慢最准' },
};

const MAX_UPLOAD = 8 * 1024 * 1024 * 1024; // 8GB
const JOB_TTL = 60 * 60 * 1000; // 一小时后清掉结果
const FILE_TTL = 20 * 60 * 1000; // 临时视频保留 20 分钟，方便重试

module.exports = function createAsrService({ root, dataDir, sendJSON }) {
  const ASR_DIR = path.join(root, 'asr');
  const SCRIPT = path.join(ASR_DIR, 'transcribe.py');
  const MODEL_DIR = path.join(ASR_DIR, 'models');
  const TMP_DIR = path.join(dataDir, 'tmp');
  const VENV_PY =
    process.platform === 'win32'
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : path.join(root, '.venv', 'bin', 'python');

  /** @type {Map<string, any>} */
  const jobs = new Map();
  let envCache = null;

  const python = () => (fs.existsSync(VENV_PY) ? VENV_PY : process.platform === 'win32' ? 'py' : 'python3');
  const usingVenv = () => fs.existsSync(VENV_PY);

  /* ─────────────── 环境检测 ─────────────── */

  function probePython() {
    return new Promise((resolve) => {
      if (!fs.existsSync(SCRIPT)) return resolve({ ok: false, reason: '识别脚本缺失（asr/transcribe.py）' });
      const probe = 'import faster_whisper, ctranslate2; print("ok", ctranslate2.get_cuda_device_count())';
      const child = spawn(python(), ['-c', probe], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill(), 30000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: `找不到 Python：${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && /ok\s+(\d+)/.test(out)) {
          const cuda = Number(out.match(/ok\s+(\d+)/)[1]) || 0;
          return resolve({ ok: true, cuda });
        }
        const tail = (err || out).trim().split('\n').filter(Boolean).slice(-2).join(' ');
        resolve({ ok: false, reason: tail || `Python 退出码 ${code}` });
      });
    });
  }

  function listDownloadedModels() {
    try {
      const out = [];
      for (const d of fs.readdirSync(MODEL_DIR)) {
        const m = d.match(/^faster-whisper-(.+)$/);
        if (!m) continue;
        const bin = path.join(MODEL_DIR, d, 'model.bin');
        try {
          if (fs.statSync(bin).size > 1024 * 1024) out.push(m[1]);
        } catch {
          /* 目录在但权重没下完，不算已下载 */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async function env(force = false) {
    if (envCache && !force && Date.now() - envCache.at < 60000) return envCache.value;
    const py = await probePython();
    const cuda = Number(py.cuda) || 0;
    const defaultModel = cuda > 0 ? 'medium' : 'base';
    const value = {
      ready: py.ok,
      reason: py.ok ? '' : py.reason || '未就绪',
      venv: usingVenv(),
      models: listDownloadedModels(),
      options: MODELS,
      defaultModel,
      device: cuda > 0 ? 'cuda' : 'cpu',
      cudaDevices: cuda,
    };
    envCache = { at: Date.now(), value };
    return value;
  }

  /* ─────────────── 任务执行 ─────────────── */

  function cleanupLater(file, ms) {
    setTimeout(() => fs.promises.unlink(file).catch(() => {}), ms).unref?.();
  }

  function runJob(job) {
    const py = python();
    const args = [SCRIPT, '--input', job.file, '--model', job.model, '--lang', job.lang];
    const child = spawn(py, args, {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
      },
    });
    job.child = child;
    job.pid = child.pid;

    let stderrBuf = '';
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // 非协议输出（比如第三方库打印）直接忽略
      }
      if (ev.type === 'status') job.msg = ev.msg;
      else if (ev.type === 'download') {
        job.stage = 'download';
        job.percent = ev.percent;
        const mb = (n) => (n / 1048576).toFixed(0);
        job.msg = `正在下载模型（${ev.percent}%，${mb(ev.done)}/${mb(ev.total)} MB）…`;
      } else if (ev.type === 'reset') {
        job.segments = [];
        job.percent = 0;
      } else if (ev.type === 'ready') {
        job.device = ev.device;
        job.stage = 'transcribe';
      } else if (ev.type === 'duration') {
        job.duration = Number(ev.duration) || 0;
      } else if (ev.type === 'progress') {
        job.percent = Math.max(0, Math.min(99, Number(ev.percent) || 0));
        job.processed = Number(ev.processed) || 0;
        job.duration = Number(ev.duration) || job.duration || 0;
      } else if (ev.type === 'segment') {
        job.segments.push({ start: ev.start, end: ev.end, text: ev.text, en: ev.text, zh: '' });
        job.percent = Math.max(job.percent || 0, Math.min(99, Number(ev.percent) || 0));
        job.processed = Number(ev.processed) || job.processed || 0;
        job.msg = job.percent
          ? `已识别 ${job.segments.length} 句 · ${job.percent}%…`
          : `已识别 ${job.segments.length} 句…`;
      } else if (ev.type === 'done') {
        job.lang = ev.lang || job.lang;
        job.elapsed = ev.elapsed;
        job.percent = 100;
        job.device = ev.device || job.device;
      } else if (ev.type === 'error') {
        job.error = ev.msg;
      }
    });

    child.on('error', (e) => {
      job.state = 'error';
      job.error = `无法启动 Python：${e.message}`;
    });

    child.on('close', (code) => {
      if (job.state === 'cancelled') return;
      if (code === 0 && !job.error && job.segments.length) {
        job.state = 'done';
        job.msg = `识别完成，共 ${job.segments.length} 句`;
      } else {
        job.state = 'error';
        job.error = job.error || stderrBuf.trim().split('\n').slice(-4).join('\n') || `识别进程退出（代码 ${code}）`;
      }
      job.endedAt = Date.now();
      job.child = null;
      cleanupLater(job.file, FILE_TTL);
      setTimeout(() => jobs.delete(job.id), JOB_TTL).unref?.();
    });
  }

  /* ─────────────── 常驻短音频识别（跟读评分 / 语音输入） ───────────────

     视频用 runJob 起一次性进程，慢了也无所谓；
     但跟读评分、口语对话是"说完就要出结果"，每次重载模型（3–6 秒）没法用。
     所以这里维护一个常驻 Python 进程：加载一次，之后一句 0.3–1 秒。
     空闲 10 分钟自动退出，不占显存。 */

  const WORKER = path.join(ASR_DIR, 'worker.py');
  const CLIP_DIR = path.join(TMP_DIR, 'clips');
  const CLIP_MAX = 30 * 1024 * 1024;
  const WARM_IDLE = 10 * 60 * 1000;

  let warm = null;
  let clipSeq = 0;

  /** 实时对话优先响应速度：固定使用 small，长视频仍可选择 medium。 */
  function clipModel() {
    const have = listDownloadedModels();
    if (have.includes('base')) return 'base';
    if (have.includes('small')) return 'small';
    return 'base';
  }

  function failAll(w, msg) {
    for (const [, job] of w.pending) {
      clearTimeout(job.timer);
      job.reject(new Error(msg));
    }
    w.pending.clear();
  }

  function stopWarm(reason) {
    const w = warm;
    warm = null;
    if (!w) return;
    clearTimeout(w.idle);
    clearTimeout(w.bootTimer);
    w.alive = false;
    failAll(w, reason || '识别进程已退出');
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }

  function touchIdle(w) {
    clearTimeout(w.idle);
    w.idle = setTimeout(() => {
      if (warm === w) stopWarm('识别进程空闲超时');
    }, WARM_IDLE);
    w.idle.unref?.();
  }

  function ensureWarm(model) {
    if (warm && warm.alive && warm.model === model) return warm;
    if (warm) stopWarm('切换识别模型');
    if (!fs.existsSync(WORKER)) throw new Error('缺少 asr/worker.py');

    const child = spawn(python(), [WORKER, '--model', model], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
      },
    });

    const w = { child, model, alive: true, device: '', pending: new Map(), idle: null, ready: null };
    let settle;
    w.ready = new Promise((res, rej) => {
      settle = { res, rej };
    });
    w.ready.catch(() => {}); // 没人 await 时也不要冒未处理拒绝

    w.bootTimer = setTimeout(() => {
      settle.rej(new Error('识别进程启动超时（180 秒）'));
      if (warm === w) stopWarm('启动超时');
    }, 180000);
    w.bootTimer.unref?.();

    let stderrBuf = '';
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // 第三方库的打印，忽略
      }
      if (ev.type === 'ready') {
        w.device = ev.device || '';
        clearTimeout(w.bootTimer);
        touchIdle(w);
        settle.res(w);
        return;
      }
      if (ev.type === 'error' && !ev.id) {
        clearTimeout(w.bootTimer);
        settle.rej(new Error(ev.msg || '识别进程启动失败'));
        return;
      }
      const job = ev.id && w.pending.get(ev.id);
      if (!job) return;
      w.pending.delete(ev.id);
      clearTimeout(job.timer);
      if (ev.type === 'result') {
        job.resolve({
          text: ev.text || '',
          words: Array.isArray(ev.words) ? ev.words : [],
          duration: Number(ev.duration) || 0,
          lang: ev.lang || '',
          elapsed: Number(ev.elapsed) || 0,
          device: w.device,
        });
      } else {
        job.reject(new Error(ev.msg || '识别失败'));
      }
      touchIdle(w);
    });

    child.on('error', (e) => {
      w.alive = false;
      clearTimeout(w.bootTimer);
      settle.rej(new Error(`无法启动 Python：${e.message}`));
      failAll(w, `无法启动 Python：${e.message}`);
      if (warm === w) warm = null;
    });

    child.on('close', (code) => {
      w.alive = false;
      clearTimeout(w.bootTimer);
      clearTimeout(w.idle);
      const tail = stderrBuf.trim().split('\n').filter(Boolean).slice(-2).join(' ');
      const msg = `识别进程退出（代码 ${code}）${tail ? '：' + tail : ''}`;
      settle.rej(new Error(msg));
      failAll(w, msg);
      if (warm === w) warm = null;
    });

    warm = w;
    return w;
  }

  function runClip({ file, lang, model, words = false }) {
    const w = ensureWarm(model);
    return w.ready.then(
      () =>
        new Promise((resolve, reject) => {
          const jobId = 'c' + ++clipSeq;
          const timer = setTimeout(() => {
            if (!w.pending.has(jobId)) return;
            w.pending.delete(jobId);
            reject(new Error('识别超时（90 秒）'));
          }, 90000);
          timer.unref?.();
          w.pending.set(jobId, { resolve, reject, timer });
          try {
            w.child.stdin.write(JSON.stringify({ id: jobId, file, lang, words }) + '\n');
          } catch (e) {
            w.pending.delete(jobId);
            clearTimeout(timer);
            reject(new Error(`识别进程不可用：${e.message}`));
          }
          touchIdle(w);
        })
    );
  }

  /** 浏览器录音常见容器 → 扩展名（PyAV 主要看内容，扩展名只为可读） */
  function audioExt(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('wav')) return '.wav';
    if (t.includes('mp4') || t.includes('m4a')) return '.m4a';
    if (t.includes('ogg')) return '.ogg';
    if (t.includes('mpeg') || t.includes('mp3')) return '.mp3';
    return '.webm';
  }

  function saveBody(req, file, max) {
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(file);
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          req.destroy();
          ws.destroy();
          reject(new Error('录音太大（上限 30MB）'));
        }
      });
      req.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('error', reject);
    });
  }

  const publicJob = (job) => ({
    id: job.id,
    name: job.name,
    state: job.state,
    stage: job.stage,
    msg: job.msg,
    error: job.error || '',
    device: job.device || '',
    model: job.model,
    lang: job.lang,
    count: job.segments.length,
    percent: Math.max(0, Math.min(100, Number(job.percent) || 0)),
    processed: Number(job.processed) || 0,
    duration: Number(job.duration) || 0,
    elapsed: job.elapsed || (job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0),
    segments: job.segments,
  });

  /* ─────────────── 路由 ─────────────── */

  async function handle(req, res, url) {
    const p = url.pathname;

    if (p === '/api/asr/env' && req.method === 'GET') {
      return sendJSON(res, 200, await env(url.searchParams.get('force') === '1'));
    }

    // 进入口语场景时提前加载短音频模型，避免第一句话冷启动。
    if (p === '/api/asr/warm' && req.method === 'GET') {
      const info = await env();
      if (!info.ready) return sendJSON(res, 503, { ok: false, error: `语音识别未就绪：${info.reason}` });
      const model = url.searchParams.get('model') || clipModel();
      if (!MODELS[model]) return sendJSON(res, 400, { ok: false, error: `不认识的模型：${model}` });
      try {
        const worker = await ensureWarm(model).ready;
        return sendJSON(res, 200, { ok: true, model, device: worker.device || '' });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // 短音频识别：跟读评分、开口练、口语对话都走这里（原始音频字节）
    if (p === '/api/asr/clip' && req.method === 'POST') {
      const info = await env();
      if (!info.ready) return sendJSON(res, 503, { ok: false, error: `语音识别未就绪：${info.reason}` });

      const model = url.searchParams.get('model') || clipModel();
      if (!MODELS[model]) return sendJSON(res, 400, { ok: false, error: `不认识的模型：${model}` });
      const lang = url.searchParams.get('lang') || 'en';
      const words = url.searchParams.get('words') === '1';

      const declared = Number(req.headers['content-length'] || 0);
      if (declared > CLIP_MAX) return sendJSON(res, 413, { ok: false, error: '录音太大（上限 30MB）' });

      await fsp.mkdir(CLIP_DIR, { recursive: true });
      const file = path.join(CLIP_DIR, 'clip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + audioExt(req.headers['content-type']));

      try {
        await saveBody(req, file, CLIP_MAX);
      } catch (e) {
        await fsp.unlink(file).catch(() => {});
        return sendJSON(res, 400, { ok: false, error: e.message });
      }

      try {
        const r = await runClip({ file, lang, model, words });
        return sendJSON(res, 200, { ok: true, model, ...r });
      } catch (e) {
        await fsp.unlink(file).catch(() => {});
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // 接收原始视频字节
    if (p === '/api/asr/upload' && req.method === 'POST') {
      const info = await env();
      if (!info.ready) return sendJSON(res, 400, { ok: false, error: `语音识别环境未就绪：${info.reason}` });

      const name = decodeURIComponent(url.searchParams.get('name') || 'video.mp4');
      const model = url.searchParams.get('model') || 'small';
      const lang = url.searchParams.get('lang') || 'auto';
      if (!MODELS[model]) return sendJSON(res, 400, { ok: false, error: `不认识的模型：${model}` });

      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_UPLOAD) return sendJSON(res, 413, { ok: false, error: '文件太大（上限 8GB）' });

      const id = 'asr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const ext = (path.extname(name) || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
      await fsp.mkdir(TMP_DIR, { recursive: true });
      const file = path.join(TMP_DIR, id + ext);

      try {
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(file);
          let size = 0;
          req.on('data', (c) => {
            size += c.length;
            if (size > MAX_UPLOAD) {
              req.destroy();
              ws.destroy();
              reject(new Error('文件太大'));
            }
          });
          req.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
          req.on('error', reject);
        });
      } catch (e) {
        await fsp.unlink(file).catch(() => {});
        return sendJSON(res, 400, { ok: false, error: e.message });
      }

      const job = {
        id,
        name,
        file,
        model,
        lang,
        state: 'running',
        stage: 'load',
        msg: '正在加载模型…',
        segments: [],
        percent: 0,
        processed: 0,
        duration: 0,
        startedAt: Date.now(),
      };
      jobs.set(id, job);
      runJob(job);
      return sendJSON(res, 200, { ok: true, jobId: id });
    }

    const m = p.match(/^\/api\/asr\/job\/([A-Za-z0-9_]+)$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return sendJSON(res, 404, { ok: false, error: '任务不存在或已过期' });
      if (req.method === 'GET') return sendJSON(res, 200, { ok: true, ...publicJob(job) });
      if (req.method === 'DELETE') {
        job.state = 'cancelled';
        try {
          job.child?.kill();
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          jobs.delete(job.id);
          fsp.unlink(job.file).catch(() => {});
        }, 500).unref?.();
        return sendJSON(res, 200, { ok: true });
      }
    }

    return sendJSON(res, 404, { ok: false, error: 'not found' });
  }

  return { handle, env, models: MODELS };
};
