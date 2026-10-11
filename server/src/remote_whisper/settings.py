"""データのルートと全体設定（setting.json）。spec 5.1・5.3"""

import json
import os
import threading
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

from remote_whisper.fsutil import atomic_write_json

SETTINGS_VERSION = 1


class SettingsError(Exception):
    """setting.json が壊れていて読み込めない"""


def default_home() -> Path:
    """データのルート。既定は ~/.remote-whisper、環境変数 REMOTE_WHISPER_HOME で変えられる"""
    env = os.environ.get("REMOTE_WHISPER_HOME")
    return Path(env) if env else Path.home() / ".remote-whisper"


class _Model(BaseModel):
    # setting.json のキーは camelCase。知らないキーは受け付けない（打ち間違いに気づけるように）
    # 文字列は空にできない（モデル名やホストが空だと動かないため）
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", str_min_length=1
    )


class WhisperSettings(_Model):
    model: str = "large-v3-turbo"
    compute_type: str = "float16"
    beam_size: int = Field(5, ge=1)
    partial_interval_sec: float = Field(1.0, gt=0)
    silence_ms: int = Field(600, gt=0)
    max_segment_sec: float = Field(25, gt=0)
    unload_after_min: float = Field(10, ge=0)
    # 話しているかの判定。auto は音の大きさをそろえてから Silero VAD で判定する（#88）。
    # manual は speech_dbfs より大きい音を話し声とみなす（#82）
    speech_threshold: Literal["auto", "manual"] = "auto"
    speech_dbfs: float = Field(-40, ge=-70, le=-10)


class OllamaSettings(_Model):
    host: str = "http://localhost:11434"
    live_summary_model: str = "qwen3.5:4b"
    final_summary_model: str = "qwen3.5:4b"
    context_model: str = "qwen3.5:4b"
    live_summary_interval_min: float = Field(3, gt=0)
    keep_alive_min: float = Field(10, ge=0)
    # 要約度（要約の細かさ）。1（ごく短く要点だけ）〜5（できるだけ省かず細かく）。3 が既定（#100）
    # 途中の要約（区間ごと）・最終の要約の概要・最終の要約の詳細（部分ごと）のそれぞれ
    live_summary_density: int = Field(3, ge=1, le=5)
    overview_density: int = Field(3, ge=1, le=5)
    detail_density: int = Field(3, ge=1, le=5)


class RecordingSettings(_Model):
    max_concurrent: int = Field(1, ge=1)
    # ブラウザのマイクの処理（getUserMedia の制約）。
    # サーバーは使わず、録音を始めるときにブラウザが読む
    noise_suppression: bool = True
    auto_gain_control: bool = True


class RetentionDays(_Model):
    # 0 は無期限
    recording: int = Field(10, ge=0)
    transcript: int = Field(30, ge=0)
    summary: int = Field(30, ge=0)
    context_set: int = Field(0, ge=0)


class MaterialsSettings(_Model):
    roots: list[str] = Field(default_factory=lambda: [str(Path.home())])
    extensions: list[str] = Field(default_factory=lambda: [".md", ".txt", ".pdf", ".html"])


class DisplaySettings(_Model):
    # 左メニューのセッションに、録音日時と長さを出すか
    session_meta: bool = False


class Settings(_Model):
    version: int = SETTINGS_VERSION
    whisper: WhisperSettings = Field(default_factory=WhisperSettings)
    ollama: OllamaSettings = Field(default_factory=OllamaSettings)
    recording: RecordingSettings = Field(default_factory=RecordingSettings)
    retention_days: RetentionDays = Field(default_factory=RetentionDays)
    materials: MaterialsSettings = Field(default_factory=MaterialsSettings)
    display: DisplaySettings = Field(default_factory=DisplaySettings)

    def to_json(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True)


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """patch のキーだけを base に上書きした新しい dict を返す。dict どうしは再帰的にマージする"""
    merged = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


class SettingsStore:
    """setting.json の読み書き。ファイルがなければ既定値で作る"""

    def __init__(self, home: Path):
        self.home = home
        self.path = home / "setting.json"
        self._lock = threading.Lock()
        self._settings = self._load()

    def _load(self) -> Settings:
        if self.path.is_file():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                settings = Settings.model_validate(data)
            # ValueError は JSON の構文エラーと UTF-8 として読めないもの
            except (OSError, ValueError, ValidationError) as e:
                raise SettingsError(f"{self.path} を読み込めません: {e}") from e
            # 古い version からの移行が必要になったら、ここで変換する
            if settings.version > SETTINGS_VERSION:
                raise SettingsError(
                    f"{self.path} の version {settings.version} はこのサーバーより新しいため"
                    f"読み込めません（対応しているのは {SETTINGS_VERSION} まで）"
                )
            # 足りないキーは既定値で埋まるので、書き戻して揃えておく
            if settings.to_json() != data:
                atomic_write_json(self.path, settings.to_json())
            return settings
        settings = Settings()
        atomic_write_json(self.path, settings.to_json())
        return settings

    def get(self) -> Settings:
        return self._settings

    def update(self, patch: dict[str, Any]) -> Settings:
        """部分更新。検証に通らなければ pydantic.ValidationError を投げ、ファイルは変えない"""
        with self._lock:
            merged = deep_merge(self._settings.to_json(), patch)
            merged["version"] = SETTINGS_VERSION
            settings = Settings.model_validate(merged)
            atomic_write_json(self.path, settings.to_json())
            self._settings = settings
            return settings
