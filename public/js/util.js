// 小工具集合
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function fmtTime(sec, withMs = false) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${m}:${String(s).padStart(2, '0')}`;
  if (!withMs) return base;
  const ms = Math.floor((sec % 1) * 10);
  return `${base}.${ms}`;
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

let toastTimer;
export function toast(msg, ms = 2200) {
  const node = $('#toast');
  node.textContent = msg;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), ms);
}

export const busy = {
  show(text = '处理中…', percent = null) {
    const box = $('#busy');
    box.hidden = false;
    $('#busyText').textContent = text;
    const bar = $('#busyBar');
    if (percent === null) {
      bar.style.width = '35%';
      bar.style.opacity = '0.55';
    } else {
      bar.style.opacity = '1';
      bar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
    }
  },
  text(t) {
    $('#busyText').textContent = t;
  },
  progress(p) {
    const bar = $('#busyBar');
    bar.style.opacity = '1';
    bar.style.width = `${Math.max(2, Math.min(100, p))}%`;
  },
  hide() {
    $('#busy').hidden = true;
    $('#busyBar').style.width = '0';
  },
};

export function download(filename, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 稳定的字符串哈希，用于课程 id */
export function hashId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

/** 简单 markdown（只支持 - 列表 / 粗体 / 行内代码） */
export function miniMarkdown(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let inList = false;
  const inline = (s) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) { out.push('</ul>'); inList = false; }
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*•]\s+/, ''))}</li>`);
    } else if (/^\d+[.)]\s+/.test(line)) {
      out.push(`<div class="ol-item">${inline(line)}</div>`);
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p style="margin:4px 0">${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}
