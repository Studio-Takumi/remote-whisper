"""アプリの起動と終了（lifespan）で、何を起こし、何を止めるか"""

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from remote_whisper.logs import traffic
from remote_whisper.recording.manager import RecordingManager
from remote_whisper.recording.recovery import Leftovers, find_leftovers, fix_leftovers
from remote_whisper.version import app_version
from remote_whisper.wiring import Parts

log = logging.getLogger(__name__)


def make_lifespan(parts: Parts, home: Path, mock: bool):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        traffic_task = await _start(parts, home, mock)
        # トンネル専用の 8001 番（#160）は、このアプリと同じイベントループの上で動かす
        tunnel = app.state.tunnel
        if tunnel is not None:
            tunnel.attach(asyncio.get_running_loop())
        # 登録済みなら cloudflared を動かす（8001 番が開くのを待つのは専用のスレッド。#159）
        cloudflared = app.state.cloudflared
        if cloudflared is not None:
            cloudflared.sync()
        yield
        log.info("server stopping")
        if cloudflared is not None:
            # 子プロセスを残さない（待つ間もイベントループは止めない）
            await asyncio.to_thread(cloudflared.stop)
        if tunnel is not None:
            # 片付ける前に、8001 番からの新しいリクエストを止める
            await tunnel.aclose()
        await _stop(parts, traffic_task)

    return lifespan


async def _recover_leftovers(parts: Parts) -> None:
    """前に動いていたサーバーが落ちていたら、録音中のままの文字起こしを interrupted に直し、
    残っている WAV を変換する（変換は時間がかかるので後ろで。spec/flows.md 6.7）"""
    ctx = parts.ctx
    found = find_leftovers(ctx.projects, ctx.settings.get().retention_days.summary)
    quick = Leftovers(
        recording=found.recording, unsummarized=found.unsummarized, partials=found.partials
    )
    fix_leftovers(ctx.projects, quick)
    if found.wavs:
        leftover_wavs = Leftovers(wavs=found.wavs)
        recovering = asyncio.create_task(
            asyncio.to_thread(fix_leftovers, ctx.projects, leftover_wavs)
        )
        parts.background.add(recovering)
        recovering.add_done_callback(parts.background.discard)


async def _start(parts: Parts, home: Path, mock: bool) -> asyncio.Task:
    """見張りと定期の処理を始める。音声の受信量のログを書くタスクを返す"""
    ctx = parts.ctx
    if ctx.whisper is not None:
        # Whisper の子プロセスが落ちていないか、使わなくなっていないかを見張る
        ctx.whisper.start_watchdog()
    if ctx.ollama is not None:
        # 使っている LLM（Ollama か LM Studio）につながるかを見張る
        # （status の ollama・lmstudio）
        ctx.ollama.start_monitor()
    if ctx.context_sets is not None:
        # 前に動いていたときに作っている途中だった参考資料セットを failed に直す
        ctx.context_sets.recover()
    await _recover_leftovers(parts)
    # 最終要約の通知（#245）の VAPID の鍵。なければ作る（秘密鍵はデータのルートの外に出さない）
    try:
        await asyncio.to_thread(ctx.push.ensure_key)
    except OSError:
        log.exception("could not prepare the push key; notifications are off")
        ctx.push = None
    # 前に WhisperX を入れている途中でサーバーが止まっていたら、元に戻す（#291）
    ctx.setup.installer.recover()
    # 保存期間を過ぎたファイルを、起動時とその後1日1回消す
    parts.janitor.start()
    # GPU の使用率と VRAM を数秒おきに送る（取れない環境と、GPU を使わないモック・
    # 偽の Whisper（テスト）では何もしない）
    if not mock and os.environ.get("REMOTE_WHISPER_WHISPER_BACKEND") != "fake":
        parts.gpu_stats.start()
    # 音声の受信量と送ったメッセージの数を、1 分ごとにまとめてログに書く（#134）
    traffic_task = asyncio.create_task(traffic.run())
    log.info("server started (version %s, data in %s)", app_version(), home)
    return traffic_task


async def _stop(parts: Parts, traffic_task: asyncio.Task) -> None:
    ctx = parts.ctx
    traffic_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await traffic_task
    await parts.gpu_stats.close()
    await parts.janitor.close()
    await ctx.uploads.close()
    # モデルの取得と WhisperX を入れるのを止める（入れている途中なら、次に起動したときに戻す）
    await ctx.setup.close()
    # 止める順番: 録音の側 → GPU キュー → Whisper（先に止めないと、
    # 止めたキューにジョブが積まれてワーカーが作り直される）
    if isinstance(ctx.recorder, RecordingManager):
        await ctx.recorder.close()
    if ctx.final_transcriber is not None:
        await ctx.final_transcriber.close()
    # 参考資料セットも、Ollama への頼みを 1 回ずつ積んでいるので先に止める（#271）
    if ctx.context_sets is not None:
        await ctx.context_sets.close()
    await ctx.gpu.stop()
    if ctx.whisper is not None:
        await ctx.whisper.close()
    if parts.background:
        await asyncio.gather(*parts.background, return_exceptions=True)
    if ctx.ollama is not None:
        # 見張りを止める。LM Studio は自分が載せたモデルを下ろす（止めたあとはタイマーで
        # 下ろせないため。#326）
        await ctx.ollama.close()
