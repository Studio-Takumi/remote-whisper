"""アプリ全体で共有する状態"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request

from remote_whisper.gpu_queue import GpuQueue
from remote_whisper.hub import Hub
from remote_whisper.projects import ProjectStore
from remote_whisper.settings import SettingsStore


@dataclass
class AppContext:
    home: Path
    settings: SettingsStore
    projects: ProjectStore
    hub: Hub = field(default_factory=Hub)
    # True なら Whisper と Ollama の代わりにダミーを使う（--mock）
    mock: bool = False
    # 録音を受け持つもの。モックでは MockRecorder。本物は録音マネージャ（#20）ができるまでない
    recorder: Any = None
    # 録音中のセッションの数
    recordings: int = 0
    # Whisper の子プロセス（WhisperWorker）。モックではない
    whisper: Any = None
    # Ollama とのやりとり（OllamaClient）。モックではない
    ollama: Any = None
    # 最終の要約を作るもの（FinalSummarizer。モックでは MockFinalSummarizer）。作り直しに使う
    summarizer: Any = None
    # 録音後に作る最終の文字起こし（FinalTranscriber。#121）。モックではない
    final_transcriber: Any = None
    # 参考資料セットの作成（ContextSetService）
    context_sets: Any = None
    # GPU を使う処理（Whisper・Ollama）を順番に実行するキュー。
    # 待っている数は status の queue、ジョブの一覧は jobs で送る
    gpu: GpuQueue = field(init=False)

    def __post_init__(self) -> None:
        # partial のたびに送りすぎないよう、0.5 秒の間の変化はまとめて送る
        self.gpu = GpuQueue(
            lambda n: self.hub.set_status(queue=n, jobs=self.gpu.snapshot()),
            min_interval=0.5,
        )
        self.hub.jobs_source = self.gpu.snapshot

    @property
    def is_recording(self) -> bool:
        return self.recordings > 0

    def ensure_not_recording(self) -> None:
        """録音中は設定や選択を変えられない（spec 5.3・8）"""
        if self.is_recording:
            raise HTTPException(status_code=409, detail="録音中は変更できません")


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx
