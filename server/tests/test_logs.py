"""サーバーのログ（#134）"""

import asyncio
import logging
import multiprocessing
import os
import time

import pytest

from remote_whisper import logs


@pytest.fixture
def logging_setup(home):
    """ログをファイルに出し、終わったら元に戻す（ほかのテストの caplog を壊さないように）"""
    saved = {
        name: (logging.getLogger(name).handlers[:], logging.getLogger(name).propagate)
        for name in logs.LOGGERS
    }
    path = logs.setup(home, console=False)
    yield path
    for name, (handlers, propagate) in saved.items():
        logger = logging.getLogger(name)
        for handler in logger.handlers[:]:
            handler.close()
            logger.removeHandler(handler)
        for handler in handlers:
            logger.addHandler(handler)
        logger.propagate = propagate
    logs.shutdown()


def _file_handler():
    return next(
        h
        for h in logging.getLogger("remote_whisper").handlers
        if isinstance(h, logging.handlers.TimedRotatingFileHandler)
    )


def _wait_for(path, text, timeout=10.0):
    deadline = time.monotonic() + timeout
    while text not in path.read_text(encoding="utf-8"):
        assert time.monotonic() < deadline, f"{text} が書かれない"
        time.sleep(0.05)


def _child(queue, ready, done):
    """子プロセス: ログを親に渡しながら、ファイルの切り替えの間も生きている"""
    logs.setup_child(queue, "remote_whisper.test_child")
    logging.getLogger("faster_whisper").warning("child warning before")
    ready.set()
    done.wait(10)
    logging.getLogger("faster_whisper").warning("child warning after")
    import sys

    sys.stderr.write("Traceback (most recent call last):\n  boom\n")


def test_writes_to_the_log_file(logging_setup, home):
    assert logging_setup == home / "log" / "server.log"
    logging.getLogger("remote_whisper.something").info("hello")
    logging.getLogger("remote_whisper.something").debug("not written")
    _file_handler().flush()
    text = logging_setup.read_text(encoding="utf-8")
    assert "INFO remote_whisper.something: hello" in text
    assert "not written" not in text


def test_rotates_at_midnight_while_a_child_is_logging(logging_setup):
    # 子プロセスがログを書いている間に日付が変わっても、切り替えで失敗しない
    # （子はファイルを開かず、親に渡す。Windows では開いたままのファイルの名前を変えられない）
    mp = multiprocessing.get_context("spawn")
    ready, done = mp.Event(), mp.Event()
    child = mp.Process(target=_child, args=(logs.child_queue(), ready, done))
    child.start()
    try:
        assert ready.wait(30)
        log = logging.getLogger("remote_whisper.test")
        log.info("yesterday")
        handler = _file_handler()
        # 子からのログは、別のスレッドが受け取って書く。届くまで待つ
        _wait_for(logging_setup, "child warning before")
        # 時刻をずらす: 次の切り替えの時刻を過ぎたことにする
        handler.rolloverAt = int(time.time()) - 1
        log.info("today")
        done.set()
        child.join(30)
        assert child.exitcode == 0
    finally:
        if child.is_alive():
            child.kill()
    _wait_for(logging_setup, "boom")
    rotated = [p for p in logging_setup.parent.iterdir() if p.name != logs.LOG_FILE]
    assert len(rotated) == 1
    old = rotated[0].read_text(encoding="utf-8")
    new = logging_setup.read_text(encoding="utf-8")
    assert "yesterday" in old and "child warning before" in old
    assert "today" in new and "child warning after" in new
    # 子の stderr（落ちたときの Traceback など）も、親のログに入る
    assert "WARNING remote_whisper.test_child: Traceback" in new and "boom" in new


def test_keeps_ten_days(logging_setup):
    handler = _file_handler()
    log = logging.getLogger("remote_whisper.test")
    # 12 日分の古いファイルを作っておく
    for day in range(1, 13):
        old = logging_setup.with_name(f"{logs.LOG_FILE}.2026-09-{day:02d}")
        old.write_text("old\n", encoding="utf-8")
        os.utime(old, (time.time() - 86400 * (20 - day),) * 2)
    handler.rolloverAt = int(time.time()) - 1
    log.info("rolled")
    backups = sorted(p.name for p in logging_setup.parent.iterdir() if p.name != logs.LOG_FILE)
    assert len(backups) == logs.BACKUP_DAYS
    # 消えるのは古いものから
    assert f"{logs.LOG_FILE}.2026-09-01" not in backups


def test_forward_output_of_the_final_transcript_worker(caplog):
    async def run():
        stream = asyncio.StreamReader()
        stream.feed_data(
            b"INFO transcribed 10 segments in 30s\n"
            b" 10%|\xe2\x96\x88         | 1/10\r 20%|\xe2\x96\x88\xe2\x96\x88        | 2/10\r"
            b"WARNING diarization skipped: no token\n"
            b"\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e"  # 改行なしで終わる行（日本語）
        )
        stream.feed_eof()
        await logs.forward_output(stream, logging.getLogger("remote_whisper.worker_test"))

    with caplog.at_level(logging.INFO, logger="remote_whisper"):
        asyncio.run(run())
    records = [(r.levelname, r.getMessage()) for r in caplog.records]
    assert records == [
        ("INFO", "transcribed 10 segments in 30s"),
        ("WARNING", "diarization skipped: no token"),
        ("INFO", "日本語"),
    ]


def test_traffic_summary():
    traffic = logs.Traffic()
    assert traffic.summary() is None
    for _ in range(3):
        traffic.audio(32000)
    traffic.message("partial")
    traffic.message("partial")
    traffic.message("final")
    assert traffic.summary() == (
        "received 0.1 MB of audio in 3 chunks; sent 3 messages (final=1, partial=2)"
    )
    # 書いたら数え直す
    assert traffic.summary() is None
