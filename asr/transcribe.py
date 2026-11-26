#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
影读英语 · 本地语音识别（faster-whisper）

把视频/音频里的说话内容转成带时间戳的字幕片段。
只做一件事：读文件 -> 输出 JSONL 到 stdout，由 Node 端逐行解析。

输出协议（每行一个 JSON）：
  {"type":"status","msg":"..."}                       进度提示
  {"type":"download","file":"model.bin","percent":42}  模型下载进度
  {"type":"ready","device":"cuda","model":"small"}     模型就绪
  {"type":"segment","start":1.2,"end":3.4,"text":"..."}
  {"type":"done","count":12,"elapsed":5.2}
  {"type":"error","msg":"..."}

用法：
  python transcribe.py --input video.mp4 --model small --lang auto

模型从 ModelScope（魔搭）下载，国内速度比 HuggingFace 快两个数量级；
下载到 asr/models/faster-whisper-<size>/ 后完全离线可用。
"""

import argparse
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request

# 万一还没下载到本地，给 huggingface_hub 一个可用的镜像地址
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, "models")

MS_NS = "pengzhendong"
MS_URL = (
    "https://www.modelscope.cn/api/v1/models/" + MS_NS + "/faster-whisper-{name}"
    "/repo?Revision=master&FilePath={file}"
)

# 必需 + 可选文件；model.bin 是权重本体，缺了就没法用
REQUIRED = ["model.bin", "config.json", "tokenizer.json"]
OPTIONAL = ["vocabulary.txt", "vocabulary.json", "preprocessor_config.json", "configuration.json"]


def emit(obj):
    """写一行 JSON 并立即刷新，让 Node 端能实时收到"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    emit({"type": "status", "msg": msg})


def setup_cuda_dlls():
    """
    ctranslate2 的 CUDA 后端要 cublas64_12.dll / cudnn 的 DLL。
    干净机器上通常没有，但可以 pip install nvidia-cublas-cu12 nvidia-cudnn-cu12，
    pip 会把它们放在 site-packages/nvidia/*/bin，需要手动加进 DLL 搜索路径。
    """
    if sys.platform != "win32":
        return
    import glob

    dirs = []
    for base in list(sys.path):
        root = os.path.join(base, "nvidia")
        if not os.path.isdir(root):
            continue
        for sub in os.listdir(root):
            for d in glob.glob(os.path.join(root, sub, "**", "bin"), recursive=True):
                if os.path.isdir(d) and d not in dirs:
                    dirs.append(d)

    for d in dirs:
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
        try:
            os.add_dll_directory(d)
        except Exception:  # noqa: BLE001
            pass


def cuda_usable():
    """真正能不能跑 GPU：能加载 cublas 才算数，否则直接走 CPU，避免推理时才炸"""
    if sys.platform != "win32":
        return True
    import ctypes

    try:
        ctypes.WinDLL("cublas64_12.dll")
        return True
    except Exception:  # noqa: BLE001
        return False


def download(url, target, label, attempt=0):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 ShadowEnglish"})
    tmp = target + ".part"
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            last = 0.0
            with open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    now = time.time()
                    if now - last > 0.5:
                        last = now
                        emit(
                            {
                                "type": "download",
                                "file": label,
                                "percent": round(done * 100 / total) if total else 0,
                                "done": done,
                                "total": total,
                            }
                        )
        os.replace(tmp, target)
        return True
    except Exception:  # noqa: BLE001
        if os.path.exists(tmp):
            os.remove(tmp)
        if attempt < 2:
            time.sleep(1.5)
            return download(url, target, label, attempt + 1)
        raise


def ensure_model(name):
    """保证模型文件齐全，返回本地目录；缺什么下什么"""
    d = os.path.join(MODEL_DIR, "faster-whisper-" + name)
    os.makedirs(d, exist_ok=True)

    have = lambda f: os.path.exists(os.path.join(d, f)) and os.path.getsize(os.path.join(d, f)) > 1024
    if have("model.bin") and have("config.json"):
        return d

    log(f"首次使用，正在下载 {name} 模型（后续不再需要联网）…")
    for f in REQUIRED + OPTIONAL:
        target = os.path.join(d, f)
        if os.path.exists(target) and os.path.getsize(target) > 512:
            continue
        try:
            download(MS_URL.format(name=name, file=f), target, f)
        except urllib.error.HTTPError as e:
            if f in REQUIRED:
                raise RuntimeError(f"模型文件 {f} 下载失败：HTTP {e.code}") from e
            # 可选文件缺失不影响识别
        except Exception as e:  # noqa: BLE001
            if f in REQUIRED:
                raise RuntimeError(f"模型文件 {f} 下载失败：{e}") from e
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="视频或音频文件路径")
    ap.add_argument("--model", default="small", help="tiny/base/small/medium/large-v3")
    ap.add_argument("--lang", default="auto", help="auto 或 en / zh / ja ...")
    ap.add_argument("--device", default="auto", help="auto / cuda / cpu")
    ap.add_argument("--compute", default="", help="留空自动选择")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        emit({"type": "error", "msg": f"找不到文件：{args.input}"})
        return 2

    started = time.time()

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "msg": f"faster-whisper 未安装或损坏：{e}"})
        return 3

    try:
        local_dir = ensure_model(args.model)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "msg": str(e)})
        return 5

    setup_cuda_dlls()

    device = args.device
    compute = args.compute
    if device == "auto":
        device = "cuda" if cuda_usable() else "cpu"
    if not compute:
        compute = "float16" if device == "cuda" else "int8"

    log(f"正在加载模型（{device}）…")
    try:
        model = WhisperModel(local_dir, device=device, compute_type=compute)
    except Exception as e:  # noqa: BLE001
        if device != "cuda":
            raise
        short = str(e).split("\n")[0][:120]
        log(f"显卡加载失败，改用 CPU（{short}）")
        device, compute = "cpu", "int8"
        model = WhisperModel(local_dir, device="cpu", compute_type="int8")

    emit({"type": "ready", "device": device, "model": args.model})

    language = None if args.lang in ("auto", "", None) else args.lang
    emitted = 0

    def stream(m):
        """逐条识别并输出，返回 info 对象"""
        nonlocal emitted
        segs, info = m.transcribe(
            args.input,
            language=language,
            task="transcribe",
            beam_size=5,
            vad_filter=True,  # 用 VAD 跳过静音，减少整段空白与循环幻觉
            vad_parameters={"min_silence_duration_ms": 400},
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            temperature=0,
        )
        for seg in segs:
            text = (seg.text or "").strip()
            if not text:
                continue
            emitted += 1
            emit(
                {
                    "type": "segment",
                    "start": round(float(seg.start), 3),
                    "end": round(float(seg.end), 3),
                    "text": text,
                }
            )
        return info

    log("正在识别语音…")
    try:
        info = stream(model)
    except Exception as e:  # noqa: BLE001
        # 显卡能加载但推理炸（典型是缺 cudnn64_9.dll），换 CPU 重跑一遍
        if device != "cuda":
            raise
        emit({"type": "status", "msg": f"显卡推理失败，改用 CPU 重新识别（{str(e).splitlines()[0][:100]}）"})
        if emitted:
            emit({"type": "reset"})
            emitted = 0
        device, compute = "cpu", "int8"
        model = WhisperModel(local_dir, device="cpu", compute_type="int8")
        emit({"type": "ready", "device": "cpu", "model": args.model})
        info = stream(model)

    count = emitted
    if count == 0:
        emit({"type": "error", "msg": "没有识别到语音内容，可能是纯音乐或无人声的视频"})
        return 4

    emit(
        {
            "type": "done",
            "count": count,
            "chars": 0,
            "lang": getattr(info, "language", "") or "",
            "device": device,
            "elapsed": round(time.time() - started, 1),
        }
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:  # noqa: BLE001
        emit({"type": "error", "msg": traceback.format_exc(limit=3)})
        sys.exit(1)
