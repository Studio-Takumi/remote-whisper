"""LM Studio のモデルの一覧（3 秒の覚え）と能力・代わりのモデル選び。spec/notes.md 9.3"""

import contextlib
import time
from collections.abc import Callable
from typing import Any

from remote_whisper.llm.lmstudio_http import LMStudioHttp, LMStudioUnavailable, log
from remote_whisper.settings import SettingsStore
from remote_whisper.summary.summary_parts import NUM_CTX

# 一覧（GET /api/v1/models）を覚えておく時間（秒）。生成 1 回で何度も取らないため
LIST_TTL = 3.0


def entry_instances(entry: dict[str, Any]) -> list[tuple[str, int]]:
    """載っているインスタンスの（id, context_length）"""
    result = []
    for inst in entry.get("loaded_instances") or []:
        iid = inst.get("id") or inst.get("instance_id")
        ctx = (inst.get("config") or {}).get("context_length")
        if iid:
            result.append((str(iid), int(ctx or 0)))
    return result


def usable_instance(instances: list[tuple[str, int]]) -> tuple[str, int] | None:
    """生成に使えるインスタンス（NUM_CTX 以上）。NUM_CTX ちょうどを優先する"""
    usable = sorted(
        ((iid, ctx) for iid, ctx in instances if ctx >= NUM_CTX),
        key=lambda x: (x[1] != NUM_CTX, x[1]),
    )
    return usable[0] if usable else None


class ModelList:
    """入っているモデルの一覧（短く覚える）と能力・代わりのモデル選び"""

    def __init__(
        self,
        http: LMStudioHttp,
        settings: SettingsStore,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.http = http
        self.settings = settings
        self._clock = clock
        # 一覧を取り直したとき、その一覧を渡す（Vram が、自分が載せた記録の掃除に使う）
        self.on_listed: Callable[[dict[str, dict[str, Any]]], None] | None = None
        # モデル名 → capabilities。入れ直すことはまれなので覚えておく
        self._capabilities: dict[str, dict[str, Any]] = {}
        # 入っていなかったモデル（ログに書いたもの。何度も書かない）
        self._missing: set[str] = set()
        # 覚えている一覧（名前 → 項目）と、取った時刻。_list_version は一覧を取っている間に
        # 載せ下ろししたら、古い一覧で上書きしないため
        self._list: dict[str, dict[str, Any]] | None = None
        self._list_at = 0.0
        self._list_version = 0

    def forget(self) -> None:
        """覚えている一覧を捨てる（JIT で載ったなど、中身が分からなくなったとき）"""
        self._list = None
        self._list_version += 1

    async def llms(self, fresh: bool = False) -> dict[str, dict[str, Any]]:
        """入っている LLM（埋め込みは除く）。名前（key）→ 一覧の項目。
        LIST_TTL 秒は前の一覧を返す（fresh なら取り直す）"""
        if not fresh and self._list is not None and self._clock() - self._list_at < LIST_TTL:
            return self._list
        version = self._list_version
        data = await self.http.request("GET", "/api/v1/models")
        llms = {
            str(m["key"]): m
            for m in data.get("models") or []
            if m.get("type") == "llm" and m.get("key")
        }
        for key, m in llms.items():
            self._capabilities[key] = dict(m.get("capabilities") or {})
        if version == self._list_version:
            # 取っている間に載せ下ろししていなければ、一覧は今の状態を表している
            self._list, self._list_at = llms, self._clock()
            if self.on_listed is not None:
                self.on_listed(llms)
        return llms

    def listed_loaded(self, model: str, iid: str, ctx: int) -> None:
        """自分で載せたインスタンスを、覚えている一覧にも足す"""
        self._list_version += 1
        entry = (self._list or {}).get(model)
        if entry is not None:
            instances = list(entry.get("loaded_instances") or [])
            instances.append({"id": iid, "config": {"context_length": ctx}})
            entry["loaded_instances"] = instances

    def listed_unloaded(self, iid: str) -> None:
        """下ろしたインスタンスを、覚えている一覧からも消す"""
        self._list_version += 1
        for entry in (self._list or {}).values():
            instances = entry.get("loaded_instances") or []
            entry["loaded_instances"] = [
                inst for inst in instances if (inst.get("id") or inst.get("instance_id")) != iid
            ]

    async def models(self) -> list[dict[str, Any]]:
        """入っているモデルと、思考モードを使い分けられるか。つながらなければ LMStudioUnavailable"""
        names = sorted(await self.llms(fresh=True))
        return [{"name": name, "thinking": await self.supports_thinking(name)} for name in names]

    async def installed(self) -> set[str]:
        """入っているモデルの名前。つながらなければ LMStudioUnavailable"""
        return set(await self.llms(fresh=True))

    async def resolve(self, model: str) -> str:
        """動かすモデル。入っていなければ 要約詳細 → 全体概要 → 入っているうち最初のもの、
        の順に代える（#178）"""
        try:
            installed = set(await self.llms())
        except LMStudioUnavailable:
            return model
        if not installed or model in installed:
            return model
        models = self.settings.get().lmstudio.models
        alternative = next(
            m for m in (models.detail, models.overview, *sorted(installed)) if m in installed
        )
        if model not in self._missing:
            log.warning("lmstudio model %s is not installed; using %s instead", model, alternative)
            self._missing.add(model)
        return alternative

    async def _capabilities_of(self, model: str) -> dict[str, Any]:
        """一覧の capabilities。つながらない・モデルがなければ空（覚えない）"""
        if model not in self._capabilities:
            with contextlib.suppress(LMStudioUnavailable):
                await self.llms()
        return self._capabilities.get(model, {})

    async def reasoning_options(self, model: str) -> set[str] | None:
        """思考モードの選べる値。思考しないモデルは None"""
        reasoning = (await self._capabilities_of(model)).get("reasoning")
        if not isinstance(reasoning, dict):
            return None
        return {str(o) for o in reasoning.get("allowed_options") or []}

    async def supports_thinking(self, model: str) -> bool:
        """思考モードを使い分けられるか（allowed_options に on と off の両方がある。#322）。
        分からなければ False"""
        options = await self.reasoning_options(model)
        return options is not None and {"on", "off"} <= options

    async def supports_vision(self, model: str) -> bool:
        """capabilities.vision が true か（画像を読めるか）。分からなければ False"""
        return (await self._capabilities_of(model)).get("vision") is True
