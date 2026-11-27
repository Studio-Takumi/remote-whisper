"""最終の要約とタイトル。GPU キュー（優先度 3）から呼ばれる。
進み具合は段階ごとに知らせる（#340）。spec/flows.md 6.3・6.5"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from remote_whisper.gpu.gpu_queue import report_progress
from remote_whisper.llm.llm import LlmClient, LlmUnavailable, backend_of
from remote_whisper.llm.ollama import ollama_error
from remote_whisper.materials.pages import Page, load_pages
from remote_whisper.settings import FinalModels, SettingsStore
from remote_whisper.storage.session_reader import summary_body
from remote_whisper.storage.session_writer import SessionWriter
from remote_whisper.storage.timeutil import now
from remote_whisper.summary.final_summary_body import Density, SummaryBody, needs_overview
from remote_whisper.summary.live_summary import load_context
from remote_whisper.summary.prompts import make_title_description
from remote_whisper.summary.summary_language import summary_language, title_max

log = logging.getLogger(__name__)


def _mark_failed(writer: SessionWriter, failed: bool) -> None:
    """要約の失敗を記録する。記録できなくても要約の処理は止めない"""
    try:
        writer.set_summary_failed(failed)
    except OSError as e:
        log.warning("failed to record the summary state of %s: %s", writer.id, e)


def fallback_title(summary: str, language: str = "ja") -> str | None:
    """タイトルを作れなかったとき、要約の最初の見出しか行から作る"""
    for line in summary.splitlines():
        text = line.strip().lstrip("#").strip().lstrip("-*").strip()
        if text:
            return text[: title_max(language)]
    return None


@dataclass
class _Made:
    """作った要約の本文と、タイトルを作る元（長いときは全体の概要）、思考モードを使ったか"""

    text: str
    gist: str
    think: bool


async def _transcript_lines(
    writer: SessionWriter, send: Callable[[dict[str, Any]], Awaitable[None]]
) -> list[str] | None:
    """要約する文字起こしの行（空の行は除く）。読めない・空なら送って None"""
    try:
        # 最終の文字起こし（#121）があれば、そちらから作る（文ごとの行で、取りこぼしも少ない）。
        # 画面で足した置き換え（#176）を当てたもの
        body = summary_body(writer.files, writer.meta.corrections)
    except (OSError, ValueError) as e:
        log.warning("could not read the transcript of %s: %s", writer.id, e)
        await send(_skipped("文字起こしを読み込めないので、最終要約は作りませんでした"))
        return None
    lines = [line for line in body.splitlines() if line.strip()]
    if not lines:
        await send(_skipped("文字起こしが空なので、最終要約は作りませんでした"))
        return None
    return lines


def _skipped(message: str) -> dict[str, Any]:
    return {"type": "error", "code": "summary_skipped", "message": message}


class FinalSummarizer:
    def __init__(
        self,
        ollama: LlmClient,
        settings: SettingsStore,
        whisper: Any = None,
        recording: Callable[[], bool] = lambda: False,
    ):
        self.ollama = ollama
        self.body = SummaryBody(ollama)
        self.settings = settings
        self.whisper = whisper
        # ほかに録音中のセッションがあるか（あれば Whisper を下ろさない）
        self.recording = recording
        # 録音を終えたあとの最終要約ができたら呼ぶ（通知。#245）。再生成（run）では呼ばない。
        # 待たない（通知は後ろで送る。GPU のキューのジョブの中で呼ぶため）
        self.on_summary: Callable[[Any], None] | None = None

    async def __call__(self, session: Any) -> None:
        """録音を終えたセッションの最終の要約。結果は、録音していた接続だけでなく全員に送る
        （作っている途中で接続が切れても、つながり直したブラウザに届くように。作り直しと同じ）"""

        async def send(message: dict[str, Any]) -> None:
            await session.manager.hub.broadcast({**message, "session": session.id})

        gid = await self.run(session.writer, send)
        if gid is not None and self.on_summary is not None:
            self.on_summary(session.writer)

    async def run(
        self,
        writer: SessionWriter,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        models: FinalModels | None = None,
    ) -> str | None:
        """最終の要約を作って保存する。生成 ID を返す（作れなければ None）。
        例外で止まっても `title` か `error` は送る（#118）"""
        try:
            return await self._run(writer, send, models)
        except Exception:
            log.exception("final summary of %s failed", writer.id)
            _mark_failed(writer, True)
            await send(
                {
                    "type": "error",
                    "code": "summary_failed",
                    "message": "最終要約を作る途中でエラーになりました",
                }
            )
            return None

    async def _run(
        self,
        writer: SessionWriter,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        models: FinalModels | None,
    ) -> str | None:
        # 生成 ID は、生成を始めた時刻（spec/files.md 5.2）
        started = now()
        await self._unload_whisper()
        lines = await _transcript_lines(writer, send)
        if lines is None:
            return None
        models = await self._resolve(models)
        context, density, pages = await self._inputs(writer)
        # 書く言語（#485）。作り始めた時点の設定と、文字起こしの決まった言語で決める
        language = summary_language(
            self.settings.get().ollama.summary_language, writer.meta.language
        )
        made = await self._make_body(writer, models, lines, context, send, density, pages, language)
        if made is None:
            return None
        title, description = await self._make_title(writer, models.title, made.gist, language)
        # 作れなければ、仮のタイトルか要約の最初の行を使う
        title = title or writer.meta.title or fallback_title(made.gist, language)
        gid = await self._save(writer, send, models, made, title, started, density, lines)
        if gid is None:
            return None
        try:
            writer.copy_summary(gid, description)
        except OSError as e:
            # コピーできなくても、データのルートには保存できている
            log.warning("failed to copy the summary of %s: %s", writer.id, e)
        _mark_failed(writer, False)
        log.info("final summary of %s saved as %s", writer.id, gid)
        await send({"type": "title", "title": writer.meta.title or "", "provisional": False})
        return gid

    async def _unload_whisper(self) -> None:
        """要約の前に Whisper を下ろして、VRAM を Ollama に空ける。失敗しても要約は作る"""
        if self.whisper is None or self.recording():
            return
        try:
            await self.whisper.unload()
        except Exception:  # noqa: BLE001
            log.exception("failed to unload whisper before the summary")

    async def _resolve(self, models: FinalModels | None) -> FinalModels:
        """使うモデル。省けば今の全体設定のもの"""
        models = models or self.settings.get().llm_models(backend_of(self.ollama)).final()
        # 入っていないモデルは代わりのもので作り、フロントマターには実際に使ったモデルを残す（#178）
        return FinalModels(
            overview=await self.ollama.resolve(models.overview),
            detail=await self.ollama.resolve(models.detail),
            title=await self.ollama.resolve(models.title),
        )

    async def _inputs(self, writer: SessionWriter) -> tuple[str | None, Density, list[Page]]:
        """参考資料セットのコンテキスト・要約度・詳細の項目に付ける参考資料のページ"""
        context = (
            load_context(writer.files.dir, writer.meta.context_set) if writer.use_context else None
        )
        # 要約度（#100）。作り始めた時点の全体設定のものを使い、フロントマターに残す
        ollama_settings = self.settings.get().ollama
        density = Density(ollama_settings.overview_density, ollama_settings.detail_density)
        # 詳細の項目に付ける参考資料のページ（#237）。設定がオフ・資料がなければ付けない
        # （PDF を読むのは時間がかかるので、イベントループを止めないよう別のスレッドで）
        pages = (
            await asyncio.to_thread(load_pages, writer.files.dir, writer.meta.context_set)
            if ollama_settings.detail_material_pages
            else []
        )
        return context, density, pages

    async def _make_body(
        self,
        writer: SessionWriter,
        models: FinalModels,
        lines: list[str],
        context: str | None,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        density: Density,
        pages: list[Page],
        language: str,
    ) -> _Made | None:
        """要約の本文を作って流す。作れなければ失敗を記録して None"""
        clock = time.monotonic()
        log.info(
            "final summary of %s started with %s / %s (%d lines)",
            writer.id,
            models.overview,
            models.detail,
            len(lines),
        )
        try:
            think = await self.ollama.supports_thinking(models.detail)
            text, gist = await self.body.make(
                models, lines, context, send, density, pages, language
            )
            if not gist:
                raise LlmUnavailable("要約が空でした")
        except LlmUnavailable as e:
            log.warning("final summary of %s failed: %s", writer.id, e)
            # 失敗したことを記録して、後で作り直せるようにする（spec/flows.md 6.7。UI は #17）
            _mark_failed(writer, True)
            await send(ollama_error("最終要約"))
            return None
        await send({"type": "summary.done", "kind": "final"})
        log.info(
            "final summary of %s done in %.1fs (%d chars)",
            writer.id,
            time.monotonic() - clock,
            len(text),
        )
        return _Made(text, gist, think)

    async def _make_title(
        self, writer: SessionWriter, model: str, gist: str, language: str
    ) -> tuple[str | None, str | None]:
        """タイトルと説明。作れなければ None（本文はもうできているので捨てない。#118）"""
        clock = time.monotonic()
        report_progress("title")
        try:
            title, description = await make_title_description(
                self.ollama, model, gist, language=language
            )
            if title:
                log.info("title of %s done in %.1fs", writer.id, time.monotonic() - clock)
            return title, description
        except LlmUnavailable as e:
            log.warning("title of %s failed: %s", writer.id, e)
        except Exception:
            log.exception("title of %s failed", writer.id)
        return None, None

    async def _save(
        self,
        writer: SessionWriter,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        models: FinalModels,
        made: _Made,
        title: str | None,
        started: datetime,
        density: Density,
        lines: list[str],
    ) -> str | None:
        """タイトルと要約を保存して生成 ID を返す。保存できなければ失敗を記録して None"""
        try:
            if title:
                writer.set_title(title)
            return writer.save_final_summary(
                models.detail,
                made.think,
                made.text,
                generated=started,
                # 一度に収まって概要を作らなかったときは、概要の要約度は残さない
                overview_density=(density.overview if needs_overview(lines) else None),
                detail_density=density.detail,
                overview_model=models.overview,
            )
        except OSError:
            log.exception("failed to save the final summary of %s", writer.id)
            _mark_failed(writer, True)
            await send(
                {
                    "type": "error",
                    "code": "write_failed",
                    "message": "最終要約を保存できませんでした",
                }
            )
            return None
