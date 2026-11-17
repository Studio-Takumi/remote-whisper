"""最終の要約の本文（#92）。spec/flows.md 6.3・6.5

一度に収まれば一度に要約する。収まらなければ部分ごとに要約し、まとめてから全体の概要を作る。
概要を `summary.delta`（final）で流してから、部分ごとの要約を時間の順に続けて送る
"""

import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from remote_whisper.gpu.gpu_queue import report_progress
from remote_whisper.llm.llm import LlmClient
from remote_whisper.materials.pages import Page, annotate_detail
from remote_whisper.settings import FinalModels
from remote_whisper.summary.prompts import (
    DEFAULT_DENSITY,
    final_summary_messages,
    overview_messages,
    part_summary_messages,
    reduce_summary_messages,
)
from remote_whisper.summary.summary_parts import (
    CHUNK_CHARS,
    NUM_CTX,
    PREVIOUS_CHARS,
    demote,
    demote_lines,
    section_heading,
    split_lines,
)

log = logging.getLogger("remote_whisper.summary.final_summary")

OVERVIEW_HEADING = "全体概要"


@dataclass(frozen=True)
class Density:
    """最終の要約の要約度（#100）

    overview は概要、detail は部分ごとの要約（一度に収まるときは、その要約）
    """

    overview: int = DEFAULT_DENSITY
    detail: int = DEFAULT_DENSITY


EMPTY_PART = "（この部分は要約できませんでした）"


def detail_section(chunks: list[list[str]], index: int, part: str) -> str:
    """部分ごとの要約を、時刻の範囲の見出しの下に置く（本文の見出しは 1 段下げる）"""
    body = "\n".join(demote(line) for line in part.split("\n"))
    return f"\n\n{section_heading(chunks, index)}\n\n{body}"


def needs_overview(lines: list[str]) -> bool:
    """一度に収まらず、部分ごとの要約と全体の概要を作るか"""
    return len(split_lines(lines, CHUNK_CHARS)) > 1


class SummaryBody:
    """要約の本文を作って流す"""

    def __init__(self, ollama: LlmClient):
        self.ollama = ollama

    async def make(
        self,
        models: FinalModels,
        lines: list[str],
        context: str | None,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        density: Density | None = None,
        pages: list[Page] | None = None,
    ) -> tuple[str, str]:
        """要約の本文と、タイトルを作る元（長いときは全体の概要）を返す。どちらも空なら作れなかった

        一度に収まるときは、詳細の要約度で作る（概要は作らない）。
        部分ごとの要約（と一度に収まるときの要約）は要約詳細のモデル、まとめと概要は全体概要のモデル。
        pages があれば、詳細の項目に参考資料のページを付ける（#237。概要には付けない）
        """
        density = density or Density()
        chunks = split_lines(lines, CHUNK_CHARS)
        if len(chunks) == 1:
            return await self._summarize_once(models.detail, lines, context, send, density, pages)
        # 部分ごとに要約する（送らない）。これがそのまま「詳細」になる
        parts = await self._summarize_parts(models.detail, chunks, context, density)
        digest = await self._condense(models.overview, parts, context)
        # 全体の概要を流してから、部分ごとの要約を時間の順に続ける
        head = f"## {OVERVIEW_HEADING}\n\n"
        report_progress("overview")
        stream = self.ollama.chat_stream(
            models.overview,
            overview_messages(digest, context, density.overview),
            think=True,
            options={"num_ctx": NUM_CTX},
        )
        gist = (await self._send_stream(demote_lines(stream), send, head)).strip()
        if not gist:
            return "", ""
        if pages:
            parts = await self._annotate_parts(models.detail, parts, pages)
        text = head + gist
        for i, part in enumerate(parts):
            section = detail_section(chunks, i, part)
            text += section
            await send({"type": "summary.delta", "kind": "final", "text": section})
        return text, gist

    async def _summarize_once(
        self,
        model: str,
        lines: list[str],
        context: str | None,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        density: Density,
        pages: list[Page] | None,
    ) -> tuple[str, str]:
        """一度に収まるときの要約。流して送り、本文と、タイトルを作る元を返す"""
        report_progress("summary")
        stream = self.ollama.chat_stream(
            model,
            final_summary_messages(lines, context, density.detail),
            think=True,
            options={"num_ctx": NUM_CTX},
        )
        text = (await self._send_stream(stream, send)).strip()
        # 流したものには付いていない。保存したものを画面が取り直すときに付いて見える
        if text and pages:
            report_progress("pages")
            return await annotate_detail(self.ollama, model, text, pages), text
        return text, text

    async def _summarize_parts(
        self, model: str, chunks: list[list[str]], context: str | None, density: Density
    ) -> list[str]:
        """部分ごとの要約。前の部分の要約の終わりを参考として渡す"""
        parts: list[str] = []
        for i, chunk in enumerate(chunks):
            report_progress("parts", i, len(chunks))
            previous = parts[-1][-PREVIOUS_CHARS:] if parts else None
            part = await self.ollama.chat(
                model,
                part_summary_messages(
                    chunk, i, len(chunks), context, previous, density=density.detail
                ),
                think=True,
                options={"num_ctx": NUM_CTX},
            )
            if not part.strip():
                # その時間帯が見出しだけになって、黙って抜けないようにする
                log.warning("part %d/%d of the final summary was empty", i + 1, len(chunks))
                part = EMPTY_PART
            parts.append(part.strip())
        return parts

    async def _condense(self, model: str, parts: list[str], context: str | None) -> list[str]:
        """概要の材料。部分の要約を合わせてまだ長ければ、いくつかずつまとめるのを繰り返す"""
        digest = parts
        while len(digest) > 1 and sum(len(p) for p in digest) > CHUNK_CHARS:
            groups = split_lines(digest, CHUNK_CHARS)
            if len(groups) == len(digest):
                # 1つずつにしかならない（どれも長い）なら、これ以上は縮まらないので概要に進む
                break
            # 何回まとめるかは前もって分からないので、段階だけ出す
            report_progress("condense")
            digest = [
                (
                    await self.ollama.chat(
                        model,
                        reduce_summary_messages(group, context),
                        think=True,
                        options={"num_ctx": NUM_CTX},
                    )
                ).strip()
                for group in groups
            ]
        return digest

    async def _annotate_parts(self, model: str, parts: list[str], pages: list[Page]) -> list[str]:
        """部分ごとの要約の項目に、参考資料のページを付ける（要約できなかった部分は付けない）"""
        annotated: list[str] = []
        for i, part in enumerate(parts):
            report_progress("pages", i, len(parts))
            annotated.append(
                part
                if part == EMPTY_PART
                else await annotate_detail(self.ollama, model, part, pages)
            )
        return annotated

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
