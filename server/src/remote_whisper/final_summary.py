"""最終の要約とタイトル。spec 6.3・6.5

録音を終えたあと、GPU キュー（優先度 3）から呼ばれる。

1. ほかに録音中のセッションがなければ、Whisper を VRAM から下ろす（spec 6.3）
2. 文字起こし全体が num_ctx に収まれば一度に要約する。収まらなければ部分ごとに要約し、
   「全体の概要」（部分ごとの要約を凝縮したもの）のあとに、部分ごとの要約を時間の順に
   そのまま並べる（#92。長い録音ほど要約が凝縮されすぎないように）。
   思考モードはオン（モデルが対応していれば）。部分ごとの要約を作っている間は送らず、
   概要を `summary.delta`（final）で流してから、部分ごとの要約を続けて送る
3. タイトルを別のリクエストで作る（JSON Schema で15文字以内）。長いときは概要から作る
4. `summary-<ID>-<生成 ID>.md` に保存して途中の要約を消し、選んだディレクトリにコピーを置く
5. `title`（provisional: false）を送る（ブラウザは保存されたものを取り直す）

Ollama につながらなければ ollama_unavailable を送り、途中の要約は残す（作り直しは #28）。
"""

import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from remote_whisper.documents import parse
from remote_whisper.live_summary import load_context
from remote_whisper.ollama import OllamaClient, OllamaUnavailable, ollama_error
from remote_whisper.prompts import (
    DEFAULT_DENSITY,
    TITLE_MAX,
    final_summary_messages,
    make_title,
    overview_messages,
    part_summary_messages,
    reduce_summary_messages,
)
from remote_whisper.session_writer import SessionWriter
from remote_whisper.sessions import summary_source
from remote_whisper.settings import FinalModels, SettingsStore
from remote_whisper.summary_parts import (
    CHUNK_CHARS,
    NUM_CTX,
    PREVIOUS_CHARS,
    demote,
    demote_lines,
    section_heading,
    split_lines,
)
from remote_whisper.timeutil import now

log = logging.getLogger(__name__)

OVERVIEW_HEADING = "全体の概要"


@dataclass(frozen=True)
class Density:
    """最終の要約の要約度（#100）

    overview は概要、detail は部分ごとの要約（一度に収まるときは、その要約）
    """

    overview: int = DEFAULT_DENSITY
    detail: int = DEFAULT_DENSITY


EMPTY_PART = "（この部分は要約できませんでした）"


def _mark_failed(writer: SessionWriter, failed: bool) -> None:
    """要約の失敗を記録する。記録できなくても要約の処理は止めない"""
    try:
        writer.set_summary_failed(failed)
    except OSError as e:
        log.warning("failed to record the summary state of %s: %s", writer.id, e)


def fallback_title(summary: str) -> str | None:
    """タイトルを作れなかったとき、要約の最初の見出しか行から作る"""
    for line in summary.splitlines():
        text = line.strip().lstrip("#").strip().lstrip("-*").strip()
        if text:
            return text[:TITLE_MAX]
    return None


class FinalSummarizer:
    def __init__(
        self,
        ollama: OllamaClient,
        settings: SettingsStore,
        whisper: Any = None,
        recording: Callable[[], bool] = lambda: False,
    ):
        self.ollama = ollama
        self.settings = settings
        self.whisper = whisper
        # ほかに録音中のセッションがあるか（あれば Whisper を下ろさない）
        self.recording = recording

    async def __call__(self, session: Any) -> None:
        """録音を終えたセッションの最終の要約。結果は、録音していた接続だけでなく全員に送る
        （作っている途中で接続が切れても、つながり直したブラウザに届くように。作り直しと同じ）"""

        async def send(message: dict[str, Any]) -> None:
            await session.manager.hub.broadcast({**message, "session": session.id})

        await self.run(session.writer, send)

    async def run(
        self,
        writer: SessionWriter,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        models: FinalModels | None = None,
    ) -> str | None:
        """最終の要約を作って保存する。生成 ID を返す（作れなければ None）

        models を省くと、動き始めた時点の全体設定のモデル（全体概要・要約詳細・タイトル）を使う
        （作り直しは、頼んだ時点のものを渡す）

        思わぬ例外で止まっても、`title` か `error` のどちらかは必ず送る
        （送らないと、ブラウザが「作成中」のままになる。#118）
        """
        try:
            return await self._run(writer, send, models)
        except Exception:
            log.exception("final summary of %s failed", writer.id)
            _mark_failed(writer, True)
            await send(
                {
                    "type": "error",
                    "code": "summary_failed",
                    "message": "最終の要約を作る途中でエラーになりました",
                }
            )
            return None

    async def _run(
        self,
        writer: SessionWriter,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        models: FinalModels | None,
    ) -> str | None:
        # 生成 ID は、生成を始めた時刻（spec 5.2）
        started = now()
        if self.whisper is not None and not self.recording():
            # 要約の前に Whisper を下ろして、VRAM を Ollama に空ける。失敗しても要約は作る
            try:
                await self.whisper.unload()
            except Exception:  # noqa: BLE001
                log.exception("failed to unload whisper before the summary")
        try:
            # 最終の文字起こし（#121）があれば、そちらから作る（文ごとの行で、取りこぼしも少ない）
            _, body = parse(summary_source(writer.files).read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            log.warning("could not read the transcript of %s: %s", writer.id, e)
            await send(
                {
                    "type": "error",
                    "code": "summary_skipped",
                    "message": "文字起こしを読み込めないので、最終の要約は作りませんでした",
                }
            )
            return None
        lines = [line for line in body.splitlines() if line.strip()]
        if not lines:
            await send(
                {
                    "type": "error",
                    "code": "summary_skipped",
                    "message": "文字起こしが空なので、最終の要約は作りませんでした",
                }
            )
            return None
        models = models or self.settings.get().ollama.models.final()
        # 入っていないモデルは代わりのもので作り、フロントマターには実際に使ったモデルを残す（#178）
        models = FinalModels(
            overview=await self.ollama.resolve(models.overview),
            detail=await self.ollama.resolve(models.detail),
            title=await self.ollama.resolve(models.title),
        )
        model = models.detail
        context = (
            load_context(writer.files.dir, writer.meta.context_set) if writer.use_context else None
        )
        # 要約度（#100）。作り始めた時点の全体設定のものを使い、フロントマターに残す
        ollama_settings = self.settings.get().ollama
        density = Density(ollama_settings.overview_density, ollama_settings.detail_density)
        clock = time.monotonic()
        log.info(
            "final summary of %s started with %s / %s (%d lines)",
            writer.id,
            models.overview,
            models.detail,
            len(lines),
        )
        try:
            think = await self.ollama.supports_thinking(model)
            text, gist = await self._summarize(models, lines, context, send, density)
            if not gist:
                raise OllamaUnavailable("要約が空でした")
        except OllamaUnavailable as e:
            log.warning("final summary of %s failed: %s", writer.id, e)
            # 失敗したことを記録して、後で作り直せるようにする（spec 6.7。UI は #17）
            _mark_failed(writer, True)
            await send(ollama_error("最終の要約"))
            return None
        await send({"type": "summary.done", "kind": "final"})
        log.info(
            "final summary of %s done in %.1fs (%d chars)",
            writer.id,
            time.monotonic() - clock,
            len(text),
        )

        clock = time.monotonic()
        try:
            title = await make_title(self.ollama, models.title, gist)
            if title:
                log.info("title of %s done in %.1fs", writer.id, time.monotonic() - clock)
        except OllamaUnavailable as e:
            log.warning("title of %s failed: %s", writer.id, e)
            title = None
        except Exception:
            # 本文はもうできているので、タイトルだけの失敗で捨てない（#118）
            log.exception("title of %s failed", writer.id)
            title = None
        # 作れなければ、仮のタイトルか要約の最初の行を使う
        title = title or writer.meta.title or fallback_title(gist)
        try:
            if title:
                writer.set_title(title)
            gid = writer.save_final_summary(
                model,
                think,
                text,
                generated=started,
                # 一度に収まって概要を作らなかったときは、概要の要約度は残さない
                overview_density=(
                    density.overview if len(split_lines(lines, CHUNK_CHARS)) > 1 else None
                ),
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
                    "message": "最終の要約を保存できませんでした",
                }
            )
            return None
        try:
            writer.copy_summary(gid)
        except OSError as e:
            # コピーできなくても、データのルートには保存できている
            log.warning("failed to copy the summary of %s: %s", writer.id, e)
        _mark_failed(writer, False)
        log.info("final summary of %s saved as %s", writer.id, gid)
        await send({"type": "title", "title": writer.meta.title or "", "provisional": False})
        return gid

    async def _summarize(
        self,
        models: FinalModels,
        lines: list[str],
        context: str | None,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        density: Density | None = None,
    ) -> tuple[str, str]:
        """要約の本文と、タイトルを作る元（長いときは全体の概要）を返す。どちらも空なら作れなかった

        一度に収まるときは、詳細の要約度で作る（概要は作らない）。
        部分ごとの要約（と一度に収まるときの要約）は要約詳細のモデル、まとめと概要は全体概要のモデル
        """
        density = density or Density()
        model = models.detail
        options = {"num_ctx": NUM_CTX}
        chunks = split_lines(lines, CHUNK_CHARS)
        if len(chunks) == 1:
            stream = self.ollama.chat_stream(
                model,
                final_summary_messages(lines, context, density.detail),
                think=True,
                options=options,
            )
            text = (await self._send_stream(stream, send)).strip()
            return text, text

        # 部分ごとに要約する（送らない）。これがそのまま「詳細」になる
        parts: list[str] = []
        for i, chunk in enumerate(chunks):
            previous = parts[-1][-PREVIOUS_CHARS:] if parts else None
            part = await self.ollama.chat(
                model,
                part_summary_messages(
                    chunk, i, len(chunks), context, previous, density=density.detail
                ),
                think=True,
                options=options,
            )
            if not part.strip():
                # その時間帯が見出しだけになって、黙って抜けないようにする
                log.warning("part %d/%d of the final summary was empty", i + 1, len(chunks))
                part = EMPTY_PART
            parts.append(part.strip())
        # 概要の材料。部分の要約を合わせてまだ長ければ、いくつかずつまとめるのを繰り返す
        digest = parts
        while len(digest) > 1 and sum(len(p) for p in digest) > CHUNK_CHARS:
            groups = split_lines(digest, CHUNK_CHARS)
            if len(groups) == len(digest):
                # 1つずつにしかならない（どれも長い）なら、これ以上は縮まらないので概要に進む
                break
            digest = [
                (
                    await self.ollama.chat(
                        models.overview,
                        reduce_summary_messages(group, context),
                        think=True,
                        options=options,
                    )
                ).strip()
                for group in groups
            ]
        # 全体の概要を流してから、部分ごとの要約を時間の順に続ける
        head = f"## {OVERVIEW_HEADING}\n\n"
        stream = self.ollama.chat_stream(
            models.overview,
            overview_messages(digest, context, density.overview),
            think=True,
            options=options,
        )
        gist = (await self._send_stream(demote_lines(stream), send, head)).strip()
        if not gist:
            return "", ""
        text = head + gist
        for i, part in enumerate(parts):
            body = "\n".join(demote(line) for line in part.split("\n"))
            section = f"\n\n{section_heading(chunks, i)}\n\n{body}"
            text += section
            await send({"type": "summary.delta", "kind": "final", "text": section})
        return text, gist

    async def _send_stream(
        self,
        stream: AsyncIterator[str],
        send: Callable[[dict[str, Any]], Awaitable[None]],
        prefix: str = "",
    ) -> str:
        """流れてくる本文を `summary.delta`（final）で送り、つなげて返す

        prefix は空白でない本文が来たときに、それと一緒に送る（来なければ送らない）。
        返す本文には含めない
        """
        out: list[str] = []
        pending = prefix
        async for part in stream:
            out.append(part)
            if pending:
                if not part.strip():
                    pending += part
                    continue
                part, pending = pending + part, ""
            await send({"type": "summary.delta", "kind": "final", "text": part})
        return "".join(out)
