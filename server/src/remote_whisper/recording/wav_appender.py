"""録音の WAV に追記する（落ちても読めるよう、書くたびにヘッダーを直す）。spec/notes.md 9.1"""

import struct
import wave
from pathlib import Path
from typing import BinaryIO

from remote_whisper.recording.audio_convert import decode_pcm

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2  # Int16


class WavAppender:
    """`.tmp/<ID>/audio.wav` に追記する（書くたびにヘッダーを直す）。
    restore は続きの録音用（#101・#174。spec/flows.md 6.2）"""

    def __init__(self, path: Path, restore: Path | None = None):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._file: BinaryIO | None = None
        previous = None
        data = _appendable(path) if restore is not None and restore == path else None
        if data is not None:
            self._file = path.open("r+b")
            self._file.truncate(_HEADER + data)
            self._file.seek(0, 2)
            self.frames = data // SAMPLE_WIDTH
            self._sync_header()
            return
        if restore is not None and restore == path:
            # 同じ名前の WAV に書き直すので、前のものは別の名前にしておく
            previous = path.with_name(path.name + ".prev")
            path.replace(previous)
            restore = previous
        self._wav = wave.open(str(path), "wb")
        self._wav.setnchannels(1)
        self._wav.setsampwidth(SAMPLE_WIDTH)
        self._wav.setframerate(SAMPLE_RATE)
        self.frames = 0
        if restore is not None:
            try:
                for pcm in decode_pcm(restore):
                    self.write(pcm)
            except BaseException:
                self._wav.close()
                if previous is not None:
                    previous.replace(path)
                raise
            if previous is not None:
                previous.unlink()

    def write(self, pcm: bytes) -> None:
        # Int16 なので、半端な1バイトは捨てる
        pcm = pcm[: len(pcm) - len(pcm) % SAMPLE_WIDTH]
        if self._file is not None:
            self._file.write(pcm)
            self.frames += len(pcm) // SAMPLE_WIDTH
            self._sync_header()
            return
        self._wav.writeframes(pcm)
        self.frames += len(pcm) // SAMPLE_WIDTH

    def _sync_header(self) -> None:
        """書き足したファイルのヘッダーの長さを直す（wave と同じく、書くたびに直す）"""
        assert self._file is not None
        data = self.frames * SAMPLE_WIDTH
        self._file.seek(4)
        self._file.write(struct.pack("<I", _HEADER - 8 + data))
        self._file.seek(40)
        self._file.write(struct.pack("<I", data))
        self._file.seek(0, 2)
        self._file.flush()

    @property
    def seconds(self) -> float:
        return self.frames / SAMPLE_RATE

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            return
        self._wav.close()


# wave が書く WAV のヘッダーの長さ（RIFF・fmt・data の見出し）
_HEADER = 44


def _appendable(path: Path) -> int | None:
    """wave で書いた（ヘッダーが 44 バイトの）16kHz・モノラル・Int16 の WAV なら、音声のバイト数。
    そうでなければ None（名前を変えて読み直す、今までのやり方にする）"""
    try:
        with path.open("rb") as f:
            head = f.read(_HEADER)
        size = path.stat().st_size
    except OSError:
        return None
    if len(head) < _HEADER or head[:4] != b"RIFF" or head[8:16] != b"WAVEfmt ":
        return None
    if head[36:40] != b"data":
        return None
    fmt_size, kind, channels, rate, _, _, bits = struct.unpack("<IHHIIHH", head[16:36])
    if (fmt_size, kind, channels, rate, bits) != (16, 1, 1, SAMPLE_RATE, SAMPLE_WIDTH * 8):
        return None
    # ヘッダーの長さではなく、実際に書けていた分を使う（落ちて直す前のものでも読めるように）
    data = size - _HEADER
    return data - data % SAMPLE_WIDTH
