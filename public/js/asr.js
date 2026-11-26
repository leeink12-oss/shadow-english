// 本地语音识别（faster-whisper）前端封装
// 上传视频 → 轮询识别进度 → 拿到带时间戳的分句
import { getJSON, delJSON } from './api.js';
import { sleep } from './util.js';

export const getAsrEnv = (force = false) => getJSON(`/api/asr/env${force ? '?force=1' : ''}`);
export const warmAsr = () => getJSON('/api/asr/warm');

/**
 * 把视频原始字节 POST 给本地服务。
 * 用 XHR 而不是 fetch，因为只有 XHR 能拿到上传进度。
 */
export function uploadVideo(file, { model = 'small', lang = 'auto', onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const qs = `name=${encodeURIComponent(file.name)}&model=${encodeURIComponent(model)}&lang=${encodeURIComponent(lang)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/asr/upload?${qs}`);
    xhr.responseType = 'text';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.upload.onload = () => onProgress?.(1);

    xhr.onload = () => {
      let j = {};
      try {
        j = JSON.parse(xhr.responseText || '{}');
      } catch {
        return reject(new Error(`服务返回异常（${xhr.status}）`));
      }
      if (xhr.status >= 200 && xhr.status < 300 && j.ok && j.jobId) return resolve(j.jobId);
      reject(new Error(j.error || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('上传失败，检查本地服务是否还在运行'));
    xhr.onabort = () => reject(new Error('已取消'));

    xhr.send(file);
  });
}

/** 轮询任务状态，直到完成或失败 */
export async function waitJob(jobId, onUpdate) {
  let lastCount = -1;
  for (;;) {
    const j = await getJSON(`/api/asr/job/${jobId}`);
    if (!j.ok) throw new Error(j.error || '任务丢失');
    // 只在有变化时回调，避免刷太快
    if (j.count !== lastCount || j.state !== 'running' || j.percent !== undefined) {
      lastCount = j.count;
      onUpdate?.(j);
    }
    if (j.state === 'done') return j;
    if (j.state === 'error') throw new Error(j.error || '识别失败');
    if (j.state === 'cancelled') throw new Error('已取消');
    await sleep(600);
  }
}

export const cancelJob = (jobId) => delJSON(`/api/asr/job/${jobId}`).catch(() => null);
