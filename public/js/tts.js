// 自然语音：优先使用 Edge Neural TTS，网络不可用时回退到浏览器本地语音。

export const VOICE_PROFILES = [
  {
    id: 'young-female',
    label: '青年女声',
    detail: '清晰明亮，适合日常对话',
    voice: 'en-US-AvaMultilingualNeural',
    browser: /aria|ava|samantha|zira|jenny/i,
  },
  {
    id: 'natural-female',
    label: '中年女声',
    detail: '温和自然，语气更成熟',
    voice: 'en-US-JennyNeural',
    browser: /jenny|emma|aria|samantha|zira/i,
  },
  {
    id: 'young-male',
    label: '青年男声',
    detail: '明快自然，适合社交和职场',
    voice: 'en-US-AndrewMultilingualNeural',
    browser: /andrew|guy|david|mark/i,
  },
  {
    id: 'steady-male',
    label: '沉稳男声',
    detail: '低沉稳重，适合商务交流',
    voice: 'en-US-BrianNeural',
    browser: /brian|george|ryan|david/i,
  },
  {
    id: 'british-female',
    label: '英式女声',
    detail: '自然英式口音',
    voice: 'en-GB-SoniaNeural',
    browser: /sonia|libby|hazel|kate/i,
    accent: 'en-GB',
  },
  {
    id: 'british-male',
    label: '英式男声',
    detail: '沉稳英式口音',
    voice: 'en-GB-RyanNeural',
    browser: /ryan|george|oliver|thomas/i,
    accent: 'en-GB',
  },
  {
    id: 'browser',
    label: '本地系统语音',
    detail: '离线可用，音色取决于电脑',
    voice: '',
    browser: /natural|google|aria|samantha/i,
  },
];

let voiceId = 'young-female';
let speechRate = 1;
let generation = 0;
let audio = null;
let audioUrl = '';
let controller = null;
let voicesCache = null;

export function setVoiceProfile(id) {
  voiceId = VOICE_PROFILES.some((v) => v.id === id) ? id : 'young-female';
}

export function getVoiceProfile() {
  return VOICE_PROFILES.find((v) => v.id === voiceId) || VOICE_PROFILES[0];
}

export function setSpeechRate(rate) {
  speechRate = Math.max(0.75, Math.min(1.25, Number(rate) || 1));
}

export function getSpeechRate() {
  return speechRate;
}

function cleanText(text) {
  let out = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
  if (out && !/[.!?…]$/.test(out)) out += '.';
  return out;
}

function releaseAudio() {
  if (audio) {
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
    audio.removeAttribute?.('src');
    audio = null;
  }
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = '';
  }
}

export function stopSpeech() {
  generation++;
  if (controller) {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
    controller = null;
  }
  releaseAudio();
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

function browserSpeak(text, { lang = 'en-US', onStart, onEnd, token } = {}) {
  if (!window.speechSynthesis || !text) {
    onEnd?.();
    return null;
  }
  window.speechSynthesis.cancel();
  const profile = getVoiceProfile();
  const targetLang = profile.accent || lang;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = targetLang;
  u.rate = speechRate;
  if (!voicesCache) voicesCache = window.speechSynthesis.getVoices();
  const sameLang = voicesCache.filter((v) => new RegExp(`^${targetLang.slice(0, 2)}[-_]`, 'i').test(v.lang));
  const voice =
    sameLang.find((v) => profile.browser.test(v.name)) ||
    sameLang.find((v) => /natural|online|google/i.test(v.name)) ||
    sameLang[0];
  if (voice) u.voice = voice;

  let fired = false;
  const done = () => {
    if (fired || token !== generation) return;
    fired = true;
    onEnd?.();
  };
  u.onend = done;
  u.onerror = done;
  window.speechSynthesis.speak(u);
  onStart?.();
  return u;
}

/**
 * 朗读一句英文。优先请求本地 /api/tts 生成神经网络语音。
 * 返回 Promise 便于测试，但现有界面仍通过 onEnd 回调衔接对话。
 */
export function speak(text, { rate, lang = 'en-US', onStart, onEnd } = {}) {
  const clean = cleanText(text);
  if (!clean) {
    onEnd?.();
    return Promise.resolve(null);
  }

  stopSpeech();
  const token = generation;
  const profile = getVoiceProfile();
  const effectiveRate = Number(rate) || speechRate;
  if (profile.id === 'browser') {
    window.dispatchEvent(new CustomEvent('tts-fallback', { detail: { manual: true } }));
    return Promise.resolve(browserSpeak(clean, { lang, onStart, onEnd, token }));
  }
  const ctrl = new AbortController();
  controller = ctrl;

  return fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: clean,
      voice: profile.voice,
      rate: effectiveRate,
    }),
    signal: ctrl.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const blob = await res.blob();
      if (!blob.size || token !== generation) return null;
      audioUrl = URL.createObjectURL(blob);
      audio = new Audio(audioUrl);
      audio.preload = 'auto';
      audio.onended = () => {
        if (token === generation) {
          releaseAudio();
          onEnd?.();
        }
      };
      await audio.play();
      onStart?.();
      window.dispatchEvent(new CustomEvent('tts-neural'));
      return audio;
    })
    .catch((error) => {
      if (error?.name === 'AbortError' || token !== generation) return null;
      window.dispatchEvent(new CustomEvent('tts-fallback', { detail: { error: error.message } }));
      return browserSpeak(clean, { lang, onStart, onEnd, token });
    });
}
