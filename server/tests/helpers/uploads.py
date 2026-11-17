"""音声ファイルのアップロードのテストの共通の部品"""

import av
import numpy as np

RATE = 16000


def _tone(seconds: float, rate: int = RATE, channels: int = 1) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    tone = (np.sin(2 * np.pi * 440 * t) * 8000).astype(np.int16)
    return np.repeat(tone[:, None], channels, axis=1)


def write_audio(path, encoder: str, seconds=3.0, rate=RATE, channels=1, bit_rate=None, fmt=None):
    """テスト用の音声ファイルを作る（PyAV で書く）"""
    layout = "mono" if channels == 1 else "stereo"
    with av.open(str(path), "w", format=fmt) as out:
        stream = out.add_stream(encoder, rate=rate, layout=layout)
        if bit_rate:
            stream.bit_rate = bit_rate
        samples = _tone(seconds, rate, channels)
        frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format="s16", layout=layout)
        frame.sample_rate = rate
        resampler = av.AudioResampler(format=stream.format.name, layout=layout, rate=rate)
        for converted in resampler.resample(frame):
            for packet in stream.encode(converted):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    return path


def upload(client, pid, path, name=None, last_modified=None, sources=None):
    params = {"name": name or path.name}
    if last_modified is not None:
        params["lastModified"] = last_modified
    if sources is not None:
        params["sources"] = sources
    return client.post(
        f"/api/projects/{pid}/sessions/upload", params=params, content=path.read_bytes()
    )


def wait_done(client):
    client.portal.call(client.app.state.ctx.uploads.wait)
