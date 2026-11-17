"""録音の WAV を mp3（モノラル・64kbps）に変換する（なければ m4a）。spec/notes.md 9.1

PyAV を使う。CPU で動くので GPU キューには積まない。
"""

import contextlib
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import av

from remote_whisper.storage.documents import recording_name

log = logging.getLogger(__name__)

BIT_RATE = 64_000

# (拡張子, コンテナ, エンコーダー) の候補。上から順に使えるものを使う
FORMATS = [("mp3", "mp3", "libmp3lame"), ("m4a", "mp4", "aac")]


def _encoder_available(name: str) -> bool:
    try:
        av.codec.Codec(name, "w")
    except Exception:  # noqa: BLE001 エンコーダーがない
        return False
    return True


def pick_format() -> tuple[str, str, str]:
    for fmt in FORMATS:
        if _encoder_available(fmt[2]):
            return fmt
    raise RuntimeError("mp3 と AAC のどちらのエンコーダーもありません")


def decode_pcm(path: Path) -> Iterator[bytes]:
    """音声ファイル（WAV・mp3・m4a）を 16kHz・モノラル・Int16 の PCM
    にして少しずつ返す（続きの録音用。#101）"""
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(str(path)) as src:
        for frame in src.decode(audio=0):
            for out in resampler.resample(frame):
                yield bytes(out.planes[0])[: out.samples * 2]
        for out in resampler.resample(None):
            yield bytes(out.planes[0])[: out.samples * 2]


@dataclass(frozen=True)
class AudioInfo:
    """アップロードされた音声ファイル（#180）を開いて分かったこと"""

    duration_sec: float
    # 音声のコーデック（mp3・aac・pcm_s16le など）とビットレート（分からなければ 0）
    codec: str
    bit_rate: int
    # 動画が入っているか（入っていれば音声だけを使う）
    has_video: bool


def probe(path: Path) -> AudioInfo:
    """音声ファイルを開いて、長さ・コーデック・ビットレートを調べる。
    PyAV で開けない・音声がなければ ValueError"""
    try:
        with av.open(str(path)) as src:
            if not src.streams.audio:
                raise ValueError("音声が入っていません")
            stream = src.streams.audio[0]
            if src.duration is not None:
                duration = src.duration / av.time_base
            elif stream.duration is not None and stream.time_base is not None:
                duration = float(stream.duration * stream.time_base)
            else:
                # 長さが書かれていないもの（一部の webm など）は、最後まで読んで数える
                duration = sum(f.samples / f.sample_rate for f in src.decode(audio=0))
            return AudioInfo(
                duration_sec=float(duration),
                codec=stream.codec_context.name,
                bit_rate=int(stream.bit_rate or src.bit_rate or 0),
                has_video=bool(src.streams.video),
            )
    except av.FFmpegError as e:
        raise ValueError(f"音声ファイルとして読めません: {e}") from e


def convert_audio(src_path: Path, out_dir: Path, sid: str, source: int | None = None) -> Path:
    """どんな音声・動画でも、録音と同じ形式（16kHz・モノラル・64kbps の mp3、
    なければ m4a）にする（#180。source は音源 ID）"""
    ext, container, encoder = pick_format()
    dst = out_dir / recording_name(sid, ext, source)
    tmp = dst.with_name(dst.name + ".tmp")
    try:
        with av.open(str(src_path)) as src, av.open(str(tmp), "w", format=container) as out:
            stream = out.add_stream(encoder, rate=16000, layout="mono")
            stream.bit_rate = BIT_RATE
            resampler = av.AudioResampler(format=stream.format.name, layout="mono", rate=16000)
            for frame in src.decode(audio=0):
                for converted in resampler.resample(frame):
                    converted.pts = None
                    for packet in stream.encode(converted):
                        out.mux(packet)
            for converted in resampler.resample(None):
                converted.pts = None
                for packet in stream.encode(converted):
                    out.mux(packet)
            for packet in stream.encode(None):
                out.mux(packet)
        tmp.replace(dst)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise
    return dst


def convert_wav(wav: Path, out_dir: Path, sid: str, source: int | None = None) -> Path:
    """WAV を out_dir/recording-<ID>.mp3（なければ .m4a）に変換して返す。
    失敗したら書きかけを消す（#356。source は音源 ID）"""
    ext, container, encoder = pick_format()
    dst = out_dir / recording_name(sid, ext, source)
    tmp = dst.with_name(dst.name + ".tmp")
    try:
        with av.open(str(wav)) as src, av.open(str(tmp), "w", format=container) as out:
            stream = out.add_stream(encoder, rate=16000, layout="mono")
            stream.bit_rate = BIT_RATE
            for frame in src.decode(audio=0):
                frame.pts = None
                for packet in stream.encode(frame):
                    out.mux(packet)
            for packet in stream.encode(None):
                out.mux(packet)
        tmp.replace(dst)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise
    return dst
