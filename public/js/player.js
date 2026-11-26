// 播放器内核：字幕同步、单句 / AB / 全片循环、句末停靠
export class Player {
  constructor(video, handlers = {}) {
    this.video = video;
    this.handlers = handlers; // { onIndexChange, onSegmentEnd, onPlayState, onTime, onEnded }
    this.sentences = [];
    this.curIdx = -1;
    this.loopOne = false;
    this.loopAll = false;
    this.ab = { a: null, b: null };
    this.gapMode = 'none'; // 'none' | 'delay' | 'pause'
    this.gapMs = 400;
    this.inGap = false;
    this._raf = null;

    video.addEventListener('play', () => {
      this.inGap = false;
      this.handlers.onPlayState?.(true);
      this._startLoop();
    });
    video.addEventListener('pause', () => {
      this.handlers.onPlayState?.(false);
      this._stopLoop();
    });
    video.addEventListener('ended', () => {
      this._stopLoop();
      if (this.loopAll) {
        this.video.currentTime = 0;
        this.video.play().catch(() => {});
      } else {
        this.handlers.onPlayState?.(false);
        this.handlers.onEnded?.();
      }
    });
    video.addEventListener('seeked', () => this._syncIndex());
    video.addEventListener('timeupdate', () => {
      this.handlers.onTime?.(this.video.currentTime);
      if (this.video.paused) this._syncIndex();
    });
  }

  /* ── 数据 ── */
  setSentences(list) {
    this.sentences = Array.isArray(list) ? list : [];
    this.curIdx = -1;
    this.inGap = false;
    this._syncIndex();
  }

  get index() {
    return this.curIdx;
  }

  get current() {
    return this.sentences[this.curIdx] || null;
  }

  get duration() {
    return this.video.duration || 0;
  }

  segAt(t) {
    const list = this.sentences;
    if (!list.length) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < list[mid].start) hi = mid - 1;
      else if (t >= list[mid].end) lo = mid + 1;
      else {
        found = list[mid];
        break;
      }
    }
    if (found) return found;
    // 落在间隙：取最近的前一句
    if (t < list[0].start) return null;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].start <= t) return list[i];
    return null;
  }

  _syncIndex() {
    const seg = this.segAt(this.video.currentTime);
    const idx = seg ? seg.i : -1;
    if (idx !== this.curIdx) {
      this.curIdx = idx;
      this.handlers.onIndexChange?.(idx, seg);
    }
  }

  /* ── 播放控制 ── */
  play() {
    this.inGap = false;
    const p = this.video.play();
    if (p && p.catch) p.catch(() => {});
  }
  pause() {
    this.video.pause();
  }
  toggle() {
    if (this.video.paused) this.play();
    else this.pause();
  }
  seek(t, { play = false } = {}) {
    const d = this.video.duration || 0;
    this.video.currentTime = Math.max(0, d ? Math.min(t, d - 0.02) : t);
    this.inGap = false;
    this._syncIndex();
    if (play) this.play();
  }
  seekToIndex(i, opts) {
    const s = this.sentences[i];
    if (!s) return;
    this.seek(s.start + 0.01, opts);
  }
  next() {
    const i = Math.min(this.sentences.length - 1, Math.max(0, this.curIdx) + 1);
    this.seekToIndex(i);
  }
  prev() {
    const cur = this.current;
    // 句子播了 1 秒以上时，「上一句」先回到本句开头
    if (cur && this.video.currentTime - cur.start > 1.2) {
      this.seek(cur.start + 0.01);
      return;
    }
    const i = Math.max(0, (this.curIdx < 0 ? 0 : this.curIdx) - 1);
    this.seekToIndex(i);
  }
  setRate(r) {
    this.video.playbackRate = r;
  }

  /* ── 循环 / 停靠 ── */
  _startLoop() {
    if (this._raf) return;
    const step = () => {
      if (this.video.paused) {
        this._raf = null;
        return;
      }
      this._check();
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  _stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
  _check() {
    const t = this.video.currentTime;
    const seg = this.segAt(t);

    if (seg && seg.i !== this.curIdx) {
      this.curIdx = seg.i;
      this.handlers.onIndexChange?.(seg.i, seg);
    }

    // AB 段落循环优先级最高
    if (this.ab.a != null && this.ab.b != null) {
      if (t >= this.ab.b) {
        this.seek(this.ab.a);
        return;
      }
    }

    if (!seg) {
      if (this.loopAll && this.duration && t >= this.duration - 0.1) {
        this.video.currentTime = 0;
        this.play();
      }
      return;
    }

    const nearEnd = t >= seg.end - 0.05;

    if (this.loopOne && nearEnd) {
      this.seek(seg.start + 0.01);
      return;
    }

    if (this.gapMode !== 'none' && nearEnd && !this.inGap) {
      this.inGap = true;
      this.video.pause();
      this.handlers.onSegmentEnd?.(seg.i, seg);
    }
  }
}
