"""プロジェクトのディレクトリに置くファイルの名前と、フロントマターの読み書き

spec/files.md 5.1・5.5
"""

import re
from pathlib import Path
from typing import Any, Literal, TypeVar

import yaml
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from remote_whisper.materials.material_toc import MaterialRange, MaterialToc
from remote_whisper.storage.fsutil import atomic_write_text
from remote_whisper.transcript.corrections import Correction

# --- ファイル名 ---

ID = r"\d{8}-\d{6}"
HOTWORDS_RE = re.compile(rf"hotwords-({ID})\.md")
CONTEXT_RE = re.compile(rf"context-({ID})\.md")
TRANSCRIPT_RE = re.compile(rf"transcript-({ID})\.md")
SUMMARY_RE = re.compile(rf"summary-({ID})-({ID})\.md")
FINAL_TRANSCRIPT_RE = re.compile(rf"transcript-final-({ID})-({ID})\.md")
# ほかの音源の録音（#241）は recording-<ID>-<音源 ID>.<拡張子>。group(1) はどちらもセッション ID
RECORDING_RE = re.compile(rf"recording-({ID})(?:-([2-9]|1[0-6]))?\.(mp3|m4a)")


def hotwords_name(set_id: str) -> str:
    return f"hotwords-{set_id}.md"


def context_name(set_id: str) -> str:
    return f"context-{set_id}.md"


def transcript_name(sid: str) -> str:
    return f"transcript-{sid}.md"


def summary_name(sid: str, gid: str) -> str:
    return f"summary-{sid}-{gid}.md"


def final_transcript_name(sid: str, gid: str) -> str:
    """録音後に作り直した最終の文字起こし（#121）。作り直すたびに生成 ID の世代が増える"""
    return f"transcript-final-{sid}-{gid}.md"


def recording_name(sid: str, ext: str = "mp3", source: int | None = None) -> str:
    """録音ファイル。ほかの音源（音源 ID が 2 から。#241）は音源 ID を付ける
    （主の音源は今までと同じ）"""
    if source is not None and source > 1:
        return f"recording-{sid}-{source}.{ext}"
    return f"recording-{sid}.{ext}"


# --- フロントマター ---


class _Loader(yaml.SafeLoader):
    """日時を datetime に変えずに文字列のまま読む（書いたときの +09:00 などをそのまま保つため）"""


_Loader.yaml_implicit_resolvers = {
    key: [(tag, regexp) for tag, regexp in resolvers if tag != "tag:yaml.org,2002:timestamp"]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


class FrontmatterError(ValueError):
    pass


def parse(text: str) -> tuple[dict[str, Any], str]:
    """`---` で囲んだ YAML と本文に分ける"""
    text = text.removeprefix("﻿")
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        raise FrontmatterError("フロントマターがありません")
    for i, line in enumerate(lines[1:], start=1):
        if line.rstrip("\r\n") == "---":
            try:
                meta = yaml.load("".join(lines[1:i]), Loader=_Loader) or {}
            except yaml.YAMLError as e:
                # YAMLError は ValueError ではないので、呼ぶ側でまとめて扱えるように包む
                raise FrontmatterError(f"フロントマターの YAML を読めません: {e}") from e
            if not isinstance(meta, dict):
                raise FrontmatterError("フロントマターが辞書ではありません")
            return meta, "".join(lines[i + 1 :])
    raise FrontmatterError("フロントマターが閉じていません")


def dump(meta: dict[str, Any], body: str) -> str:
    head = yaml.safe_dump(meta, allow_unicode=True, sort_keys=False, default_flow_style=False)
    return f"---\n{head}---\n{body}"


# --- 型 ---


class _Meta(BaseModel):
    # 知らないキーは無視する（手で書き足したものがあっても読めるように）
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    def to_json(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True)


class MaterialRef(_Meta):
    path: str
    sha1: str


class ContextSetMeta(_Meta):
    """用語リスト `hotwords-<ID>.md` とコンテキスト `context-<ID>.md` のフロントマター"""

    id: str
    project: str | None = None
    created_at: str
    model: str
    think: bool
    materials: list[MaterialRef] = Field(default_factory=list)
    # セッション専用のセット（#182。録音のあとに範囲を判断して作り直したもの）。
    # そのセッションの ID と、使った範囲。資料全体のセットにはない
    session: str | None = None
    material_range: list[MaterialRange] | None = None


class ContextMeta(ContextSetMeta):
    """コンテキスト `context-<ID>.md` のフロントマター。用語リストの分に、資料の目次が加わる（#181）

    toc が None のものは、目次を取り出す前のセット（以前に作ったもの）。
    """

    toc: list[MaterialToc] | None = None


class WhisperUsed(_Meta):
    model: str
    beam_size: int
    silence_ms: int
    # 話しているとみなす音量（#82）。以前のファイルにはない。speech_dbfs は manual のときだけ
    speech_threshold: Literal["auto", "manual"] | None = None
    speech_dbfs: float | None = None


class SourceInfo(_Meta):
    """音源（#241。spec/files.md 5.5・spec/flows.md 6.16）。1 つ目が主の音源"""

    id: int
    name: str | None = None
    # main（主の音源）/ join（録音中に参加した端末）/ upload（アップロードしたファイル）
    kind: Literal["main", "join", "upload"] = "upload"
    recording: str | None = None
    # 主の音源の時刻 = 音源の時刻 × (1 − driftPpm × 10⁻⁶) + offsetSec
    offset_sec: float = 0.0
    drift_ppm: float = 0.0
    joined_sec: float | None = None
    left_sec: float | None = None


# 音源が 2 つ以上のときだけ書く項目（ないときは書かない。今までのファイルと同じにするため）
_SOURCE_KEYS = ("sources", "lineSources")


def _drop_empty_sources(data: dict[str, Any]) -> dict[str, Any]:
    for key in _SOURCE_KEYS:
        if data.get(key) is None:
            data.pop(key, None)
    return data


class TranscriptMeta(_Meta):
    """文字起こし `transcript-<ID>.md` のフロントマター"""

    id: str
    project: str | None = None
    # URL に出す ID（#177）。別のプロジェクトへ移したとき（#172）に残す。project.json を
    # 作り直しても（5.4 節）、移す前の URL のままにするため。ないものはパスと ID から決める
    uuid: str | None = None
    title: str | None = None
    status: Literal["recording", "done", "interrupted"]
    started_at: str
    ended_at: str | None = None
    duration_sec: int | None = None
    language: str = "ja"
    whisper: WhisperUsed | None = None
    context_set: str | None = None
    use_hotwords: bool = False
    recording: str | None = None
    # 最終の要約を作れなかった（Ollama につながらないなど）。作れたら false に戻す。
    # spec/flows.md 6.7
    summary_failed: bool = False
    # 録音したサーバーのバージョン（コミットハッシュ）。以前のファイルにはない
    app_version: str | None = None
    # 録音中に文字起こしから拾って、用語リストに足した語と、画面で消された語（#103）
    picked_terms: list[str] = Field(default_factory=list)
    rejected_terms: list[str] = Field(default_factory=list)
    # 画面で手で足した語（#175）。拾った語とは分けて持ち、Whisper に渡す用語リストの先頭に入れる
    manual_terms: list[str] = Field(default_factory=list)
    # 文字起こしの置き換え（#176。「間違った文字列 → 正しい語」）
    corrections: list[Correction] = Field(default_factory=list)
    # 音声ファイルをアップロードして作ったセッション（#180）は upload。録音したものにはない
    source: Literal["upload"] | None = None
    # アップロードした元のファイル名と、アップロードした日時（保存期間はここから数える）
    original_name: str | None = None
    uploaded_at: str | None = None
    # 録音のあとに今回扱った範囲を判断して、参考資料を作り直したとき（#182）。
    # context_set はそのセッション専用のセットになり、base_context_set に元のセットを残す
    material_range: list[MaterialRange] | None = None
    base_context_set: str | None = None
    # 音源（#241）。音源が 2 つ以上のセッションだけが持つ。lineSources は本文の行ごとの音源 ID
    sources: list[SourceInfo] | None = None
    line_sources: list[int] | None = None

    def to_json(self) -> dict[str, Any]:
        return _drop_empty_sources(super().to_json())


class SummaryMeta(_Meta):
    """最終の要約 `summary-<ID>-<生成 ID>.md` のフロントマター"""

    id: str
    generation_id: str
    project: str | None = None
    title: str | None = None
    started_at: str
    ended_at: str | None = None
    # 要約詳細（部分ごとの要約。一度に収まるときはその要約）のモデル
    model: str
    # 全体概要のモデル（#178）。表示する版は model との組で選ぶ。以前のものにはない（model と同じ）
    overview_model: str | None = None
    think: bool
    transcript: str | None = None
    context_set: str | None = None
    use_context: bool = False
    generated_at: str
    # 要約を作ったサーバーのバージョン（コミットハッシュ）。以前のファイルにはない
    app_version: str | None = None
    # 使った要約度（1〜5。#100）。概要と、部分ごとの要約（詳細）。以前のファイルにはない
    overview_density: int | None = None
    detail_density: int | None = None
    # 参考資料を範囲で作り直したとき（#182）、使った範囲（文字起こしと同じ）
    material_range: list[MaterialRange] | None = None


class FinalTranscriptMeta(_Meta):
    """最終の文字起こし `transcript-final-<ID>-<生成 ID>.md` のフロントマター（#121）"""

    id: str
    generation_id: str
    project: str | None = None
    model: str
    generated_at: str
    # 起こし直した録音のファイル
    recording: str | None = None
    # 単語の時刻を合わせたモデル（wav2vec2）
    align_model: str | None = None
    # 話者分け。done は分けた、off は設定で切っていた、unavailable はモデルを使えなかった
    diarization: Literal["done", "off", "unavailable"] = "off"
    speakers: int = 0
    app_version: str | None = None
    # 使った音源 ID と、行ごとの音源 ID（#241。音源が 2 つ以上のときだけ）
    sources: list[int] | None = None
    line_sources: list[int] | None = None

    def to_json(self) -> dict[str, Any]:
        return _drop_empty_sources(super().to_json())


M = TypeVar("M", bound=_Meta)


def read_doc(path: Path, model: type[M]) -> tuple[M, str]:
    """フロントマターを型に当てはめて読む。壊れていれば ValueError（pydantic の検証エラーを含む）"""
    meta, body = parse(path.read_text(encoding="utf-8"))
    return model.model_validate(meta), body


def write_doc(path: Path, meta: _Meta, body: str) -> None:
    atomic_write_text(path, dump(meta.to_json(), body))
