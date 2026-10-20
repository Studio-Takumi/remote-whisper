"""サーバーのログ（#134）。spec/flows.md 6.10

- `<データのルート>/log/server.log` に書き、日付が変わったら切り替えて 10 日分残す
  （`TimedRotatingFileHandler`）。コンソールにも今まで通り出す
- 書くのは、いつ・何の通信があったかの概略と、Whisper・Ollama・最終の文字起こし・GPU キューの
  ジョブの「始めた・終わった・失敗した」。文字起こし・要約の本文と音声の中身は書かない
  （セッションの md と録音に残っているため）
- partial のように多いものは 1 件ずつ書かず、1 分ごとに数をまとめて書く（`Traffic`）
- 子プロセス（Whisper のワーカー・最終の文字起こし）のログも同じファイルに入れる。
  子はファイルを開かず、親に渡して親が書く（子がファイルを開いたままだと、Windows では
  日付が変わってファイルを切り替える（名前を変える）ときに失敗するため）
"""

import asyncio
import contextlib
import io
import logging
import multiprocessing
import sys
from collections import Counter
from logging.handlers import QueueHandler, QueueListener, TimedRotatingFileHandler
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

LOG_DIR = "log"
LOG_FILE = "server.log"
# 今日の分のほかに残す日数
BACKUP_DAYS = 10
FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
# 通信の数をまとめて書く間隔（秒）
TRAFFIC_INTERVAL = 60.0
# ログを設定するロガー。uvicorn は起動・終了とエラーだけ（アクセスログは middleware で書く）
LOGGERS = ("remote_whisper", "uvicorn")

# 子プロセスからログを受け取るキューと、それを親のロガーに流すもの（setup したときだけ）
_child_queue: Any = None
_listener: QueueListener | None = None


def log_path(home: Path) -> Path:
    return home / LOG_DIR / LOG_FILE


def setup(home: Path, console: bool = True) -> Path:
    """ログをファイル（とコンソール）に出すようにする。サーバーを起動するときに1回呼ぶ。ファイルの場所を返す"""
    path = log_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter(FORMAT)
    handlers: list[logging.Handler] = [
        TimedRotatingFileHandler(path, when="midnight", backupCount=BACKUP_DAYS, encoding="utf-8")
    ]
    # コンソールのないとき（pythonw で起動したなど）は sys.stderr が None
    if console and sys.stderr is not None:
        handlers.append(logging.StreamHandler())
    for handler in handlers:
        handler.setFormatter(formatter)
    for name in LOGGERS:
        logger = logging.getLogger(name)
        logger.setLevel(logging.INFO)
        for old in list(logger.handlers):
            logger.removeHandler(old)
        for handler in handlers:
            logger.addHandler(handler)
        logger.propagate = False
    # ほかのライブラリ（asyncio の「Task exception was never retrieved」や httpx など）は、
    # 警告から上だけ同じところに書く（コンソールのない pythonw でも残るように）
    root = logging.getLogger()
    root.setLevel(logging.WARNING)
    for old in list(root.handlers):
        root.removeHandler(old)
    for handler in handlers:
        root.addHandler(handler)
    _start_child_listener()
    return path


def _start_child_listener() -> None:
    global _child_queue, _listener
    if _listener is not None:
        return
    # Whisper のワーカーは spawn で起こすので、キューも spawn のものにする
    _child_queue = multiprocessing.get_context("spawn").Queue()
    _listener = QueueListener(_child_queue, _ToParentLogger())
    _listener.start()


def shutdown() -> None:
    """子プロセスからログを受け取るのをやめる（サーバーを止めるとき）"""
    global _child_queue, _listener
    if _listener is not None:
        with contextlib.suppress(Exception):
            _listener.stop()
    _listener = None
    _child_queue = None


def child_queue() -> Any:
    """子プロセスに渡すキュー。setup していなければ（テストなど）None"""
    return _child_queue


class _ToParentLogger(logging.Handler):
    """子プロセスから届いたログを、親の remote_whisper のロガーで書く（名前は子のまま出る）"""

    def handle(self, record: logging.LogRecord) -> bool:  # type: ignore[override]
        logging.getLogger("remote_whisper.child").handle(record)
        return True

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover - handle で済む
        pass


def setup_child(queue: Any, name: str) -> None:
    """子プロセスの中で呼ぶ。ログ（警告より上）と stderr に書かれたものを、親に渡す"""
    if queue is None:
        return
    root = logging.getLogger()
    for old in list(root.handlers):
        root.removeHandler(old)
    root.addHandler(QueueHandler(queue))
    # 子の中のライブラリ（faster_whisper など）は区間ごとに INFO を書くので、警告から上だけにする
    root.setLevel(logging.WARNING)
    # 落ちたときの Traceback など、stderr に書かれたものも親に渡す
    sys.stderr = LineLogger(logging.getLogger(name), logging.WARNING)


class LineLogger(io.TextIOBase):
    """書かれた文字列を 1 行ずつログにする（子プロセスの stderr の代わり）"""

    def __init__(self, logger: logging.Logger, level: int):
        self.logger = logger
        self.level = level
        self._buffer = ""

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        self._buffer += text
        *lines, self._buffer = self._buffer.replace("\r", "\n").split("\n")
        for line in lines:
            if line.strip():
                self.logger.log(self.level, "%s", line.rstrip())
        return len(text)

    def flush(self) -> None:
        if self._buffer.strip():
            self.logger.log(self.level, "%s", self._buffer.rstrip())
        self._buffer = ""


async def forward_output(stream: asyncio.StreamReader, logger: logging.Logger) -> None:
    """子プロセス（最終の文字起こし）の標準出力・標準エラーを、1 行ずつログにする

    進み具合のバー（tqdm）は書かない。行の頭のレベル（`WARNING` など）があれば、そのレベルで書く
    """
    buffer = ""
    while chunk := await stream.read(4096):
        buffer += chunk.decode("utf-8", errors="replace")
        *lines, buffer = buffer.replace("\r", "\n").split("\n")
        for line in lines:
            _log_child_line(logger, line)
    _log_child_line(logger, buffer)


def _log_child_line(logger: logging.Logger, line: str) -> None:
    line = line.strip()
    # tqdm の進み具合（例: " 45%|████▌     | 9/20"）は、行が多くなるだけなので書かない
    if not line or "%|" in line:
        return
    level = logging.INFO
    # 子のログは「レベル 本文」の形（final_transcribe_worker）。レベルは親のログのレベルにする
    for name in ("CRITICAL", "ERROR", "WARNING", "INFO"):
        if line.startswith(name + " "):
            level = logging.getLevelName(name)
            line = line[len(name) + 1 :]
            break
    logger.log(level, "%s", line)


class Traffic:
    """通信の数。1 件ずつは書かず、TRAFFIC_INTERVAL 秒ごとにまとめて書く"""

    def __init__(self) -> None:
        self.audio_bytes = 0
        self.audio_chunks = 0
        self.sent: Counter[str] = Counter()

    def audio(self, size: int) -> None:
        self.audio_bytes += size
        self.audio_chunks += 1

    def message(self, kind: str) -> None:
        self.sent[kind] += 1

    def summary(self) -> str | None:
        """前に書いてからの数。何もなければ None。書いたら数え直す"""
        if not self.audio_chunks and not self.sent:
            return None
        sent = ", ".join(f"{kind}={n}" for kind, n in sorted(self.sent.items()))
        megabytes = self.audio_bytes / 1_000_000
        text = (
            f"received {megabytes:.1f} MB of audio in {self.audio_chunks} chunks; "
            f"sent {sum(self.sent.values())} messages ({sent or 'none'})"
        )
        self.audio_bytes = 0
        self.audio_chunks = 0
        self.sent.clear()
        return text

    async def run(self, interval: float = TRAFFIC_INTERVAL) -> None:
        while True:
            await asyncio.sleep(interval)
            text = self.summary()
            if text is not None:
                log.info("traffic in the last %.0fs: %s", interval, text)


traffic = Traffic()
