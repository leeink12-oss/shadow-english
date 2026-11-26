#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
影读英语 · 常驻识别进程（跟读评分 / 语音输入用）

和 transcribe.py 的区别：这个进程**只加载一次模型**，然后一直等着接活。
短句识别（3–10 秒）如果每次重新加载模型，光加载就要 3–6 秒；
常驻之后一句只要 0.3–1 秒，才可能做到"说完就出分""说完对方就回"。

协议（stdin 一行一个请求，stdout 一行一个事件）：
  启动完成：{"type":"ready","device":"cuda","model":"medium"}
  请求：    {"id":"abc","file":"C:/...wav","lang":"en"}
  结果：    {"id":"abc","type":"result","text":"...","words":[{"w","p","s","e"}],"duration":3.2}
  出错：    {"id":"abc","type":"error","msg":"..."}

words 里的 p 是 Whisper 对这个词的对数概率换算出的置信度（0–1）。
它衡量的是「机器能不能听清」，也就是「别人能不能听懂你」，
所以用它做跟读评分是诚实的：不做音素级发音打分，只判断可听懂度。
"""

import argparse
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from transcribe import emit, ensure_model, setup_cuda_dlls, cuda_usable  # noqa: E402


def audio_duration(path):
    """拿容器时长；拿不到就返回 0，让调用方用词的时间戳兜底"""
    try:
        import av

        with av.open(path) as c:
            if c.duration:
                return round(float(c.duration) / 1000000.0, 2)
    except Exception:  # noqa: BLE001
        pass
    return 0.0


def load_model(name, device, compute):
    from faster_whisper import WhisperModel

    local_dir = ensure_model(name)
    setup_cuda_dlls()
    if device == "auto":
        device = "cuda" if cuda_usable() else "cpu"
    if not compute:
        compute = "float16" if device == "cuda" else "int8"

    emit({"type": "status", "msg": f"正在加载模型（{device}）…"})
    try:
        m = WhisperModel(local_dir, device=device, compute_type=compute)
    except Exception as e:  # noqa: BLE001
        if device != "cuda":
            raise
        emit({"type": "status", "msg": f"显卡加载失败，改用 CPU（{str(e).splitlines()[0][:100]}）"})
        device, compute, m = "cpu", "int8", WhisperModel(local_dir, device="cpu", compute_type="int8")
    return m, device, compute, name


def transcribe_one(model, path, lang, need_words=False):
    started = time.time()
    segments, info = model.transcribe(
        path,
        language=None if lang in ("auto", "", None) else lang,
        task="transcribe",
        beam_size=3 if need_words else 1,
        vad_filter=False,  # 录音端已在说话结束后截断，短句无需再运行 VAD。
        condition_on_previous_text=False,
        word_timestamps=need_words,
        no_speech_threshold=0.6,
        temperature=0,
    )

    words = []
    parts = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        parts.append(text)
        for w in seg.words or []:
            token = (w.word or "").strip()
            if not token:
                continue
            words.append(
                {
                    "w": token,
                    "p": round(float(w.probability or 0), 3),
                    "s": round(float(w.start or 0), 3),
                    "e": round(float(w.end or 0), 3),
                }
            )

    duration = audio_duration(path)
    if not duration and words:
        duration = round(words[-1]["e"] - words[0]["s"], 2)

    return {
        "text": " ".join(parts).strip(),
        "words": words,
        "duration": duration,
        "lang": getattr(info, "language", "") or (lang or ""),
        "elapsed": round(time.time() - started, 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="medium")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute", default="")
    args = ap.parse_args()

    try:
        model, device, compute, name = load_model(args.model, args.device, args.compute)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "msg": f"模型加载失败：{e}"})
        return 3

    emit({"type": "ready", "device": device, "model": name})
    sys.stderr.write("worker ready\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except Exception:  # noqa: BLE001
            continue

        if job.get("type") == "exit":
            break

        jid = str(job.get("id") or "")
        path = job.get("file") or ""
        if not jid or not os.path.exists(path):
            emit({"id": jid, "type": "error", "msg": f"找不到音频文件：{path}"})
            continue

        try:
            result = transcribe_one(
                model,
                path,
                job.get("lang") or "en",
                need_words=bool(job.get("words")),
            )
            emit({"id": jid, "type": "result", **result})
        except Exception as e:  # noqa: BLE001
            # 单句失败不能拖垮常驻进程，报错后继续接下一句
            emit({"id": jid, "type": "error", "msg": str(e).splitlines()[0][:200]})
            sys.stderr.write(traceback.format_exc(limit=2) + "\n")
            sys.stderr.flush()
        finally:
            try:
                os.remove(path)
            except Exception:  # noqa: BLE001
                pass

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
