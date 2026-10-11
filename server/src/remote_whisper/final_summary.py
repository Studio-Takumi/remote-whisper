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
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from remote_whisper.documents import parse
from remote_whisper.live_summary import load_context
from remote_whisper.ollama import OllamaClient, OllamaUnavailable, ollama_error
from remote_whisper.prompts import (
    TITLE_MAX,
    final_summary_messages,
    make_title,
    overview_messages,
    part_summary_messages,
    reduce_summary_messages,
)
from remote_whisper.session_writer import SessionWriter
from remote_whisper.settings import SettingsStore
from remote_whisper.timeutil import now

log = logging.getLogger(__name__)

# Ollama に渡すコンテキストの長さ（トークン）。Ollama の既定は小さいので、明示する
# 思考は5千トークンを超えることがあり、8192 では本文が途中で切れていた（#92 で測った。
# qwen3.5:4b で 3600 文字の文字起こしが 2700 トークン、思考と本文で 5500 トークン）
NUM_CTX = 16384
# 一度に渡す文字起こしの長さ（文字）。部分ごとの要約の濃さはこの長さで決まる。
# 指示・コンテキスト・前の部分の要約・出力（思考を含む）の分を十分に残す
CHUNK_CHARS = 4000
# 次の部分に参考として渡す、前の部分の要約の長さ（文字。後ろから）
PREVIOUS_CHARS = 1000
OVERVIEW_HEADING = "全体の概要"

_TIME = re.compile(r"^\[(\d{2}:\d{2}:\d{2})\]")
_HEADING = re.compile(r"^(#{1,6})(?=\s)")


def split_lines(lines: list[str], limit: int | None = None) -> list[list[str]]:
    """行の区切りで、1つあたり limit 文字ほどに分ける（1行が長すぎるときはその行だけで1つ）"""
    limit = CHUNK_CHARS if limit is None else limit
    chunks: list[list[str]] = []
    current: list[str] = []
    size = 0
    for line in lines:
        if current and size + len(line) > limit:
            chunks.append(current)
            current, size = [], 0
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append(current)
    return chunks


def demote(line: str) -> str:
    """見出しを、部分の見出し（##）より下の段（### 以下）にする"""
    return _HEADING.sub(lambda m: "#" * min(max(len(m.group(1)) + 1, 3), 6), line)


def section_heading(chunks: list[list[str]], index: int) -> str:
    """部分の見出し。文字起こしの時刻の範囲（取れなければ「部分 n」）"""
    start = _TIME.match(chunks[index][0])
    if index + 1 < len(chunks):
        end = _TIME.match(chunks[index + 1][0])
    else:
        end = _TIME.match(chunks[index][-1])
    if start and end:
        return f"## {start.group(1)}〜{end.group(1)}"
    return f"## 部分 {index + 1}"


async def demote_lines(stream: AsyncIterator[str]) -> AsyncIterator[str]:
    """流れてくる本文を行ごとにまとめ、見出しを1段下げて返す"""
    buffer = ""
    async for part in stream:
        buffer += part
        if "\n" not in buffer:
            continue
        done, buffer = buffer.rsplit("\n", 1)
        yield "\n".join(demote(line) for line in done.split("\n")) + "\n"
    if buffer:
        yield demote(buffer)


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
        model: str | None = None,
    ) -> str | None:
        """最終の要約を作って保存する。生成 ID を返す（作れなければ None）

        model を省くと、動き始めた時点の finalSummaryModel を使う
        （作り直しは、頼んだ時点のものを渡す）
        """
        # 生成 ID は、生成を始めた時刻（spec 5.2）
        started = now()
        if self.whisper is not None and not self.recording():
            # 要約の前に Whisper を下ろして、VRAM を Ollama に空ける。失敗しても要約は作る
            try:
                await self.whisper.unload()
            except Exception:  # noqa: BLE001
                log.exception("failed to unload whisper before the summary")
        try:
            _, body = parse(writer.files.transcript.read_text(encoding="utf-8"))
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
        model = model or self.settings.get().ollama.final_summary_model
        context = (
            load_context(writer.files.dir, writer.meta.context_set) if writer.use_context else None
        )
        try:
            think = await self.ollama.supports_thinking(model)
            text, gist = await self._summarize(model, lines, context, send)
            if not gist:
                raise OllamaUnavailable("要約が空でした")
        except OllamaUnavailable as e:
            log.warning("final summary of %s failed: %s", writer.id, e)
            # 失敗したことを記録して、後で作り直せるようにする（spec 6.7。UI は #17）
            _mark_failed(writer, True)
            await send(ollama_error("最終の要約"))
            return None
        await send({"type": "summary.done", "kind": "final"})

        try:
            title = await make_title(self.ollama, model, gist)
        except OllamaUnavailable as e:
            log.warning("title of %s failed: %s", writer.id, e)
            title = None
        # 作れなければ、仮のタイトルか要約の最初の行を使う
        title = title or writer.meta.title or fallback_title(gist)
        try:
            if title:
                writer.set_title(title)
            gid = writer.save_final_summary(model, think, text, generated=started)
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
        await send({"type": "title", "title": writer.meta.title or "", "provisional": False})
        return gid

    async def _summarize(
        self,
        model: str,
        lines: list[str],
        context: str | None,
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> tuple[str, str]:
        """要約の本文と、タイトルを作る元（長いときは全体の概要）を返す。どちらも空なら作れなかった"""
        options = {"num_ctx": NUM_CTX}
        chunks = split_lines(lines)
        if len(chunks) == 1:
            stream = self.ollama.chat_stream(
                model, final_summary_messages(lines, context), think=True, options=options
            )
            text = (await self._send_stream(stream, send)).strip()
            return text, text

        # 部分ごとに要約する（送らない）。これがそのまま「詳細」になる
        parts: list[str] = []
        for i, chunk in enumerate(chunks):
            previous = parts[-1][-PREVIOUS_CHARS:] if parts else None
            part = await self.ollama.chat(
                model,
                part_summary_messages(chunk, i, len(chunks), context, previous),
                think=True,
                options=options,
            )
            parts.append(part.strip())
        # 概要の材料。部分の要約を合わせてまだ長ければ、いくつかずつまとめるのを繰り返す
        digest = parts
        while len(digest) > 1 and sum(len(p) for p in digest) > CHUNK_CHARS:
            groups = split_lines(digest)
            if len(groups) == len(digest):
                # 1つずつにしかならない（どれも長い）なら、これ以上は縮まらないので概要に進む
                break
            digest = [
                (
                    await self.ollama.chat(
                        model,
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
            model, overview_messages(digest, context), think=True, options=options
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

        prefix は最初の1つに付けて送る（本文が1文字も来なければ送らない）。返す本文には含めない
        """
        out: list[str] = []
        async for part in stream:
            text = part if out else prefix + part
            out.append(part)
            await send({"type": "summary.delta", "kind": "final", "text": text})
        return "".join(out)
