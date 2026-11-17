"""浄書の子プロセス（final_transcribe_worker.run）の結果と呼ぶ順番。WhisperX と torch は偽物"""

import json
import sys
import types
from collections import namedtuple

import numpy as np
import pytest

from remote_whisper.transcript import final_transcribe_multi as multi
from remote_whisper.transcript import final_transcribe_worker as worker
from remote_whisper.transcript import multisource

Turn = namedtuple("Turn", "start end speaker")


class FakeWhisperX:
    """呼ばれた順を calls に残す。文字起こしは音の値（音源ごとに違う）から決まった文を返す"""

    def __init__(
        self, diarize_error: Exception | None = None, assign_error: Exception | None = None
    ):
        self.calls: list[tuple] = []
        self.diarize_error = diarize_error
        self.assign_error = assign_error
        fake = self

        class Model:
            def transcribe(self, audio, batch_size=0, language="ja", progress_callback=None):
                value = int(audio[0])
                fake.calls.append(("transcribe", value, batch_size, language))
                progress_callback(50.0)
                progress_callback(100.0)
                segment = {"start": value * 1.0, "end": value + 0.5, "text": f"音{value}。"}
                return {"segments": [segment], "language": language}

        class Pipeline:
            def __init__(self, model_name=None, device=None):
                fake.calls.append(("diarization_model", model_name, device))
                if fake.diarize_error is not None:
                    raise fake.diarize_error

            def __call__(self, audio, progress_callback=None):
                fake.calls.append(("diarize", int(audio[0])))
                progress_callback(100.0)
                return types.SimpleNamespace(
                    itertuples=lambda: [Turn(0.0, 1.5, "SPEAKER_00"), Turn(1.5, 3.0, "SPEAKER_01")]
                )

        self.Model = Model
        self.diarize = types.ModuleType("whisperx.diarize")
        self.diarize.DiarizationPipeline = Pipeline

    def load_model(self, model, device, compute_type=None, language=None, asr_options=None):
        self.calls.append(("load_model", model, device, compute_type, language, asr_options))
        return self.Model()

    def load_align_model(self, language_code=None, device=None):
        self.calls.append(("load_align_model", language_code, device))
        model = types.SimpleNamespace(config=types.SimpleNamespace(_name_or_path="fake-align"))
        return model, {"language": language_code}

    def align(self, segments, model, metadata, audio, device, **kwargs):
        self.calls.append(("align", int(audio[0]), kwargs["return_char_alignments"]))
        kwargs["progress_callback"](100.0)
        out = []
        for s in segments:
            words = [
                {"word": c, "start": s["start"] + i * 0.1, "end": s["start"] + i * 0.1 + 0.1}
                for i, c in enumerate(s["text"])
            ]
            out.append({**s, "words": words})
        return {"segments": out}

    def assign_word_speakers(self, diarized, result):
        self.calls.append(("assign_word_speakers", len(result["segments"])))
        if self.assign_error is not None:
            raise self.assign_error
        for s in result["segments"]:
            speaker = "SPEAKER_00" if s["start"] < 1.5 else "SPEAKER_01"
            s["speaker"] = speaker
            for w in s["words"]:
                w["speaker"] = speaker
        return result


@pytest.fixture
def fake_whisperx(monkeypatch):
    def install(diarize_error=None, assign_error=None):
        fake = FakeWhisperX(diarize_error, assign_error)
        module = types.ModuleType("whisperx")
        for name in ("load_model", "load_align_model", "align", "assign_word_speakers"):
            setattr(module, name, getattr(fake, name))
        module.diarize = fake.diarize
        torch = types.ModuleType("torch")
        torch.cuda = types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
        monkeypatch.setitem(sys.modules, "whisperx", module)
        monkeypatch.setitem(sys.modules, "whisperx.diarize", fake.diarize)
        monkeypatch.setitem(sys.modules, "torch", torch)
        monkeypatch.delenv("HF_HOME", raising=False)
        # 録音は、パスの名前の数字で埋めた短い音にする
        monkeypatch.setattr(
            worker, "load_audio", lambda path: np.full(4, float(path[-1]), dtype=np.float32)
        )
        return fake

    return install


def progress_lines(capsys) -> list[dict]:
    prefix = worker.PROGRESS_PREFIX
    out = capsys.readouterr().out.splitlines()
    return [json.loads(line[len(prefix) :]) for line in out if line.startswith(prefix)]


JOB = {
    "audio": "rec-1",
    "out": "unused",
    "model": "large-v3-turbo",
    "computeType": "float16",
    "language": "ja",
    "diarize": True,
    "diarizationModel": "diar-model",
    "batchSize": 4,
    "hotwords": "用語",
    "initialPrompt": "例文。",
}


def word(c, start, speaker):
    return {"word": c, "start": start, "end": start + 0.1, "speaker": speaker}


def test_single_source_result_calls_and_progress(fake_whisperx, capsys):
    fake = fake_whisperx()
    result = worker.run(dict(JOB))
    words = [
        {"word": c, "start": 1.0 + i * 0.1, "end": 1.0 + i * 0.1 + 0.1, "speaker": "SPEAKER_00"}
        for i, c in enumerate("音1。")
    ]
    assert result == {
        "segments": [
            {"start": 1.0, "end": 1.5, "text": "音1。", "speaker": "SPEAKER_00", "words": words}
        ],
        "turns": [
            {"start": 0.0, "end": 1.5, "speaker": "SPEAKER_00"},
            {"start": 1.5, "end": 3.0, "speaker": "SPEAKER_01"},
        ],
        "diarization": "done",
        "diarizationError": None,
        "alignModel": "fake-align",
        "device": "cpu",
    }
    assert fake.calls == [
        (
            "load_model",
            "large-v3-turbo",
            "cpu",
            "int8",
            "ja",
            {"hotwords": "用語", "initial_prompt": "例文。"},
        ),
        ("transcribe", 1, 4, "ja"),
        ("load_align_model", "ja", "cpu"),
        ("align", 1, False),
        ("diarization_model", "diar-model", "cpu"),
        ("diarize", 1),
        ("assign_word_speakers", 1),
    ]
    assert progress_lines(capsys) == [
        {"step": "load", "done": 0, "total": 4},
        {"step": "transcribe", "done": 1, "total": 4},
        {"step": "transcribe", "done": 1, "total": 4, "percent": 50.0},
        {"step": "transcribe", "done": 1, "total": 4, "percent": 100.0},
        {"step": "align", "done": 2, "total": 4},
        {"step": "align", "done": 2, "total": 4, "percent": 100.0},
        {"step": "diarize", "done": 3, "total": 4},
        {"step": "diarize", "done": 3, "total": 4, "percent": 100.0},
    ]


def test_single_source_without_diarization(fake_whisperx, capsys):
    fake = fake_whisperx()
    result = worker.run({**JOB, "diarize": False, "hotwords": None, "initialPrompt": None})
    assert result["diarization"] == "off" and result["turns"] == []
    assert result["segments"][0]["speaker"] is None
    assert fake.calls[0][-1] is None
    assert [c[0] for c in fake.calls] == ["load_model", "transcribe", "load_align_model", "align"]
    assert [line["total"] for line in progress_lines(capsys)] == [3] * 6


def test_diarization_error_is_reported_and_skipped(fake_whisperx):
    fake_whisperx(RuntimeError("403 Forbidden\nmore"))
    result = worker.run(dict(JOB))
    assert result["diarization"] == "unavailable"
    assert result["diarizationError"] == "RuntimeError: 403 Forbidden"
    assert result["turns"] == []
    assert result["segments"][0]["speaker"] is None


def test_turns_are_kept_when_assigning_speakers_fails(fake_whisperx):
    # 区間はできたが、単語への話者の割り当てで落ちた。区間は残し、話者は付けない
    fake_whisperx(assign_error=ValueError("bad frame"))
    result = worker.run(dict(JOB))
    assert result["diarization"] == "unavailable"
    assert result["diarizationError"] == "ValueError: bad frame"
    assert result["turns"] == [
        {"start": 0.0, "end": 1.5, "speaker": "SPEAKER_00"},
        {"start": 1.5, "end": 3.0, "speaker": "SPEAKER_01"},
    ]
    assert result["segments"][0]["speaker"] is None


def test_hint_conflicts_are_counted_through_run(fake_whisperx, monkeypatch):
    fake_whisperx()
    # 3.0〜4.1 秒は音源 1、4.1 秒から音源 7 が一番大きく、どこもはっきりしている。
    # SPEAKER_01 の語は音源 1 から 4 つ、音源 7 から 2 つなので、2 つが見直しの候補
    choice = np.array([0] * 41 + [1] * 9)
    prepared = multisource.Prepared(
        gated=[np.full(4, 3.0), np.full(4, 4.0)],
        joined=np.full(4, 5.0),
        choice=choice,
        margin=np.full(50, 10.0),
    )
    alignment = multisource.Alignment(offset_sec=0.0, drift_ppm=0.0, windows=3)
    monkeypatch.setattr(multisource, "align", lambda main, other, rough: alignment)
    monkeypatch.setattr(multisource, "to_main_time", lambda x, a, n: np.asarray(x)[:n])
    monkeypatch.setattr(multisource, "prepare", lambda sources, present: prepared)
    job = {
        **JOB,
        "sources": [{"id": 1, "audio": "rec-1"}, {"id": 7, "audio": "rec-2"}],
    }
    result = worker.run(job)
    assert result["hintConflicts"] == 2
    assert result["dominant"] == [[0.0, 4.1, 1], [4.1, 5.0, 7]]


def test_multiple_sources_result_calls_and_progress(fake_whisperx, monkeypatch, capsys):
    fake = fake_whisperx()
    aligned = []

    def align(main, other, rough):
        aligned.append((int(main[0]), int(other[0]), rough))
        return multisource.Alignment(offset_sec=0.12345, drift_ppm=-41.23, windows=3)

    def prepare(sources, present):
        assert [int(s[0]) for s in sources] == [1, 2]
        # 音源 1 が 0〜1.5 秒、音源 2 が 1.5〜3 秒で一番大きい。はっきりしているのは 1 秒から先
        choice = np.array([0] * 15 + [1] * 15)
        margin = np.array([0.0] * 10 + [10.0] * 20)
        return multisource.Prepared(
            gated=[np.full(4, 3.0), np.full(4, 4.0)],
            joined=np.full(4, 5.0),
            choice=choice,
            margin=margin,
        )

    monkeypatch.setattr(multisource, "align", align)
    monkeypatch.setattr(multisource, "to_main_time", lambda x, a, n: np.asarray(x)[:n])
    monkeypatch.setattr(multisource, "prepare", prepare)
    job = {
        **JOB,
        "sources": [
            {"id": 1, "audio": "rec-1", "roughOffsetSec": 0.0},
            {"id": 7, "audio": "rec-2", "roughOffsetSec": 4.5},
        ],
    }
    result = worker.run(job)
    assert aligned == [(1, 2, 4.5)]
    assert result["segments"] == [
        {
            "start": 3.0,
            "end": 3.5,
            "text": "音3。",
            "speaker": "SPEAKER_01",
            "words": [word(c, 3.0 + i * 0.1, "SPEAKER_01") for i, c in enumerate("音3。")],
            "source": 1,
        },
        {
            "start": 4.0,
            "end": 4.5,
            "text": "音4。",
            "speaker": "SPEAKER_01",
            "words": [word(c, 4.0 + i * 0.1, "SPEAKER_01") for i, c in enumerate("音4。")],
            "source": 7,
        },
    ]
    assert {k: v for k, v in result.items() if k != "segments"} == {
        "turns": [
            {"start": 0.0, "end": 1.5, "speaker": "SPEAKER_00"},
            {"start": 1.5, "end": 3.0, "speaker": "SPEAKER_01"},
        ],
        "diarization": "done",
        "diarizationError": None,
        "alignModel": "fake-align",
        "device": "cpu",
        "sources": [
            {"id": 1, "offsetSec": 0.0, "driftPpm": 0.0, "windows": None},
            {"id": 7, "offsetSec": 0.123, "driftPpm": -41.2, "windows": 3},
        ],
        "dominant": [[0.0, 1.5, 1], [1.5, 3.0, 7]],
        # 語の時刻（3 秒から先）は choice の外なので、ヒントは出ない
        "hintConflicts": None,
    }
    assert fake.calls == [
        (
            "load_model",
            "large-v3-turbo",
            "cpu",
            "int8",
            "ja",
            {"hotwords": "用語", "initial_prompt": "例文。"},
        ),
        ("transcribe", 3, 4, "ja"),
        ("transcribe", 4, 4, "ja"),
        ("load_align_model", "ja", "cpu"),
        ("align", 3, False),
        ("align", 4, False),
        ("diarization_model", "diar-model", "cpu"),
        ("diarize", 5),
        ("assign_word_speakers", 1),
        ("assign_word_speakers", 1),
    ]
    # 音源ごとの % は、段階全体の % にする
    percents = [(p["step"], p.get("percent")) for p in progress_lines(capsys)]
    assert percents == [
        ("load", None),
        ("transcribe", None),
        ("transcribe", 25.0),
        ("transcribe", 50.0),
        ("transcribe", 75.0),
        ("transcribe", 100.0),
        ("align", None),
        ("align", 50.0),
        ("align", 100.0),
        ("diarize", None),
        ("diarize", 100.0),
    ]


def test_merge_segments_tags_the_source_and_sorts_by_start():
    results = [
        {"segments": [{"start": 2.0, "end": 3.0, "text": "後"}, {"start": None, "text": "?"}]},
        {"segments": [{"start": 1.0, "end": 1.5, "text": "先", "words": [{"word": "先"}]}]},
    ]
    merged = multi.merge_segments([1, 7], results)
    assert [(s["text"], s["source"]) for s in merged] == [("?", 1), ("先", 7), ("後", 1)]
    assert merged[1]["words"] == [{"word": "先", "start": None, "end": None, "speaker": None}]


def test_hint_conflicts_counts_words_from_an_unusual_source():
    choice = np.array([0] * 10 + [1] * 10)
    margin = np.array([10.0] * 20)
    segments = [
        {"words": [word("あ", 0.1, "A"), word("い", 0.2, "A"), word("う", 1.2, "A")]},
        {"words": [word("え", 1.5, "B"), {"word": "お", "start": None, "speaker": "B"}]},
    ]
    assert multi.hint_conflicts(segments, choice, margin, [1, 2]) == (1, 4)
    assert multi.hint_conflicts(segments, choice, np.zeros(20), [1, 2]) is None
