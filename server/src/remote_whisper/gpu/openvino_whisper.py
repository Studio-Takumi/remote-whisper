"""Intel の GPU（Arc）で Whisper を動かす（OpenVINO GenAI の WhisperPipeline。#374）

CUDA（NVIDIA の GPU）がなく、OpenVINO が単体の Intel の GPU（`FULL_DEVICE_NAME` に `(dGPU)`）を
見つけたときだけ使う。録音中の文字起こし（whisper_worker）と、浄書の文字起こし
（final_transcribe_worker）で使う。浄書の位置合わせと話者分けは CPU のまま（#347）。

faster-whisper と違うところ:
- ビームサーチは GPU で動かない（`Not Implemented`）ので greedy にする
- 区間の信頼度（`no_speech_prob`・`avg_logprob`）が取れない。ハルシネーションの判定
  （hallucination.py）は、VAD で測った話している長さ（`voiced_sec`）と、こちらで計算する
  `compression_ratio`（繰り返しの検出）で代わりにする
- greedy は同じ語を繰り返し続けることがあるので、出す長さ（`max_new_tokens`）を音声の長さで抑える

`openvino-genai` はサーバーの extra `openvino`（Windows）。入っていなければ何も読み込まない。
"""

import functools
import importlib.util
import logging
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000
# 単体の GPU の印（OpenVINO の FULL_DEVICE_NAME。例: "Intel(R) Arc(TM) A350M Graphics (dGPU)"）
DGPU_MARK = "(dGPU)"
# 録音中は int8（VRAM 約 1.1GB。要約の LLM と並べるため）、浄書は fp16（約 1.8GB）。
# 区間ごとの速さはほぼ同じ（#347）
LIVE_PRECISION = "int8"
FINAL_PRECISION = "fp16"
# 1 秒あたりに出してよいトークンの数と、その余裕。日本語の早口でも 1 秒に 10 文字前後。
# greedy で同じ語を繰り返し始めても、ここで止まる（30 秒で 448 は Whisper の上限）
TOKENS_PER_SEC = 12
TOKENS_MARGIN = 32
MAX_NEW_TOKENS = 448
# 浄書でまとめて渡す長さ（Whisper の窓）と、VAD の区間の最大
CHUNK_SEC = 30.0
# 区間の時刻のずれを見込んで、話している長さを測る範囲を前後に広げる
VOICED_MARGIN_SEC = 0.3


@dataclass(frozen=True)
class Device:
    """見つけた Intel の GPU"""

    name: str  # OpenVINO のデバイス名（例: GPU.1）
    full_name: str
    # Windows の性能カウンターのインスタンス名の一部（例: luid_0x00000000_0x00013930）。
    # 取れなければ None
    luid: str | None
    total_mb: int | None


def installed() -> bool:
    """OpenVINO GenAI が入っているか（サーバーの extra `openvino`）"""
    try:
        return importlib.util.find_spec("openvino_genai") is not None
    except (ImportError, ValueError):
        return False


def counter_luid(raw: str) -> str | None:
    """OpenVINO の DEVICE_LUID（8 バイトの 16 進。リトルエンディアン）を、性能カウンターの
    インスタンス名の形（`luid_0x<上位>_0x<下位>`）にする"""
    try:
        data = bytes.fromhex(raw)
    except (TypeError, ValueError):
        return None
    if len(data) != 8:
        return None
    low = int.from_bytes(data[:4], "little")
    high = int.from_bytes(data[4:], "little")
    return f"luid_0x{high:08X}_0x{low:08X}"


def find_device(core: Any = None) -> Device | None:
    """単体の Intel の GPU を探す。なければ（OpenVINO がない・GPU がない）None。core はテスト用"""
    try:
        if core is None:
            import openvino as ov

            core = ov.Core()
        devices = list(core.available_devices)
    except Exception as e:  # noqa: BLE001 OpenVINO が入っていない・ドライバがないなど
        log.info("OpenVINO の GPU は使いません: %s", e)
        return None
    for name in devices:
        if not str(name).startswith("GPU"):
            continue
        try:
            full_name = str(core.get_property(name, "FULL_DEVICE_NAME"))
        except Exception:  # noqa: BLE001
            continue
        if DGPU_MARK not in full_name:
            continue
        luid = total = None
        try:
            luid = counter_luid(str(core.get_property(name, "DEVICE_LUID")))
        except Exception:  # noqa: BLE001 取れなくても文字起こしはできる
            pass
        try:
            total = int(core.get_property(name, "GPU_DEVICE_TOTAL_MEM_SIZE")) // (1024 * 1024)
        except Exception:  # noqa: BLE001
            pass
        return Device(str(name), full_name, luid, total)
    return None


def _nvidia_present() -> bool:
    """NVIDIA の GPU とドライバがあるか。あれば今までどおり faster-whisper（CUDA）を使う"""
    try:
        import pynvml

        pynvml.nvmlInit()
        try:
            return pynvml.nvmlDeviceGetCount() > 0
        finally:
            pynvml.nvmlShutdown()
    except Exception:  # noqa: BLE001 ドライバがない・ライブラリがないなど
        return False


@functools.cache
def detect() -> Device | None:
    """この PC で OpenVINO の Intel の GPU を使うなら、そのデバイス。起動してから 1 回だけ調べる

    extra `openvino` が入っていない・NVIDIA の GPU がある・単体の Intel の GPU がない、の
    どれかなら None（今までどおり）
    """
    if not installed() or _nvidia_present():
        return None
    device = find_device()
    if device is not None:
        log.info("found %s (%s) for whisper", device.full_name, device.name)
    return device


def repo_for(model: str, precision: str) -> str:
    """OpenVINO 版のモデルの HuggingFace のリポジトリ。/ を含む名前はそのまま使う"""
    return model if "/" in model else f"OpenVINO/whisper-{model}-{precision}-ov"


def cache_dir() -> Path:
    """コンパイルしたモデルのキャッシュ（読み込みが 46 秒 → 6〜7 秒になる）。HF_HOME の下に置く"""
    from huggingface_hub import constants

    return Path(constants.HF_HOME) / "openvino-cache"


def load(repo: str, device: str) -> Any:
    """モデルを取って（初回だけ）、GPU で読み込む"""
    import openvino_genai
    from huggingface_hub import snapshot_download

    path = snapshot_download(repo)
    cache = cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    log.info("loading whisper %s on %s (openvino)", repo, device)
    return openvino_genai.WhisperPipeline(path, device, CACHE_DIR=str(cache))


def compression_ratio(text: str) -> float:
    """Whisper と同じ「圧縮しやすさ」。同じ言葉を繰り返していると大きくなる"""
    data = text.encode("utf-8")
    if not data:
        return 0.0
    return len(data) / len(zlib.compress(data))


def max_new_tokens(samples: int) -> int:
    seconds = samples / SAMPLE_RATE
    return min(MAX_NEW_TOKENS, int(seconds * TOKENS_PER_SEC) + TOKENS_MARGIN)


def generate(pipe: Any, audio: Any, options: dict) -> list[dict]:
    """音声（16kHz・モノラルの float32）を 1 回で文字起こしする。時刻は渡した音声の頭から

    返す区間には信頼度（`no_speech_prob`・`avg_logprob`）を付けない（取れないため）。
    `compression_ratio` はこちらで計算して付ける
    """
    kwargs: dict[str, Any] = {
        "language": f"<|{options.get('language') or 'ja'}|>",
        "task": "transcribe",
        # タイムスタンプありのほうが、同じ語の繰り返しが出にくい（#347）
        "return_timestamps": True,
        "max_new_tokens": max_new_tokens(len(audio)),
    }
    if options.get("initial_prompt"):
        kwargs["initial_prompt"] = options["initial_prompt"]
    if options.get("hotwords"):
        kwargs["hotwords"] = options["hotwords"]
    result = pipe.generate(audio, **kwargs)
    duration = len(audio) / SAMPLE_RATE
    segments = []
    chunks = list(getattr(result, "chunks", None) or [])
    if chunks:
        for c in chunks:
            start = max(0.0, float(c.start_ts))
            # 終わりの時刻がない（-1）のは、音声の終わりまで続いている区間
            end = float(c.end_ts)
            if end < start:
                end = duration
            segments.append({"start": start, "end": min(end, duration), "text": c.text})
    else:
        text = "".join(getattr(result, "texts", None) or [])
        if text:
            segments.append({"start": 0.0, "end": duration, "text": text})
    for s in segments:
        s["compression_ratio"] = compression_ratio(s["text"])
    _log_if_cut(segments, kwargs["max_new_tokens"], duration)
    return segments


def _log_if_cut(segments: list[dict], limit: int, duration: float) -> None:
    """出す長さの上限で止まったらしいときにログに残す（文の後ろが欠けたか、繰り返しで埋まったか
    を後で見分けるため）。トークンの数は取れないので、文字数で目安にする（日本語は 1 文字が
    1 トークン以上になることが多いので、上限の 7 割の文字数で出す）"""
    chars = sum(len(s["text"]) for s in segments)
    if chars >= limit * 0.7:
        log.info(
            "the transcript of %.1fs may be cut at max_new_tokens=%d (%d characters)",
            duration,
            limit,
            chars,
        )


def speech_spans(audio: Any, max_speech_sec: float | None = None) -> list[tuple[int, int]]:
    """Silero VAD（faster-whisper のもの）で話している範囲（サンプルの位置）を出す"""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    if max_speech_sec is None:
        chunks = get_speech_timestamps(audio)
    else:
        chunks = get_speech_timestamps(audio, VadOptions(max_speech_duration_s=max_speech_sec))
    return [(c["start"], c["end"]) for c in chunks]


def voiced_sec(spans: list[tuple[int, int]], start: float, end: float) -> float:
    """start〜end 秒（前後に少し広げる）のうち、VAD が話しているとみなした長さ（秒）"""
    lo = (start - VOICED_MARGIN_SEC) * SAMPLE_RATE
    hi = (end + VOICED_MARGIN_SEC) * SAMPLE_RATE
    total = 0.0
    for a, b in spans:
        total += max(0.0, min(b, hi) - max(a, lo))
    return total / SAMPLE_RATE


def transcribe(pipe: Any, audio: Any, options: dict) -> list[dict]:
    """録音中の文字起こし（whisper_worker）。faster-whisper の `vad_filter` と同じく、
    VAD を使うなら話している範囲だけを渡し、話していなければ文字起こししない（#81）

    文ごとに話している長さ（`voiced_sec`）を付ける。信頼度の代わりに、ハルシネーションの判定に
    使う（hallucination.py）。VAD で切り出した区間（`vad_filter` が False。録音中の既定）でも
    付ける（切り詰めはしない）。そのときに VAD が区間のどこにも声を見つけなければ、区間を
    切り出した側の判定を信じて付けない（区間全体の長さで判定される）
    """
    spans = speech_spans(audio)
    if not options.get("vad_filter", True):
        segments = generate(pipe, audio, options)
        if spans:
            for s in segments:
                s["voiced_sec"] = voiced_sec(spans, s["start"], s["end"])
        return segments
    if not spans:
        return []
    offset, end = spans[0][0], spans[-1][1]
    segments = generate(pipe, audio[offset:end], options)
    shift = offset / SAMPLE_RATE
    for s in segments:
        s["start"] += shift
        s["end"] += shift
        s["voiced_sec"] = voiced_sec(spans, s["start"], s["end"])
    return segments


def windows(spans: list[tuple[int, int]], limit_sec: float = CHUNK_SEC) -> list[tuple[int, int]]:
    """話している範囲を、つないでも limit_sec 秒を超えないまとまりにする
    （浄書。WhisperX と同じ考え方）"""
    limit = int(limit_sec * SAMPLE_RATE)
    out: list[tuple[int, int]] = []
    for a, b in spans:
        if out and b - out[-1][0] <= limit:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def transcribe_long(pipe: Any, audio: Any, options: dict, progress: Any = None) -> list[dict]:
    """浄書の文字起こし（final_transcribe_worker）。録音全体を VAD で話している範囲に分け、
    30 秒までのまとまりごとに文字起こしする。progress には %（0〜100）を渡す

    繰り返しで埋まった区間（`compression_ratio` が大きい）は捨てる（hallucination.py と同じ基準）
    """
    from remote_whisper.recording.hallucination import MAX_COMPRESSION_RATIO

    spans = speech_spans(audio, max_speech_sec=CHUNK_SEC - 1)
    parts = windows(spans)
    segments: list[dict] = []
    for k, (a, b) in enumerate(parts):
        shift = a / SAMPLE_RATE
        for s in generate(pipe, audio[a:b], options):
            if not s["text"].strip():
                continue
            if s["compression_ratio"] > MAX_COMPRESSION_RATIO:
                log.info(
                    "dropped a repetition at %.1fs (compression_ratio=%.1f)",
                    shift + s["start"],
                    s["compression_ratio"],
                )
                continue
            segments.append(
                {"start": shift + s["start"], "end": shift + s["end"], "text": s["text"]}
            )
        if progress is not None:
            progress((k + 1) * 100 / len(parts))
    return segments
