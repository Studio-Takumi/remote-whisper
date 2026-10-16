"""録音のあとに、今回扱った資料の範囲で参考資料を作り直す（#182）"""

import json

import pytest
from fastapi.testclient import TestClient
from test_context_sets import create_and_wait
from test_final_summary import record
from test_recorder import receive_until
from test_uploads import upload, wait_done, write_audio

from remote_whisper import material_range
from remote_whisper.app import create_app
from remote_whisper.documents import (
    ContextMeta,
    ContextSetMeta,
    SummaryMeta,
    TranscriptMeta,
    context_name,
    hotwords_name,
    read_doc,
)
from remote_whisper.live_transcriber import load_hotwords
from remote_whisper.material_range import excerpt, normalize_ranges
from remote_whisper.material_toc import MaterialToc, TocEntry, build_toc, range_text

CHAPTERS = 10


def _toc(chars_each: int = 1000, n: int = CHAPTERS) -> MaterialToc:
    entries = [TocEntry(index=i, title=f"第{i}章", chars=chars_each) for i in range(1, n + 1)]
    return MaterialToc(
        path="D:\\work\\slides.md",
        kind="headings",
        chars=chars_each * n,
        large=True,
        entries=entries,
    )


# --- 純粋な関数 ---


def test_ranges_get_a_margin_and_are_merged():
    ranges = normalize_ranges([(1, 3, 4), (1, 6, 6)], [_toc()])
    # 前後に 1 つずつ足すと 2〜5 と 5〜7 になり、つながる
    assert [(r.file, r.start, r.end) for r in ranges] == [("slides.md", 2, 7)]


def test_ranges_are_clamped_and_reversed_ones_are_fixed():
    ranges = normalize_ranges([(1, 2, 1)], [_toc()])
    assert [(r.start, r.end) for r in ranges] == [(1, 3)]
    assert normalize_ranges([(1, 9, 30)], [_toc()])[0].end == CHAPTERS


def test_separate_ranges_stay_separate():
    ranges = normalize_ranges([(1, 2, 2), (1, 8, 8)], [_toc()])
    assert [(r.start, r.end) for r in ranges] == [(1, 3), (7, 9)]


def test_almost_the_whole_material_is_not_rebuilt():
    # 前後の余白を足すと 8 割以上になる
    assert normalize_ranges([(1, 2, 8)], [_toc()]) is None
    # 範囲がない・知らない資料だけ
    assert normalize_ranges([], [_toc()]) is None
    assert normalize_ranges([(2, 1, 3)], [_toc()]) is None


def test_excerpt_takes_the_head_middle_and_tail():
    lines = [f"[00:00:{i:02d}] {i:03d}" + "あ" * 50 for i in range(300)]
    text = excerpt(lines, limit=600)
    assert text.startswith("[00:00:00] 000")
    assert text.rstrip().endswith(lines[-1])
    assert text.count("（中略）") == 2
    assert 600 <= len(text) <= 900
    # 短ければそのまま
    assert excerpt(["a", "", "b"]) == "a\nb"


def test_range_text_takes_only_the_sections(tmp_path):
    md = tmp_path / "slides.md"
    md.write_text("\n\n".join(f"# 第{i}章\n本文{i}" for i in range(1, 6)), encoding="utf-8")
    assert build_toc(md).kind == "headings"
    text = range_text(md, [(2, 3)])
    assert "本文2" in text and "本文3" in text
    assert "本文1" not in text and "本文4" not in text


# --- 録音・アップロードの流れ ---


@pytest.fixture
def client(home):
    with TestClient(create_app(home)) as client:
        yield client


def _material(root, chapters=CHAPTERS):
    path = root / "docs" / "slides.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n\n".join(
            f"# 第{i}章 話題{i}\n" + f"第{i}章の本文。" * 120 for i in range(1, chapters + 1)
        ),
        encoding="utf-8",
    )
    return path


@pytest.fixture
def setup(client, tmp_path, fake_ollama, monkeypatch):
    """大きい資料（10 章）の参考資料セットを選んだプロジェクト"""
    # テストの文字起こし（偽の Whisper）は短いので、判断する下限をなくす
    monkeypatch.setattr(material_range, "MIN_EXCERPT_CHARS", 0)
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    pid = client.post("/api/projects", json={"path": str(root / "meetings")}).json()["id"]
    d = client.app.state.ctx.projects.dir(pid)
    fake_ollama.reply = ["全体の語"]
    body, _ = create_and_wait(client, pid, [str(_material(root))])
    base = body["id"]
    assert read_doc(d / context_name(base), ContextMeta)[0].toc[0].large
    return pid, d, base


def replies(fake_ollama, scope=None):
    """頼み方ごとに返す本文を決める。scope は範囲の判断の答え（None なら判断を頼まれない想定）"""
    asked = {"scope": [], "terms": [], "context": [], "summary": []}

    def reply_for(body):
        content = body["messages"][-1]["content"]
        props = (body.get("format") or {}).get("properties", {})
        if "rebuild" in props:
            asked["scope"].append(content)
            return scope if isinstance(scope, str) else json.dumps(scope, ensure_ascii=False)
        if "1行に1語" in content:
            asked["terms"].append(content)
            return "範囲の語\n範囲の別の語"
        if "背景" in content and "## 参考資料" in content:
            asked["context"].append(content)
            return "範囲のコンテキスト"
        if "## 文字起こし" in content:
            asked["summary"].append(content)
        return None

    fake_ollama.reply_for = reply_for
    return asked


class Final:
    """最終の文字起こしの偽物。浄書に使われた用語リストと、そのときのコンテキストを覚えておく"""

    def __init__(self):
        self.hotwords = []
        self.contexts = []

    def enabled(self):
        return True

    async def run(self, files, meta):
        self.hotwords.append(load_hotwords(files.dir, meta.context_set))
        _, context = read_doc(files.dir / context_name(meta.context_set), ContextMeta)
        self.contexts.append(context.strip())
        return None


def _use_final(client):
    final = Final()
    ctx = client.app.state.ctx
    ctx.recorder.final_transcript = final
    ctx.uploads.final_transcriber = final
    return final


def test_recording_rebuilds_terms_before_and_context_after_the_final_transcript(
    client, setup, fake_ollama
):
    pid, d, base = setup
    asked = replies(fake_ollama, {"rebuild": True, "ranges": [{"material": 1, "from": 3, "to": 4}]})
    final = _use_final(client)

    sid, _ = record(client, pid)

    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.base_context_set == base
    assert meta.context_set != base
    assert [(r.file, r.start, r.end) for r in meta.material_range] == [("slides.md", 2, 5)]
    # 判断は 1 回。範囲の用語リストは範囲（第 2〜5 章）のテキストだけから作る
    assert len(asked["scope"]) == 1
    assert "第2章の本文" in asked["terms"][0] and "第5章の本文" in asked["terms"][0]
    assert "第1章の本文" not in asked["terms"][0] and "第6章の本文" not in asked["terms"][0]
    # 浄書は範囲の用語リストで、そのときコンテキストはまだ元のまま（浄書の後に作り直す）
    assert final.hotwords == ["範囲の語、範囲の別の語"]
    assert final.contexts == [read_doc(d / context_name(base), ContextMeta)[1].strip()]
    # 最終の要約は範囲のコンテキストで作る
    assert "範囲のコンテキスト" in asked["summary"][-1]
    set_meta, _ = read_doc(d / hotwords_name(meta.context_set), ContextSetMeta)
    assert set_meta.session == sid
    summary = next(d.glob(f"summary-{sid}-*.md"))
    assert read_doc(summary, SummaryMeta)[0].material_range[0].start == 2
    # 資料全体のセットは上書きしない。セッション専用のセットは画面の一覧に出さない
    assert read_doc(d / hotwords_name(base), ContextSetMeta)[1].strip() == "全体の語"
    sets = client.get(f"/api/projects/{pid}/context-sets").json()
    assert [s["id"] for s in sets] == [base]
    # 要約の作り直しも、セッション専用のセットのコンテキストを使う
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert client.post(f"/api/projects/{pid}/sessions/{sid}/summaries").status_code == 202
        receive_until(ws, lambda m: m["type"] == "title" and not m["provisional"])
    assert "範囲のコンテキスト" in asked["summary"][-1]


@pytest.mark.parametrize(
    "scope",
    [
        {"rebuild": True, "ranges": [{"material": 1, "from": 1, "to": 9}]},  # ほぼ全体
        {"rebuild": False, "ranges": []},
        "形の合わない答え",
    ],
)
def test_whole_or_failed_judgement_keeps_the_context_set(client, setup, fake_ollama, scope):
    pid, d, base = setup
    asked = replies(fake_ollama, scope)
    final = _use_final(client)
    sid, _ = record(client, pid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.context_set, meta.base_context_set, meta.material_range) == (base, None, None)
    assert len(asked["scope"]) == 1
    assert asked["terms"] == [] and asked["context"] == []
    assert final.hotwords == ["全体の語"]
    assert [s["id"] for s in client.get(f"/api/projects/{pid}/context-sets").json()] == [base]


def test_small_material_is_not_judged(client, tmp_path, fake_ollama):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    pid = client.post("/api/projects", json={"path": str(root / "meetings")}).json()["id"]
    fake_ollama.reply = ["語"]
    create_and_wait(client, pid, [str(_material(root, chapters=2))])
    asked = replies(fake_ollama, {"rebuild": True, "ranges": []})
    record(client, pid)
    assert asked["scope"] == []


def test_upload_judges_after_the_final_transcript_and_rebuilds_only_the_context(
    client, setup, fake_ollama, tmp_path
):
    pid, d, base = setup
    asked = replies(fake_ollama, {"rebuild": True, "ranges": [{"material": 1, "from": 7, "to": 7}]})
    final = _use_final(client)
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    sid = upload(client, pid, wav).json()["id"]
    wait_done(client)

    meta, transcript = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    # 浄書（偽物は作れない）の後に Whisper で文字起こしし、その文字起こしで判断する
    assert final.hotwords == ["全体の語"]
    assert transcript.strip() in asked["scope"][0]
    assert [(r.start, r.end) for r in meta.material_range] == [(6, 8)]
    # 用語リストは作り直さず（元のものを写す）、コンテキストだけを作り直す
    assert asked["terms"] == []
    assert len(asked["context"]) == 1 and "第7章の本文" in asked["context"][0]
    assert read_doc(d / hotwords_name(meta.context_set), ContextSetMeta)[1].strip() == "全体の語"
    assert "範囲のコンテキスト" in asked["summary"][-1]
