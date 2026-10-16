"""録音中に文字起こしから用語を拾い、用語リスト（hotwords）に足す。spec 6.2・6.6（#103）

- 途中の要約と同じ間隔（liveSummaryIntervalMin。録音した長さで数える）で、前回から増えた
  文字起こしから、固有名詞・専門用語を Ollama で抜き出す（JSON Schema。思考モードはオフ）
- 誤認識した語を足すとその誤りが固まるので、文字起こしの MIN_LINES 行以上に出てくる語だけを
  採用する。消された語（rejected）は以後足さない
- 参考資料セットの用語のあとに、出てくる行が多い順に足し、Whisper に渡す長さの上限
  （HOTWORDS_MAX_CHARS）に収める
- 拾った語と消された語は、文字起こしのフロントマターに残し、`terms` で画面に知らせる
- GPU キューには優先度 2 で積む。Ollama につながらなければ、次の回に拾い直す
"""

import asyncio
import contextlib
import logging
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.ollama import OllamaClient, OllamaUnavailable
from remote_whisper.prompts import TERMS_FORMAT, TERMS_MAX, parse_terms, terms_messages
from remote_whisper.session_writer import SessionWriter, fmt_clock
from remote_whisper.settings import SettingsStore
from remote_whisper.summary_parts import CHUNK_CHARS, NUM_CTX

log = logging.getLogger(__name__)

# 時間がたったかを確かめる間隔（秒）
CHECK_INTERVAL = 1.0
# 採用するのは、文字起こしのこの行数以上に出てくる語だけ（1回しか出ない語・誤認識を固めないため）
MIN_LINES = 2
# 語の長さ（文字）。短すぎる語は一般的な言葉と区別しにくい
MIN_CHARS = 2
MAX_CHARS = 20
# Whisper に渡す用語リストの長さの上限（文字）。hotwords と initial_prompt を合わせて約 224 トークン
# （spec 6.6）なので、日本語の 1 文字を 1 トークンとみて余裕を残す
HOTWORDS_MAX_CHARS = 200
# 用語として足すのは、語のうちカタカナ（3 文字以上）かラテン文字（2 文字以上）が続くところだけ
_DISTINCT_RUN = re.compile(r"[ァ-ヺー・]{3,}|[A-Za-z][A-Za-z0-9.+\-]+")
# よく使うカタカナ語。用語リストに足しても役に立たず、枠を使ってしまう
COMMON_WORDS = frozenset(
    [
        "チーム",
        "データ",
        "スケジュール",
        "リスク",
        "システム",
        "サーバー",
        "ツール",
        "プロジェクト",
        "ミーティング",
        "メンバー",
        "テスト",
        "ユーザー",
        "サービス",
        "アプリ",
        "メール",
        "ファイル",
        "タスク",
        "レビュー",
        "コスト",
        "ポイント",
    ]
)


def combine_hotwords(base: str | None, picked: list[str]) -> str | None:
    """参考資料セットの用語（base、「、」区切り）のあとに、拾った語を上限まで足す"""
    words = [w for w in (base or "").split("、") if w]
    for word in picked:
        if word in words:
            continue
        if len("、".join([*words, word])) > HOTWORDS_MAX_CHARS:
            break
        words.append(word)
    return "、".join(words) or None


class TermPicker:
    def __init__(
        self,
        ollama: OllamaClient,
        gpu: GpuQueue,
        settings: SettingsStore,
        writer: SessionWriter,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        elapsed: Callable[[], float],
        on_change: Callable[[list[str]], None],
        check_interval: float = CHECK_INTERVAL,
    ):
        """on_change は、拾った語が変わったときに呼ぶ（録音中の hotwords を差し替える）"""
        self.ollama = ollama
        self.gpu = gpu
        self.settings = settings
        self.writer = writer
        self.send = send
        self.elapsed = elapsed
        self.on_change = on_change
        # 確定した区間（録音の開始からの秒数, 本文）
        self.finals: list[tuple[float, str]] = []
        # 続きを録音するときは、前に拾った語と消された語を引き継ぐ
        self.picked: list[str] = list(writer.meta.picked_terms)
        self.rejected: set[str] = set(writer.meta.rejected_terms)
        self._done = 0  # 拾い終えた final の数
        self._last_at = 0.0
        self._job: asyncio.Future | None = None
        self._loop = asyncio.create_task(self._watch(check_interval))

    def add_final(self, start: float, text: str) -> None:
        self.finals.append((start, text))

    def restart_at(self, elapsed: float, done: int) -> None:
        """続きを録音するとき。前の文字起こしは拾い終えたものとして、ここから数える"""
        self._last_at = elapsed
        self._done = done

    async def close(self) -> None:
        self._loop.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._loop

    async def wait(self) -> None:
        if self._job is not None:
            await asyncio.gather(self._job, return_exceptions=True)

    async def _watch(self, interval: float) -> None:
        while True:
            await asyncio.sleep(interval)
            if self._job is not None and not self._job.done():
                continue
            minutes = self.settings.get().ollama.live_summary_interval_min
            if self.elapsed() - self._last_at < minutes * 60 or len(self.finals) <= self._done:
                continue
            self._last_at = self.elapsed()
            self._job = self.gpu.submit(
                Priority.LIVE_SUMMARY, self.run, kind="terms", session=self.writer.id
            )
            self._job.add_done_callback(_consume)

    def count_lines(self, word: str) -> int:
        """その語が出てくる文字起こしの行の数"""
        return sum(1 for _, text in self.finals if word in text)

    async def run(self) -> None:
        """前回から増えた文字起こしから用語を拾い、条件に合うものを足す"""
        upto = len(self.finals)
        if upto <= self._done:
            return
        lines = [f"[{fmt_clock(s)}] {t}" for s, t in self.finals[self._done : upto]]
        # 長すぎるときは新しい方を渡す（拾った語は、文字起こし全体で数え直す）
        while len(lines) > 1 and sum(len(x) for x in lines) > CHUNK_CHARS:
            lines.pop(0)
        model = self.settings.get().ollama.models.transcript_terms
        started = time.monotonic()
        log.info("terms of %s started with %s (%d lines)", self.writer.id, model, len(lines))
        try:
            reply = await self.ollama.chat(
                model,
                terms_messages(lines),
                think=False,
                format=TERMS_FORMAT,
                options={"num_ctx": NUM_CTX},
            )
        except OllamaUnavailable as e:
            # 次の回に、同じ範囲をもう一度拾う
            log.warning("terms of %s failed: %s", self.writer.id, e)
            return
        self._done = upto
        candidates = [*self.picked, *parse_terms(reply)]
        # 長い録音では全行に正規表現をかけるので、音声の受け取りを止めないよう別のスレッドで
        picked = await asyncio.to_thread(self.select, candidates)
        # 選んでいる間に画面で消された語は除く
        picked = [w for w in picked if w not in self.rejected]
        added = [w for w in picked if w not in self.picked]
        # 語そのものは書かない（文字起こしの中身なので。セッションのフロントマターに残っている）
        log.info(
            "terms of %s done in %.1fs (%d added, %d in all)",
            self.writer.id,
            time.monotonic() - started,
            len(added),
            len(picked),
        )
        if picked != self.picked:
            await self._update(picked)

    def select(self, candidates: list[str]) -> list[str]:
        """採用する語を、出てくる行が多い順に選ぶ

        誤認識を固めないよう、次のようにする（#103 で測って決めた）
        - 語のうち、カタカナ（3 文字以上）かラテン文字が続くところだけを使う。漢字・ひらがなの
          ところは、同音の誤認識（負荷→付加、基盤→基板など）と見分けられず、足すとその誤りが
          固まった（ゼフィール基板 → ゼフィール）。漢字の用語は参考資料セットから入れる
        - 文字起こしの MIN_LINES 行未満にしか出てこない語は足さない
        - よく使うカタカナ語（チーム・データなど。用語リストの枠を使ってしまう）は足さない
        - 1 文字だけ違う書き方が文字起こしに同じくらい出てくる語は足さない（どちらが正しいか
          分からない）
        - ほかに採用した語に含まれる短い語は足さない
        """
        counts: dict[str, int] = {}
        # 語のうち、カタカナかラテン文字のところだけを使う（ハルシオン計画 → ハルシオン）
        parts = [p for word in candidates for p in _DISTINCT_RUN.findall(word)]
        for word in parts:
            if word in counts or word in self.rejected or word in COMMON_WORDS:
                continue
            if not MIN_CHARS <= len(word) <= MAX_CHARS:
                continue
            n = self.count_lines(word)
            if n >= MIN_LINES and n >= 2 * self._variant_lines(word):
                counts[word] = n
        ranked = sorted(counts, key=lambda w: -counts[w])
        kept = [w for w in ranked if not any(w != o and w in o for o in ranked)]
        return kept[:TERMS_MAX]

    def _variant_lines(self, word: str) -> int:
        """1 文字だけ違う書き方が出てくる行の数（いちばん多いもの）"""
        best = 0
        for i in range(len(word)):
            pattern = re.compile(re.escape(word[:i]) + "(.)" + re.escape(word[i + 1 :]))
            # count_lines と同じく、回数ではなく出てくる行の数で比べる
            variants: dict[str, int] = {}
            for _, text in self.finals:
                found = {m.group(0) for m in pattern.finditer(text) if m.group(1) != word[i]}
                for variant in found:
                    variants[variant] = variants.get(variant, 0) + 1
            best = max(best, *variants.values(), 0)
        return best

    async def reject(self, word: str) -> None:
        """画面で消された語。以後は足さない"""
        self.rejected.add(word)
        await self._update([w for w in self.picked if w != word])

    async def _update(self, picked: list[str]) -> None:
        self.picked = picked
        self.on_change(picked)
        try:
            self.writer.set_terms(picked, sorted(self.rejected))
        except OSError:
            log.exception("failed to save the terms of %s", self.writer.id)
        await self.send({"type": "terms", "terms": picked, "rejected": sorted(self.rejected)})


def _consume(future: asyncio.Future) -> None:
    if not future.cancelled() and future.exception() is not None:
        log.warning("term picking job failed: %s", future.exception())
