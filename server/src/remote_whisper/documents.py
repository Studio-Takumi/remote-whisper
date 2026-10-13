"""プロジェクトのディレクトリに置くファイルの名前と、フロントマターの読み書き。spec 5.1・5.5"""

import re
from pathlib import Path
from typing import Any, Literal, TypeVar

import yaml
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from remote_whisper.fsutil import atomic_write_text

# --- ファイル名 ---

ID = r"\d{8}-\d{6}"
HOTWORDS_RE = re.compile(rf"hotwords-({ID})\.md")
CONTEXT_RE = re.compile(rf"context-({ID})\.md")
TRANSCRIPT_RE = re.compile(rf"transcript-({ID})\.md")
SUMMARY_RE = re.compile(rf"summary-({ID})-({ID})\.md")
FINAL_TRANSCRIPT_RE = re.compile(rf"transcript-final-({ID})-({ID})\.md")
RECORDING_RE = re.compile(rf"recording-({ID})\.(mp3|m4a)")


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


def recording_name(sid: str, ext: str = "mp3") -> str:
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


class WhisperUsed(_Meta):
    model: str
    beam_size: int
    silence_ms: int
    # 話しているとみなす音量（#82）。以前のファイルにはない。speech_dbfs は manual のときだけ
    speech_threshold: Literal["auto", "manual"] | None = None
    speech_dbfs: float | None = None


class TranscriptMeta(_Meta):
    """文字起こし `transcript-<ID>.md` のフロントマター"""

    id: str
    project: str | None = None
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
    # 最終の要約を作れなかった（Ollama につながらないなど）。作れたら false に戻す（spec 6.7）
    summary_failed: bool = False
    # 録音したサーバーのバージョン（コミットハッシュ）。以前のファイルにはない
    app_version: str | None = None
    # 録音中に文字起こしから拾って、用語リストに足した語と、画面で消された語（#103）
    picked_terms: list[str] = Field(default_factory=list)
    rejected_terms: list[str] = Field(default_factory=list)


class SummaryMeta(_Meta):
    """最終の要約 `summary-<ID>-<生成 ID>.md` のフロントマター"""

    id: str
    generation_id: str
    project: str | None = None
    title: str | None = None
    started_at: str
    ended_at: str | None = None
    model: str
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


M = TypeVar("M", bound=_Meta)


def read_doc(path: Path, model: type[M]) -> tuple[M, str]:
    """フロントマターを型に当てはめて読む。壊れていれば ValueError（pydantic の検証エラーを含む）"""
    meta, body = parse(path.read_text(encoding="utf-8"))
    return model.model_validate(meta), body


def write_doc(path: Path, meta: _Meta, body: str) -> None:
    atomic_write_text(path, dump(meta.to_json(), body))
