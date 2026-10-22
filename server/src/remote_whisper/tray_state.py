"""タスクトレイ（Windows）・メニューバー（Mac）に出す中身（#135）。spec/ui.md 8

点の色・マウスを乗せたときの文・メニューの項目を、サーバーの状態（status）から決める。
OS ごとに違う部分（アイコンの出し方・確認のダイアログ・フォルダを開く）は tray.py に置く。
ここは OS にも pystray にもよらない（テストしやすいように）
"""

from dataclasses import dataclass
from typing import Literal

from remote_whisper.cloud import CloudView
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
    "whisperLoad": "文字起こしのモデル読み込み",
    "liveSummary": "リアルタイム要約",
    "finalSummary": "最終要約",
    "contextSet": "参考資料の作成",
    "terms": "文字起こしからの用語抽出",
    "finalTranscript": "文字起こしの浄書",
}

APP_NAME = "remote-whisper"
# Windows のトレイのツールチップは 128 文字まで（終わりの NUL を含む）
TOOLTIP_MAX = 127

MENU_OPEN = "画面を開く"
MENU_LOGS = "ログのフォルダを開く"
MENU_QUIT = "終了"
# クラウド版のホストの登録（#158。spec/cloud.md 10.6）。状態に合うものだけを出す
MENU_CLOUD_LOGIN = "クラウド版にログイン"
MENU_CLOUD_CANCEL = "登録をやめる"
MENU_CLOUD_UNPAIR = "クラウド版から外す"
CLOUD_UNPAIR_CONFIRM = "この端末をクラウド版から外しますか？ 録音やファイルは消えません"


@dataclass(frozen=True)
class TrayState:
    color: Color
    # 状態の文（「録音中 1件 / 待ち 3件 / 実行中: 文字起こし」など）。Mac ではメニューの一番上に出す
    text: str
    # クラウドの状態の文（「クラウド版: 登録していない」など。#158）。空ならクラウドの行を出さない
    cloud: str = ""

    @property
    def tooltip(self) -> str:
        """マウスを乗せたときの文（Windows）。クラウドの状態は 2 行目に出す"""
        cloud = f"\n{self.cloud}" if self.cloud else ""
        return _truncate(f"{APP_NAME}: {self.text}", TOOLTIP_MAX - len(cloud)) + cloud


@dataclass(frozen=True)
class CloudMenu:
    """クラウドの項目のうち、どれを出すか"""

    login: bool
    cancel: bool
    unpair: bool


def cloud_text(view: CloudView | None) -> str:
    """クラウドの状態の文。つながっているかが分かるまで（#159・#161）は、登録済みならつながっているとする"""
    if view is None:
        return ""
    if view.status == "pairing":
        return f"クラウド版: 登録中（コード {view.code}）" if view.code else "クラウド版: 登録中…"
    if view.status == "unpairing":
        return "クラウド版: 外しています…"
    if view.status == "registered":
        if view.tunnel is not None:
            label = {"connected": "つながっている", "connecting": "つないでいます"}.get(
                view.tunnel, "止まっている"
            )
            return f"クラウド版: 登録済み / トンネル: {label}"
        return f"クラウド版: {'つながっていない' if view.connected is False else 'つながっている'}"
    return "クラウド版: 登録していない"


def cloud_menu(view: CloudView | None) -> CloudMenu:
    if view is None:
        return CloudMenu(False, False, False)
    return CloudMenu(
        login=view.status == "unregistered",
        cancel=view.status == "pairing",
        unpair=view.status == "registered",
    )


def tray_state(status: ServerStatus, cloud: CloudView | None = None) -> TrayState:
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
    return TrayState(color, " / ".join(parts + problems), cloud_text(cloud))


def quit_confirmation(status: ServerStatus) -> str | None:
    """終了する前に確かめる文。録音中でなければ None（確かめずに終える）"""
    if not status.recordings:
        return None
    return (
        f"録音中のセッションが {status.recordings} 件あります。"
        "終了すると録音もそこで止まります（そこまでは残ります）。終了しますか？"
    )


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
