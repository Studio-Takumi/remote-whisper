"""Intel の GPU（OpenVINO）での文字起こし（#374）。OpenVINO は入れずに、偽物で確かめる"""

import types
from types import SimpleNamespace

import numpy as np
import pytest

from remote_whisper.gpu import openvino_whisper
from remote_whisper.gpu.whisper_worker import ModelSpec, WhisperWorker, _transcribe
from remote_whisper.hub import Hub
from remote_whisper.settings import SettingsStore
from remote_whisper.transcript import worker_steps

SR = 16000


class FakeCore:
    """openvino.Core の偽物。Iris Xe（内蔵）と Arc（単体）がある PC"""

    def __init__(self, devices=None):
        self.devices = devices or {
            "CPU": {"FULL_DEVICE_NAME": "12th Gen Intel(R) Core(TM)"},
            "GPU.0": {
                "FULL_DEVICE_NAME": "Intel(R) Iris(R) Xe Graphics (iGPU)",
                "DEVICE_LUID": "eb34010000000000",
                "GPU_DEVICE_TOTAL_MEM_SIZE": 7490465792,
            },
            "GPU.1": {
                "FULL_DEVICE_NAME": "Intel(R) Arc(TM) A350M Graphics (dGPU)",
                "DEVICE_LUID": "3039010000000000",
                "GPU_DEVICE_TOTAL_MEM_SIZE": 4126859264,
            },
        }

    @property
    def available_devices(self):
        return list(self.devices)

    def get_property(self, device, name):
        return self.devices[device][name]


def test_finds_only_a_discrete_gpu():
    device = openvino_whisper.find_device(FakeCore())
    assert device == openvino_whisper.Device(
        "GPU.1",
        "Intel(R) Arc(TM) A350M Graphics (dGPU)",
        "luid_0x00000000_0x00013930",
        3935,
    )
    # 内蔵の GPU だけなら使わない
    core = FakeCore()
    del core.devices["GPU.1"]
    assert openvino_whisper.find_device(core) is None


def test_finds_nothing_when_openvino_fails():
    class Broken:
        @property
        def available_devices(self):
            raise RuntimeError("no driver")

    assert openvino_whisper.find_device(Broken()) is None


def test_counter_luid():
    # DEVICE_LUID はリトルエンディアンの 8 バイト。性能カウンターは「上位_下位」
    assert openvino_whisper.counter_luid("3039010000000000") == "luid_0x00000000_0x00013930"
    assert openvino_whisper.counter_luid("0100000002000000") == "luid_0x00000002_0x00000001"
    assert openvino_whisper.counter_luid("xyz") is None
    assert openvino_whisper.counter_luid("3039") is None


def test_detect_keeps_nvidia_and_machines_without_the_extra(monkeypatch):
    # NVIDIA の GPU がある・extra が入っていないなら、Intel の GPU を探さない（今までどおり）
    found = openvino_whisper.Device("GPU.1", "Arc (dGPU)", None, None)
    searched = []

    def find_device():
        searched.append(True)
        return found

    monkeypatch.setattr(openvino_whisper, "find_device", find_device)
    cases = [(False, False, None), (True, True, None), (True, False, found)]
    for has_extra, has_nvidia, expected in cases:
        openvino_whisper.detect.cache_clear()
        monkeypatch.setattr(openvino_whisper, "installed", lambda v=has_extra: v)
        monkeypatch.setattr(openvino_whisper, "_nvidia_present", lambda v=has_nvidia: v)
        assert openvino_whisper.detect() == expected
    openvino_whisper.detect.cache_clear()
    assert searched == [True]


def test_repo_for():
    assert (
        openvino_whisper.repo_for("large-v3-turbo", "int8")
        == "OpenVINO/whisper-large-v3-turbo-int8-ov"
    )
    assert openvino_whisper.repo_for("someone/my-ov", "fp16") == "someone/my-ov"


class FakePipe:
    """WhisperPipeline の偽物。渡されたものを覚えて、決めた区間を返す"""

    def __init__(self, chunks=None, texts=None):
        self.calls: list[tuple[int, dict]] = []
        self.chunks = chunks
        self.texts = texts

    def generate(self, audio, **kwargs):
        self.calls.append((len(audio), kwargs))
        chunks = self.chunks
        if chunks is None:
            chunks = [SimpleNamespace(start_ts=0.0, end_ts=1.0, text="こんにちは")]
        return SimpleNamespace(chunks=chunks, texts=self.texts or [])


def test_generate_passes_greedy_options_and_has_no_scores():
    pipe = FakePipe(
        chunks=[
            SimpleNamespace(start_ts=0.0, end_ts=1.5, text="こんにちは"),
            # 終わりの時刻がない（-1）区間は、音声の終わりまで
            SimpleNamespace(start_ts=1.5, end_ts=-1.0, text="今日は"),
        ]
    )
    audio = np.zeros(SR * 3, dtype=np.float32)
    options = {"initial_prompt": "例文。", "hotwords": "用語A", "beam_size": 5}
    result = openvino_whisper.generate(pipe, audio, options)
    _, kwargs = pipe.calls[0]
    assert kwargs == {
        "language": "<|ja|>",
        "task": "transcribe",
        "return_timestamps": True,
        # 3 秒 × 12 + 32。greedy で繰り返し始めても止まる
        "max_new_tokens": 68,
        "initial_prompt": "例文。",
        "hotwords": "用語A",
    }
    assert [(s["start"], s["end"], s["text"]) for s in result] == [
        (0.0, 1.5, "こんにちは"),
        (1.5, 3.0, "今日は"),
    ]
    for s in result:
        assert "no_speech_prob" not in s and "avg_logprob" not in s
        assert 0 < s["compression_ratio"] < 2


def test_generate_without_chunks_uses_the_text():
    pipe = FakePipe(chunks=[], texts=["はい"])
    result = openvino_whisper.generate(pipe, np.zeros(SR, dtype=np.float32), {"language": "en"})
    assert pipe.calls[0][1]["language"] == "<|en|>"
    assert "initial_prompt" not in pipe.calls[0][1]
    assert [(s["start"], s["end"], s["text"]) for s in result] == [(0.0, 1.0, "はい")]


def test_max_new_tokens_is_capped():
    assert openvino_whisper.max_new_tokens(SR * 60) == 448


def test_compression_ratio_finds_repetition():
    assert openvino_whisper.compression_ratio("") == 0.0
    assert openvino_whisper.compression_ratio("うん" * 100) > 2.4
    assert openvino_whisper.compression_ratio("今日はいい天気ですね") < 2.4


def test_transcribe_uses_vad_and_measures_voiced_time(monkeypatch):
    # 話している範囲だけを渡し、時刻を戻し、文ごとに話している長さを付ける
    monkeypatch.setattr(
        openvino_whisper, "speech_spans", lambda audio, max_speech_sec=None: [(SR, 2 * SR)]
    )
    pipe = FakePipe(chunks=[SimpleNamespace(start_ts=0.0, end_ts=1.0, text="はい")])
    result = openvino_whisper.transcribe(pipe, np.zeros(SR * 3, dtype=np.float32), {})
    assert pipe.calls[0][0] == SR
    assert result[0]["start"] == 1.0 and result[0]["end"] == 2.0
    assert result[0]["voiced_sec"] == pytest.approx(1.0)


def test_vad_cut_segments_also_get_voiced_time_per_sentence(monkeypatch):
    # 録音中の既定（VadSegmenter → vad_filter False）: 切り詰めずに全部渡し、文ごとに
    # 話している長さを付ける。話した後ろに付いた定番の文は、その文の範囲で判定される
    from remote_whisper.recording.hallucination import drop_reason

    monkeypatch.setattr(
        openvino_whisper, "speech_spans", lambda audio, max_speech_sec=None: [(0, 3 * SR)]
    )
    pipe = FakePipe(
        chunks=[
            SimpleNamespace(start_ts=0.0, end_ts=3.0, text="今日は会議の続きです"),
            SimpleNamespace(start_ts=4.0, end_ts=6.0, text="ご視聴ありがとうございました"),
        ]
    )
    result = openvino_whisper.transcribe(
        pipe, np.zeros(SR * 6, dtype=np.float32), {"vad_filter": False}
    )
    assert pipe.calls[0][0] == SR * 6
    assert result[0]["voiced_sec"] == pytest.approx(3.0)
    assert result[1]["voiced_sec"] == 0.0
    # 区間全体では 3 秒話しているが、文ごとに見るので捨てる
    assert drop_reason(result[0], 3.0) is None
    assert drop_reason(result[1], 3.0) == "no_speech"


def test_logs_when_the_token_limit_may_have_cut_the_text(caplog):
    pipe = FakePipe(chunks=[SimpleNamespace(start_ts=0.0, end_ts=1.0, text="あ" * 40)])
    with caplog.at_level("INFO", logger="remote_whisper.gpu.openvino_whisper"):
        openvino_whisper.generate(pipe, np.zeros(SR, dtype=np.float32), {})
    # 1 秒 → 上限 44。7 割（30.8 文字）を超えたら残す
    assert "may be cut at max_new_tokens=44" in caplog.text


def test_transcribe_skips_audio_without_speech(monkeypatch):
    monkeypatch.setattr(openvino_whisper, "speech_spans", lambda audio, max_speech_sec=None: [])
    pipe = FakePipe()
    assert openvino_whisper.transcribe(pipe, np.zeros(SR, dtype=np.float32), {}) == []
    assert pipe.calls == []
    # VAD を切れば（VAD で切り出した区間）、そのまま全部渡す。VAD が声を見つけなければ
    # 切り出した側の判定を信じて、話している長さは付けない
    result = openvino_whisper.transcribe(
        pipe, np.zeros(SR, dtype=np.float32), {"vad_filter": False}
    )
    assert pipe.calls[0][0] == SR
    assert "voiced_sec" not in result[0]


def test_voiced_sec_counts_only_the_overlap():
    spans = [(0, SR), (3 * SR, 4 * SR)]
    # 1.5〜2.5 秒（前後 0.3 秒広げても 1.2〜2.8 秒）には話していない
    assert openvino_whisper.voiced_sec(spans, 1.5, 2.5) == 0.0
    # 0.2〜3.8 秒: 0.2〜1 秒と 3〜3.8 秒
    assert openvino_whisper.voiced_sec(spans, 0.5, 3.5) == pytest.approx(1.6)


def test_windows_join_spans_up_to_30_seconds():
    spans = [(0, 10 * SR), (12 * SR, 25 * SR), (26 * SR, 40 * SR), (41 * SR, 45 * SR)]
    assert openvino_whisper.windows(spans) == [(0, 25 * SR), (26 * SR, 45 * SR)]


def test_transcribe_long_shifts_times_drops_repetition_and_reports_progress(monkeypatch):
    monkeypatch.setattr(
        openvino_whisper,
        "speech_spans",
        lambda audio, max_speech_sec=None: [(0, 10 * SR), (40 * SR, 50 * SR)],
    )
    pipe = FakePipe(
        chunks=[
            SimpleNamespace(start_ts=0.0, end_ts=2.0, text="はい。"),
            SimpleNamespace(start_ts=2.0, end_ts=4.0, text="うん" * 100),
            SimpleNamespace(start_ts=4.0, end_ts=5.0, text=" "),
        ]
    )
    progress = []
    result = openvino_whisper.transcribe_long(
        pipe, np.zeros(SR * 60, dtype=np.float32), {"initial_prompt": "例文。"}, progress.append
    )
    assert [(s["start"], s["end"], s["text"]) for s in result] == [
        (0.0, 2.0, "はい。"),
        (40.0, 42.0, "はい。"),
    ]
    assert progress == [50.0, 100.0]
    assert [n for n, _ in pipe.calls] == [10 * SR, 10 * SR]


# --- 録音中の文字起こし（whisper_worker） ---


def test_worker_uses_openvino_only_when_found_and_allowed(home):
    settings = SettingsStore(home)
    worker = WhisperWorker(Hub(), settings, openvino_device="GPU.1")
    assert worker._spec() == ModelSpec("OpenVINO/whisper-large-v3-turbo-int8-ov", "int8", "GPU.1")
    settings.update({"whisper": {"intelGpu": "off"}})
    assert worker._spec() == ModelSpec("large-v3-turbo", "float16")
    # 見つかっていなければ（NVIDIA・Mac）今までどおり
    assert WhisperWorker(Hub(), SettingsStore(home))._spec() == ModelSpec(
        "large-v3-turbo", "float16"
    )


def test_worker_transcribes_with_openvino(monkeypatch):
    seen = {}

    def transcribe(pipe, audio, options):
        seen.update(pipe=pipe, samples=len(audio), options=options)
        return [{"start": 0.0, "end": 1.0, "text": "はい", "compression_ratio": 1.0}]

    monkeypatch.setattr(openvino_whisper, "transcribe", transcribe)
    result = _transcribe("openvino", "pipe", b"\0\0" * SR, {"beam_size": 5})
    assert seen == {"pipe": "pipe", "samples": SR, "options": {"beam_size": 5}}
    assert result[0]["text"] == "はい"


def test_worker_child_loads_openvino_for_an_openvino_spec(monkeypatch):
    # 子プロセスの中の処理（_serve）を、パイプの偽物で動かす
    from remote_whisper.gpu import whisper_worker

    loaded = []
    monkeypatch.setattr(
        openvino_whisper, "load", lambda repo, device: loaded.append((repo, device)) or "pipe"
    )
    monkeypatch.setattr(
        openvino_whisper, "transcribe", lambda pipe, audio, options: [{"text": pipe}]
    )

    class Conn:
        def __init__(self, messages):
            self.messages = list(messages)
            self.sent = []

        def recv(self):
            if not self.messages:
                raise EOFError
            return self.messages.pop(0)

        def send(self, value):
            self.sent.append(value)

    spec = ModelSpec("OpenVINO/whisper-large-v3-turbo-int8-ov", "int8", "GPU.1")
    conn = Conn([("load", spec), ("transcribe", b"\0\0" * 10, {})])
    whisper_worker._serve(conn, "faster-whisper")
    assert loaded == [("OpenVINO/whisper-large-v3-turbo-int8-ov", "GPU.1")]
    assert conn.sent == [("ok", None), ("ok", [{"text": "pipe"}])]


# --- 浄書（worker） ---


def test_final_worker_transcribes_with_openvino(monkeypatch):
    monkeypatch.setattr(openvino_whisper, "load", lambda repo, device: (repo, device))
    calls = []

    def transcribe_long(pipe, audio, options, progress=None):
        calls.append((pipe, options))
        progress(100.0)
        return [{"start": 0.0, "end": 1.0, "text": "はい。"}]

    monkeypatch.setattr(openvino_whisper, "transcribe_long", transcribe_long)
    job = {
        "model": "large-v3-turbo",
        "hotwords": "用語A",
        "initialPrompt": "例文。",
        "openvino": {"device": "GPU.1", "model": "OpenVINO/whisper-large-v3-turbo-fp16-ov"},
    }
    whisperx = types.SimpleNamespace(load_model=lambda *a, **k: pytest.fail("WhisperX で起こした"))
    model = worker_steps._load_asr(job, whisperx, "cpu", "int8")
    progress = []
    result = model.transcribe(
        np.zeros(SR), batch_size=8, language="ja", progress_callback=progress.append
    )
    assert result["segments"] == [{"start": 0.0, "end": 1.0, "text": "はい。"}]
    assert calls == [
        (
            ("OpenVINO/whisper-large-v3-turbo-fp16-ov", "GPU.1"),
            {"hotwords": "用語A", "initial_prompt": "例文。", "language": "ja"},
        )
    ]
    assert progress == [100.0]


def test_final_worker_uses_whisperx_without_openvino():
    seen = {}

    def load_model(model, device, **kwargs):
        seen.update(model=model, device=device, **kwargs)
        return "whisperx-model"

    whisperx = types.SimpleNamespace(load_model=load_model)
    job = {"model": "large-v3-turbo", "language": "ja", "hotwords": "用語A"}
    model = worker_steps._load_asr(job, whisperx, "cuda", "float16")
    assert model == "whisperx-model"
    assert seen == {
        "model": "large-v3-turbo",
        "device": "cuda",
        "compute_type": "float16",
        "language": "ja",
        "asr_options": {"hotwords": "用語A"},
    }
