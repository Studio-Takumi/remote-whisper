"""タスクトレイ（Windows）・メニューバー（Mac）に出す中身（#135）。spec 8

点の色・マウスを乗せたときの文・メニューの項目を、サーバーの状態（status）から決める。
OS ごとに違う部分（アイコンの出し方・確認のダイアログ・フォルダを開く）は tray.py に置く。
ここは OS にも pystray にもよらない（テストしやすいように）
"""

from dataclasses import dataclass
from typing import Literal

from remote_whisper.hub import ServerStatus

Color = Literal["gray", "blue", "red", "orange"]

# 点の色（RGB）。灰: 待機中 / 青: GPU が処理中 / 赤: 録音中 / 橙: Whisper か Ollama が使えない
DOT_COLORS: dict[Color, tuple[int, int, int]] = {
    "gray": (156, 163, 175),
    "blue": (37, 99, 235),
    "red": (220, 38, 38),
    "orange": (234, 88, 12),
}

# GPU キューのジョブの種類（gpu_queue.JobKind）の、画面と同じ呼び方
JOB_NAMES = {
    "transcribe": "文字起こし",
    "whisperLoad": "文字起こしのモデルの読み込み",
    "liveSummary": "途中の要約",
    "finalSummary": "最終の要約",
    "contextSet": "参考資料セットの作成",
    "terms": "用語の抽出",
    "finalTranscript": "最終の文字起こし",
}

APP_NAME = "remote-whisper"
# Windows のトレイのツールチップは 128 文字まで（終わりの NUL を含む）
TOOLTIP_MAX = 127

MENU_OPEN = "画面を開く"
MENU_LOGS = "ログのフォルダを開く"
MENU_QUIT = "終了"


@dataclass(frozen=True)
class TrayState:
    color: Color
    # 状態の文（「録音中 1件 / 待ち 3件 / 実行中: 文字起こし」など）。Mac ではメニューの一番上に出す
    text: str

    @property
    def tooltip(self) -> str:
        """マウスを乗せたときの文（Windows）"""
        return _truncate(f"{APP_NAME}: {self.text}", TOOLTIP_MAX)


def tray_state(status: ServerStatus) -> TrayState:
    jobs = status.jobs or {}
    running = jobs.get("running")
    waiting = sum(int(w.get("count", 1)) for w in jobs.get("waiting") or [])
    problems = []
    if status.whisper == "error":
        problems.append("文字起こし（Whisper）が使えません")
    if status.ollama == "error":
        problems.append("Ollama に接続できません")
    parts = []
    if status.recordings:
        parts.append(f"録音中 {status.recordings}件")
    if waiting:
        parts.append(f"待ち {waiting}件")
    if running:
        parts.append(f"実行中: {JOB_NAMES.get(running.get('kind'), 'その他')}")
    if not parts and not problems:
        parts.append("待機中")
    # 使えないものがあるのがいちばん気づいてほしいこと。次に録音中（止めると困る）
    color: Color = (
        "orange"
        if problems
        else "red"
        if status.recordings
        else "blue"
        if running or waiting
        else "gray"
    )
    return TrayState(color, " / ".join(parts + problems))


def quit_confirmation(status: ServerStatus) -> str | None:
    """終了する前に確かめる文。録音中でなければ None（確かめずに終える）"""
    if not status.recordings:
        return None
    return (
        f"録音中のセッションが {status.recordings} 件あります。"
        "サーバーを止めると、録音もそこで止まります（そこまでの録音は残ります）。終了しますか？"
    )


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
