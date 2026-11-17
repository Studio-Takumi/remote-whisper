"""LM Studio のモデルの一覧（3 秒の覚え）と能力・代わりのモデル選び。spec/notes.md 9.3"""

import contextlib
from typing import Any

from remote_whisper.llm.lmstudio_http import LMStudioHttp, LMStudioUnavailable, log
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


class LMStudioModels(LMStudioHttp):
    """入っているモデルの一覧と能力"""

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        # モデル名 → capabilities。入れ直すことはまれなので覚えておく
        self._capabilities: dict[str, dict[str, Any]] = {}
        # このクライアントが載せたインスタンス → 載せたときの context_length（これだけを下ろす）。
        # 手で載せたものは下ろさない（一覧と食い違うものは _forget_gone で忘れる）
        self._loaded: dict[str, int] = {}
        # 入っていなかったモデル（ログに書いたもの。何度も書かない）
        self._missing: set[str] = set()
        # 覚えている一覧（名前 → 項目）と、取った時刻。_list_version は一覧を取っている間に
        # 載せ下ろししたら、古い一覧で上書きしないため
        self._list: dict[str, dict[str, Any]] | None = None
        self._list_at = 0.0
        self._list_version = 0

    def _forget_list(self) -> None:
        """覚えている一覧を捨てる（JIT で載ったなど、中身が分からなくなったとき）"""
        self._list = None
        self._list_version += 1

    async def _llms(self, fresh: bool = False) -> dict[str, dict[str, Any]]:
        """入っている LLM（埋め込みのモデルは除く）。名前（key）→ 一覧の項目。能力も覚える

        LIST_TTL 秒のあいだは、前に取った一覧を返す（fresh なら取り直す）"""
        if not fresh and self._list is not None and self._clock() - self._list_at < LIST_TTL:
            return self._list
        version = self._list_version
        data = await self._request("GET", "/api/v1/models")
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
            self._forget_gone(llms)
        return llms

    def _forget_gone(self, llms: dict[str, dict[str, Any]]) -> None:
        """自分が載せた記録のうち、一覧に載っていないもの・context が食い違うものを忘れる

        自分の `<key>` を手で下ろしたあと、同じモデルを手で載せ直すと、新しいインスタンスも
        同じ `<key>` になる。記録を残したままだと、手で載せたほうを下ろしてしまうため。
        同じ context で載せ直されて、その間に一覧を取らなかったときは見分けられない"""
        listed = {iid: ctx for entry in llms.values() for iid, ctx in entry_instances(entry)}
        for iid, ctx in list(self._loaded.items()):
            if iid not in listed:
                log.info("lmstudio %s is no longer loaded; forgetting it", iid)
            elif listed[iid] != ctx:
                log.warning(
                    "lmstudio %s is now loaded with context %d instead of %d (by hand?); "
                    "not unloading it",
                    iid,
                    listed[iid],
                    ctx,
                )
            else:
                continue
            del self._loaded[iid]

    def _listed_loaded(self, model: str, iid: str, ctx: int) -> None:
        """自分で載せたインスタンスを、覚えている一覧にも足す"""
        self._list_version += 1
        entry = (self._list or {}).get(model)
        if entry is not None:
            instances = list(entry.get("loaded_instances") or [])
            instances.append({"id": iid, "config": {"context_length": ctx}})
            entry["loaded_instances"] = instances

    def _listed_unloaded(self, iid: str) -> None:
        """下ろしたインスタンスを、覚えている一覧からも消す"""
        self._list_version += 1
        for entry in (self._list or {}).values():
            instances = entry.get("loaded_instances") or []
            entry["loaded_instances"] = [
                inst for inst in instances if (inst.get("id") or inst.get("instance_id")) != iid
            ]

    async def models(self) -> list[dict[str, Any]]:
        """入っているモデルと、思考モードを使い分けられるか。つながらなければ LMStudioUnavailable"""
        names = sorted(await self._llms(fresh=True))
        return [{"name": name, "thinking": await self.supports_thinking(name)} for name in names]

    async def installed(self) -> set[str]:
        """入っているモデルの名前。つながらなければ LMStudioUnavailable"""
        return set(await self._llms(fresh=True))

    async def resolve(self, model: str) -> str:
        """動かすモデル。入っていなければ、要約詳細のモデル → 全体概要のモデル →
        入っているうち最初のもの、の順に代わりを選ぶ（#178。Ollama と同じ考え方）

        一覧を取れない・何も入っていないときは、そのまま返す（呼んだ先で失敗する）。
        要約詳細・全体概要のモデルは lmstudio.models から読む（#325）。一覧は覚えているものを使う
        （続けて載っているかを見るときに、取り直さない）
        """
        try:
            installed = set(await self._llms())
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
                await self._llms()
        return self._capabilities.get(model, {})

    async def _reasoning_options(self, model: str) -> set[str] | None:
        """思考モードの選べる値。思考しないモデルは None"""
        reasoning = (await self._capabilities_of(model)).get("reasoning")
        if not isinstance(reasoning, dict):
            return None
        return {str(o) for o in reasoning.get("allowed_options") or []}

    async def supports_thinking(self, model: str) -> bool:
        """思考モードを使い分けられるか（allowed_options に on と off の両方がある。#322）

        分からなければ False"""
        options = await self._reasoning_options(model)
        return options is not None and {"on", "off"} <= options

    async def supports_vision(self, model: str) -> bool:
        """capabilities.vision が true か（画像を読めるか）。分からなければ False"""
        return (await self._capabilities_of(model)).get("vision") is True
