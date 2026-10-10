"""録音の WAV を mp3（モノラル・64kbps）に変換する。spec 9.1

変換には faster-whisper が内部で使っている PyAV を使う。mp3 のエンコーダーがない配布版なら
m4a（AAC）にする（#36 で確かめる）。CPU で動くので、GPU キューには積まない。
"""

import contextlib
import logging
from pathlib import Path

import av

from remote_whisper.documents import recording_name

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


def convert_wav(wav: Path, out_dir: Path, sid: str) -> Path:
    """WAV を out_dir/recording-<ID>.mp3（なければ .m4a）に変換して、できたファイルを返す

    途中で失敗したら、書きかけのファイルは消して例外を投げる（WAV はそのまま残る）。
    """
    ext, container, encoder = pick_format()
    dst = out_dir / recording_name(sid, ext)
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
