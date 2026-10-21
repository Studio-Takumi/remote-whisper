"""データのルートと全体設定（setting.json）。spec/files.md 5.1・5.3"""

import json
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from pydantic.alias_generators import to_camel

from remote_whisper.fsutil import atomic_write_json

SETTINGS_VERSION = 1


class SettingsError(Exception):
    """setting.json が壊れていて読み込めない"""


class SettingsLockedError(Exception):
    """録音中は変えられない項目を変えようとした（spec/files.md 5.3）。fields は変えようとした項目"""

    def __init__(self, fields: list[str]):
        super().__init__(", ".join(fields))
        self.fields = fields


# 録音中は変えられない項目（setting.json のキー。spec/files.md 5.3）。
# 文字起こしのモデルは変えると読み込み直しになり、その間の文字起こしが止まる。
# 区切りの設定は録音を始めたときに決まるので、今の録音には効かない。
# マイクの処理は、ブラウザが録音を始めるときにマイクに設定する
RECORDING_LOCKED: tuple[tuple[str, str], ...] = (
    ("whisper", "model"),
    ("whisper", "computeType"),
    ("whisper", "silenceMs"),
    ("whisper", "maxSegmentSec"),
    ("whisper", "speechThreshold"),
    ("whisper", "speechDbfs"),
    ("recording", "noiseSuppression"),
    ("recording", "autoGainControl"),
    ("recording", "echoCancellation"),
)


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
    # 録音を終えたら、保存した録音全体から最終の文字起こしを作る
    # （#121。WhisperX が入っているときだけ）
    final_transcript: bool = True
    # 最終の文字起こしで話者を分ける（pyannote。HuggingFace のトークンと利用条件への同意が要る）
    diarize: bool = True


# 処理ごとのおすすめのモデル（#178）。軽い処理は小さいモデルにする。入っていなければ、
# 動かすときに入っているモデルで代わりに動かす（OllamaClient.resolve）。
# 録音中の 3 つ（要約・タイトル・用語）は同じモデルにそろえる。録音中は Ollama のモデルを 1 つしか
# 載せないので、別々だと区切りごとに読み込み直しになる。0.8b は用語の抽出で文をそのまま返すなど
# 品質が足りなかったので、録音中は 2b にした
RECOMMENDED_MODELS = {
    "materialTerms": "qwen3.5:2b",
    "context": "qwen3.5:4b",
    # 範囲の判断（#182）は、2b だと答えが回ごとにばらつき、温度 0 では目次を全部写すだけだった。
    # 4b は毎回同じ答えになった。浄書の後は VRAM が空いていて、続くコンテキスト・要約も 4b
    "scope": "qwen3.5:4b",
    "transcriptTerms": "qwen3.5:2b",
    "liveSummary": "qwen3.5:2b",
    "liveTitle": "qwen3.5:2b",
    "overview": "qwen3.5:4b",
    "detail": "qwen3.5:4b",
    "finalTitle": "qwen3.5:0.8b",
}


class OllamaModels(_Model):
    """Ollama を使う処理ごとのモデル（#178。spec/files.md 5.3）"""

    # 参考資料: 用語リスト（資料抽出）・コンテキスト・範囲の判断（#182）
    material_terms: str = RECOMMENDED_MODELS["materialTerms"]
    context: str = RECOMMENDED_MODELS["context"]
    scope: str = RECOMMENDED_MODELS["scope"]
    # リアルタイム文字起こし: 用語リスト（文字起こし抽出。#103）
    transcript_terms: str = RECOMMENDED_MODELS["transcriptTerms"]
    # リアルタイム要約: 要約・タイトル
    live_summary: str = RECOMMENDED_MODELS["liveSummary"]
    live_title: str = RECOMMENDED_MODELS["liveTitle"]
    # 最終要約: 全体概要・要約詳細・タイトル。表示する版は、全体概要と要約詳細の組で選ぶ
    overview: str = RECOMMENDED_MODELS["overview"]
    detail: str = RECOMMENDED_MODELS["detail"]
    final_title: str = RECOMMENDED_MODELS["finalTitle"]

    def final(self) -> "FinalModels":
        return FinalModels(self.overview, self.detail, self.final_title)


@dataclass(frozen=True)
class FinalModels:
    """最終の要約で使うモデル。作り直しは、頼んだ時点のものを渡す"""

    overview: str
    detail: str
    title: str


# #178 より前のキー（1 つのモデルを複数の処理で使っていた）→ 移す先の処理。
# 読み込んだときに移す（migrate_models）。古いキーは受け付けるが、書き出さない
LEGACY_MODEL_KEYS = {
    "liveSummaryModel": ("liveSummary",),
    "finalSummaryModel": ("overview", "detail"),
    "contextModel": ("context", "materialTerms"),
}
# 新しい軽い処理 → 移行元のキー。おすすめのモデルが入っていなければ、移行元と同じモデルにする
LEGACY_LIGHT_SOURCES = {
    "scope": "contextModel",
    "transcriptTerms": "liveSummaryModel",
    "liveTitle": "liveSummaryModel",
    "finalTitle": "finalSummaryModel",
}


def migrate_models(ollama: dict[str, Any], installed: set[str] | None) -> bool:
    """古いキーしかない ollama の設定に、処理ごとのモデル（models）を足す。足したら True

    installed は Ollama に入っているモデル（分からなければ None。そのときは移行元と同じモデル）
    """
    if "models" in ollama or not any(key in ollama for key in LEGACY_MODEL_KEYS):
        return False
    models: dict[str, str] = {}
    for key, targets in LEGACY_MODEL_KEYS.items():
        value = ollama.get(key)
        if isinstance(value, str) and value:
            for target in targets:
                models[target] = value
    for target, source in LEGACY_LIGHT_SOURCES.items():
        recommended = RECOMMENDED_MODELS[target]
        value = ollama.get(source)
        if installed is not None and has_model(installed, recommended):
            models[target] = recommended
        elif isinstance(value, str) and value:
            models[target] = value
    ollama["models"] = models
    return True


def has_model(installed: set[str], model: str) -> bool:
    """Ollama に入っているか。タグを省いた名前は :latest とみなす（Ollama と同じ）"""
    return model in installed or (":" not in model and f"{model}:latest" in installed)


def installed_ollama_models(host: str) -> set[str] | None:
    """Ollama に入っているモデル（設定の移行に使う）。つながらなければ None"""
    try:
        res = httpx.get(f"{host.rstrip('/')}/api/tags", timeout=3)
        res.raise_for_status()
        return {m["name"] for m in res.json().get("models", []) if m.get("name")}
    except (httpx.HTTPError, httpx.InvalidURL, ValueError, KeyError, TypeError):
        return None


class OllamaSettings(_Model):
    host: str = "http://localhost:11434"
    models: OllamaModels = Field(default_factory=OllamaModels)
    # #178 より前のキー。読み込めるようにだけしておき、書き出さない（移すのは migrate_models）
    live_summary_model: str | None = Field(None, exclude=True)
    final_summary_model: str | None = Field(None, exclude=True)
    context_model: str | None = Field(None, exclude=True)
    # 途中の要約を作っている間は GPU が要約に使われ、文字起こしが待たされる。
    # 間隔を広めにする（#119）
    live_summary_interval_min: float = Field(5, gt=0)
    keep_alive_min: float = Field(10, ge=0)
    # 要約度（要約の細かさ）。1（ごく短く要点だけ）〜5（できるだけ省かず細かく）。3 が既定（#100）
    # 途中の要約（区間ごと）・最終の要約の概要・最終の要約の詳細（部分ごと）のそれぞれ
    live_summary_density: int = Field(3, ge=1, le=5)
    overview_density: int = Field(3, ge=1, le=5)
    detail_density: int = Field(3, ge=1, le=5)
    # 録音中に文字起こしから用語を拾うか（#103）。録音中の GPU の負荷が上がるので
    # 既定はオフ（#116）。オンのときも、プロジェクトの selection.pick_terms がオフなら拾わない
    pick_terms: bool = False


class RecordingSettings(_Model):
    max_concurrent: int = Field(1, ge=1)
    # ブラウザとの接続が切れてから、つながり直すのを待つ時間（分）。過ぎたら interrupted にする
    # （interrupted になっても、続きから録音できる。spec/flows.md 6.7、#101）
    resume_timeout_min: float = Field(10, gt=0)
    # 普通に録音を終えた（done）あと、同じセッションの続きを録音できる時間（分。#174）。
    # この間は録音を WAV のまま残し、過ぎてから mp3 に変換する。0 なら続けられない（すぐ変換する）
    continue_window_min: float = Field(10, ge=0)
    # ブラウザのマイクの処理（getUserMedia の制約）。
    # サーバーは使わず、録音を始めるときにブラウザが読む
    noise_suppression: bool = True
    auto_gain_control: bool = True
    # 切り替えると直ることがあるように（#120）。既定はオンのまま
    echo_cancellation: bool = True
    # アップロードできる音声ファイルの大きさの上限（MB。#180）
    upload_max_mb: int = Field(2048, ge=1)


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
    # 文字起こしのタブに、録音中に拾った用語（PickedTerms）を出すか。
    # 拾うか（ollama.pickTerms）とは別で、オフでも拾った語は hotwords に使う
    show_picked_terms: bool = False
    # 最終の文字起こしに、話者（「話者 1」など）を出すか。話者分けの処理と保存するファイルは変えない
    show_speakers: bool = False


# 中間サーバー（Worker）の URL の既定。今は staging。本番ができたら（#167）本番のドメインにする
DEFAULT_RELAY_URL = "https://rw-dev.studio-takumi.dev"


def is_valid_cloudflared_path(value: str) -> bool:
    """cloudflared の場所として受け付けるか。空、または絶対パスで UNC でなく、
    ファイル名が cloudflared / cloudflared.exe（大文字小文字は無視）のもの。存在は実行時に見る

    設定は認証なしの API から変えられるため、任意の実行ファイルや他のマシンのパスは通さない
    """
    if value == "":
        return True
    if "\0" in value or value.startswith(("\\\\", "//")):
        return False
    if not (PureWindowsPath(value).is_absolute() or PurePosixPath(value).is_absolute()):
        return False
    parts = value.replace("\\", "/").split("/")
    if ".." in parts:
        return False
    return parts[-1].lower() in ("cloudflared", "cloudflared.exe")


class CloudSettings(_Model):
    """クラウド版（spec/cloud.md 10 章）。録音中も変えられる"""

    # 中間サーバー（Worker）の URL。ホストの登録（#158）で使う。開発ではローカルの
    # wrangler dev（http://localhost:8787）にもできる。https か、この PC の中への http だけ
    relay_url: str = DEFAULT_RELAY_URL
    # cloudflared の実行ファイル（#159）。空なら同梱の（#168）、なければ PATH の `cloudflared`
    cloudflared_path: str = Field(default="", min_length=0)

    @field_validator("cloudflared_path")
    @classmethod
    def _cloudflared_path(cls, value: str) -> str:
        if not is_valid_cloudflared_path(value):
            raise ValueError(
                "空か、cloudflared（cloudflared.exe）への絶対パスにしてください"
                "（ネットワークのパス \\\\ や // は使えません）"
            )
        return value

    @field_validator("relay_url")
    @classmethod
    def _relay_url(cls, value: str) -> str:
        try:
            url = httpx.URL(value)
        except httpx.InvalidURL as e:
            raise ValueError(f"URL として読めません: {e}") from e
        local = url.host in ("localhost", "127.0.0.1", "::1")
        if not (url.scheme == "https" or (url.scheme == "http" and local)) or not url.host:
            raise ValueError("https:// の URL（ローカルの開発なら http://localhost）にしてください")
        if url.userinfo:
            # https://本物のドメイン@別のホスト のような、見た目と接続先が違う URL を通さない
            # （パスワードが通知やログに出ることも防ぐ）
            raise ValueError("ユーザー名やパスワードを含まない URL にしてください")
        if url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError("パスのない URL（https://example.com）にしてください")
        # 書き方の違い（大文字・:443・末尾の / ? #）をそろえる
        host = f"[{url.host}]" if ":" in url.host else url.host
        default_port = {"https": 443, "http": 80}[url.scheme]
        port = f":{url.port}" if url.port not in (None, default_port) else ""
        return f"{url.scheme}://{host}{port}"


class Settings(_Model):
    version: int = SETTINGS_VERSION
    whisper: WhisperSettings = Field(default_factory=WhisperSettings)
    ollama: OllamaSettings = Field(default_factory=OllamaSettings)
    recording: RecordingSettings = Field(default_factory=RecordingSettings)
    retention_days: RetentionDays = Field(default_factory=RetentionDays)
    materials: MaterialsSettings = Field(default_factory=MaterialsSettings)
    display: DisplaySettings = Field(default_factory=DisplaySettings)
    cloud: CloudSettings = Field(default_factory=CloudSettings)
    # サイドバーのプロジェクトの並び順（プロジェクト ID。#173）。
    # ここにないプロジェクトは先頭に出す。消えたプロジェクトの ID が残っていても読むときに無視する。
    # 録音中も変えられる（#133）
    project_order: list[str] = Field(default_factory=list)

    @field_validator("project_order")
    @classmethod
    def _unique_project_order(cls, value: list[str]) -> list[str]:
        # 同じ ID が重なっていたら最初のものだけ残す
        return list(dict.fromkeys(value))

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

    def __init__(
        self,
        home: Path,
        installed_models: Callable[[str], set[str] | None] | None = None,
    ):
        self.home = home
        self.path = home / "setting.json"
        self._lock = threading.Lock()
        # 古い設定を移すときに、Ollama に入っているモデルを調べる（テストでは差し替える）
        self._installed_models = installed_models or installed_ollama_models
        self._settings = self._load()

    def _migrate(self, data: Any) -> None:
        """古い形の設定を、今の形に直す（検証の前に）"""
        ollama = data.get("ollama") if isinstance(data, dict) else None
        if isinstance(ollama, dict) and "models" not in ollama:
            if any(key in ollama for key in LEGACY_MODEL_KEYS):
                host = ollama.get("host") or OllamaSettings().host
                migrate_models(ollama, self._installed_models(str(host)))

    def _load(self) -> Settings:
        if self.path.is_file():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                original = json.loads(json.dumps(data))
                self._migrate(data)
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
            # 足りないキーは既定値で埋まり、古いキーは移して消えるので、書き戻して揃えておく
            if settings.to_json() != original:
                atomic_write_json(self.path, settings.to_json())
            return settings
        settings = Settings()
        atomic_write_json(self.path, settings.to_json())
        return settings

    def get(self) -> Settings:
        return self._settings

    def update(self, patch: dict[str, Any], locked: tuple[tuple[str, str], ...] = ()) -> Settings:
        """部分更新。検証に通らなければ pydantic.ValidationError を投げ、ファイルは変えない

        locked の項目（録音中は RECORDING_LOCKED）の値が変わるなら SettingsLockedError を投げる。
        同じ値を送るのはかまわない（画面は設定をまるごと送るため）
        """
        with self._lock:
            before = self._settings.to_json()
            merged = deep_merge(before, patch)
            merged["version"] = SETTINGS_VERSION
            settings = Settings.model_validate(merged)
            after = settings.to_json()
            changed = [
                f"{section}.{key}"
                for section, key in locked
                if before[section][key] != after[section][key]
            ]
            if changed:
                raise SettingsLockedError(changed)
            atomic_write_json(self.path, settings.to_json())
            self._settings = settings
            return settings
