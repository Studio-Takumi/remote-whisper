"""最終の要約とタイトル。spec 6.3・6.5

録音を終えたあと、GPU キュー（優先度 3）から呼ばれる。

1. ほかに録音中のセッションがなければ、Whisper を VRAM から下ろす（spec 6.3）
2. 文字起こし全体が num_ctx に収まれば一度に、収まらなければ部分ごとに要約してまとめる
   （map-reduce）。思考モードはオン（モデルが対応していれば）。
   まとめの段だけ `summary.delta`（final）で送る
3. タイトルを別のリクエストで作る（JSON Schema で15文字以内）
4. `summary-<ID>-<生成 ID>.md` に保存して途中の要約を消し、選んだディレクトリにコピーを置く
5. `title`（provisional: false）を送る（ブラウザは保存されたものを取り直す）

Ollama につながらなければ ollama_unavailable を送り、途中の要約は残す（作り直しは #28）。
"""

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from remote_whisper.documents import parse
from remote_whisper.live_summary import load_context
from remote_whisper.ollama import OllamaClient, OllamaUnavailable, ollama_error
from remote_whisper.prompts import (
    TITLE_MAX,
    final_summary_messages,
    make_title,
    part_summary_messages,
    reduce_summary_messages,
)
from remote_whisper.session_writer import SessionWriter
from remote_whisper.settings import SettingsStore
from remote_whisper.timeutil import now

log = logging.getLogger(__name__)

# Ollama に渡すコンテキストの長さ（トークン）。Ollama の既定は小さいので、明示する
NUM_CTX = 8192
# 一度に渡す文字起こしの長さ（文字）。日本語は1文字がおよそ1トークンなので、
# 指示・コンテキスト・出力（思考を含む）の分を残して、num_ctx の半分ほどにする
CHUNK_CHARS = 4000


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
        self, writer: SessionWriter, send: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> str | None:
        """最終の要約を作って保存する。生成 ID を返す（作れなければ None）"""
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
        model = self.settings.get().ollama.final_summary_model
        context = (
            load_context(writer.files.dir, writer.meta.context_set) if writer.use_context else None
        )
        try:
            think = await self.ollama.supports_thinking(model)
            text = await self._summarize(model, lines, context, send)
            if not text:
                raise OllamaUnavailable("要約が空でした")
        except OllamaUnavailable as e:
            log.warning("final summary of %s failed: %s", writer.id, e)
            await send(ollama_error("最終の要約"))
            return None
        await send({"type": "summary.done", "kind": "final"})

        try:
            title = await make_title(self.ollama, model, text)
        except OllamaUnavailable as e:
            log.warning("title of %s failed: %s", writer.id, e)
            title = None
        # 作れなければ、仮のタイトルか要約の最初の行を使う
        title = title or writer.meta.title or fallback_title(text)
        try:
            if title:
                writer.set_title(title)
            gid = writer.save_final_summary(model, think, text, generated=started)
        except OSError:
            log.exception("failed to save the final summary of %s", writer.id)
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
        await send({"type": "title", "title": writer.meta.title or "", "provisional": False})
        return gid

    async def _summarize(
        self,
        model: str,
        lines: list[str],
        context: str | None,
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> str:
        options = {"num_ctx": NUM_CTX}
        chunks = split_lines(lines)
        if len(chunks) == 1:
            messages = final_summary_messages(lines, context)
        else:
            # map: 部分ごとに要約する（送らない）。reduce: まとめたものを送る
            parts = []
            for i, chunk in enumerate(chunks):
                part = await self.ollama.chat(
                    model,
                    part_summary_messages(chunk, i, len(chunks), context),
                    think=True,
                    options=options,
                )
                parts.append(part.strip())
            # 部分の要約を合わせてもまだ長ければ、いくつかずつまとめるのを繰り返す
            while len(parts) > 1 and sum(len(p) for p in parts) > CHUNK_CHARS:
                groups = split_lines(parts)
                if len(groups) == len(parts):
                    # 1つずつにしかならない（どれも長い）なら、これ以上は縮まらないのでまとめに進む
                    break
                parts = [
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
            messages = reduce_summary_messages(parts, context)
        out: list[str] = []
        async for part in self.ollama.chat_stream(model, messages, think=True, options=options):
            out.append(part)
            await send({"type": "summary.delta", "kind": "final", "text": part})
        return "".join(out).strip()
