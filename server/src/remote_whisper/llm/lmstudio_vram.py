"""LM Studio のモデルの載せ下ろし（ロック・録音中は 1 つだけ・keepAliveMin のタイマー）。

spec/notes.md 9.3（#326）。自分が載せたインスタンス（`loaded`）を持つのはここだけ"""

import asyncio
import contextlib
import time
from collections.abc import Awaitable, Callable, Iterator
from typing import Any

from remote_whisper.llm.lmstudio_http import LOAD_TIMEOUT, LMStudioHttp, LMStudioUnavailable, log
from remote_whisper.llm.lmstudio_models import ModelList, entry_instances, usable_instance
from remote_whisper.settings import SettingsStore
from remote_whisper.summary.summary_parts import NUM_CTX


class Vram:
    """自分が載せたインスタンスだけを載せ下ろしする"""

    def __init__(
        self,
        http: LMStudioHttp,
        models: ModelList,
        settings: SettingsStore,
        recording: Callable[[], bool] = lambda: False,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        """clock・sleep は、保持の時間のタイマーに使う（テストで差し替える）"""
        self.http = http
        self.models = models
        self.settings = settings
        # 録音中かどうか（録音中は下ろさない・1 つだけ載せる）
        self.recording = recording
        self._clock = clock
        self._sleep = sleep
        # このクライアントが載せたインスタンス → 載せたときの context_length（これだけを下ろす）。
        # 手で載せたものは下ろさない（一覧と食い違うものは _forget_gone で忘れる）
        self.loaded: dict[str, int] = {}
        # context の小さいインスタンス・手で載せたインスタンス（ログに書いたもの。何度も書かない）
        self._small: set[str] = set()
        self._manual: set[str] = set()
        # 載せ下ろしのロック。同時に load して 2 つ載らないように、また下ろしている途中の
        # インスタンスを生成に使わないように、選ぶ・載せる・下ろすは 1 つずつにする
        self._vram = asyncio.Lock()
        # 生成している途中の数と、最後に使った時刻（保持の時間のタイマー）
        self._active = 0
        self._last_used = clock()
        self._timer: asyncio.Task | None = None
        models.on_listed = self._forget_gone

    def note_loaded(self, iid: str, ctx: int) -> None:
        """生成の途中で LM Studio が読み込んだ（JIT）インスタンスを、自分が載せたものに数える"""
        self.loaded[iid] = ctx

    @contextlib.contextmanager
    def generating(self) -> Iterator[None]:
        """生成している間はタイマーで下ろさない。終わったら、そこから keepAliveMin 分を数え直す

        録音中は数えない（録音が終わったとき（recording_ended）に数え始める）"""
        self._active += 1
        try:
            yield
        finally:
            self._active -= 1
            if not self.recording():
                self._touch()

    def _forget_gone(self, llms: dict[str, dict[str, Any]]) -> None:
        """自分が載せた記録のうち、一覧に載っていないもの・context が食い違うものを忘れる

        自分の `<key>` を手で下ろしたあと、同じモデルを手で載せ直すと、新しいインスタンスも
        同じ `<key>` になる。記録を残したままだと、手で載せたほうを下ろしてしまうため。
        同じ context で載せ直されて、その間に一覧を取らなかったときは見分けられない"""
        listed = {iid: ctx for entry in llms.values() for iid, ctx in entry_instances(entry)}
        for iid, ctx in list(self.loaded.items()):
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
            del self.loaded[iid]

    async def shutdown(self) -> None:
        """サーバーを止めるとき。見張りとタイマーを止め、自分が載せたインスタンスを下ろす

        止めたあとはタイマーで下ろせず、VRAM に残り続けるため（手で載せたものは下ろさない）。
        つながらなければ下ろさずに終える"""
        await self.http.close()
        if self._timer is not None and not self._timer.done():
            self._timer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._timer
        self._timer = None
        await self._unload_mine("the server is stopping")

    async def instance(self, model: str) -> tuple[str, int]:
        """生成に使うインスタンスの（id, context_length）。なければ載せる

        - NUM_CTX 以上で載っているものがあれば、それを使う（NUM_CTX ちょうどを優先）
        - なければ NUM_CTX で載せる（JIT に任せない。載せたインスタンスを覚えて、後で下ろすため）
        - 小さい context で載っているもの（手で載せたものなど）は下ろさず、もう 1 つ載せる。
          VRAM が溢れるかもしれないのでログに書く（#322）
        - 録音中は、その前に自分が載せたほかのインスタンスを下ろす（_unload_others）

        context_length は必ず NUM_CTX にそろえる。違う値を送ると、2 つ目のインスタンスが載る

        同時に呼ばれても 2 つ載せないよう、また下ろしている途中のものを選ばないよう、
        載せ下ろしのロックの中で選ぶ
        """
        async with self._vram:
            llms = await self.models.llms()
            entry = llms.get(model)
            instances = entry_instances(entry) if entry else []
            found = usable_instance(instances)
            if self.recording():
                await self._unload_others(llms, found[0] if found else None)
            if found:
                return found
            if instances and model not in self._small:
                log.warning(
                    "lmstudio has %s loaded with a context smaller than %d; loading another "
                    "instance, which may run out of VRAM",
                    model,
                    NUM_CTX,
                )
                self._small.add(model)
            data = await self.http.request(
                "POST",
                "/api/v1/models/load",
                timeout=LOAD_TIMEOUT,
                json={"model": model, "context_length": NUM_CTX},
            )
            sec = float(data.get("load_time_seconds") or 0)
            if data.get("instance_id"):
                iid = str(data["instance_id"])
                self.loaded[iid] = NUM_CTX
                self.models.listed_loaded(model, iid, NUM_CTX)
            else:
                # id が返らなかった（#322 では返る）。モデルの名前で代わりに覚えると、手で
                # 載せた `<key>` を自分のものとみなしてしまうので、一覧で増えた id を探す
                iid = await self._find_loaded(model, {i for i, _ in instances})
            log.info("lmstudio loaded %s in %.1fs", iid, sec)
            return iid, NUM_CTX

    async def _find_loaded(self, model: str, before: set[str]) -> str:
        """載せたのに id が返らなかったとき、載せる前になかった NUM_CTX のインスタンスを一覧から
        探して覚える。見つからなければ覚えずにログに書き、モデルの名前で生成する"""
        with contextlib.suppress(LMStudioUnavailable):
            entry = (await self.models.llms(fresh=True)).get(model)
            new = [
                iid
                for iid, ctx in (entry_instances(entry) if entry else [])
                if iid not in before and ctx == NUM_CTX
            ]
            if len(new) == 1:
                self.loaded[new[0]] = NUM_CTX
                return new[0]
        log.warning(
            "lmstudio loaded %s but did not tell its instance id; it will not be unloaded", model
        )
        self.models.forget()
        return model

    async def _unload_others(self, llms: dict[str, dict[str, Any]], keep: str | None) -> None:
        """録音中は、LM Studio のモデルを 1 つだけ載せておく（#178。Ollama の同名のものと同じ）

        自分が載せたインスタンスのうち、これから使う keep 以外を下ろす（録音の前に参考資料などで
        載せたものも）。手で載せたものは下ろさず、VRAM を使っているかもしれないとログに書く
        （インスタンスごとに 1 回）。下ろせなくても生成は試す。載せ下ろしのロックの中で呼ぶ"""
        for iid in sorted(set(self.loaded) - {keep}):
            if not await self._unload(iid, "to load another model while recording"):
                break
        manual = sorted(
            iid
            for entry in llms.values()
            for iid, _ in entry_instances(entry)
            if iid != keep and iid not in self.loaded and iid not in self._manual
        )
        if manual:
            log.warning(
                "lmstudio has %s loaded by hand; not unloading it, but it may use VRAM "
                "while recording",
                ", ".join(manual),
            )
            self._manual.update(manual)

    # --- 下ろす ---

    async def _unload(self, iid: str, why: str) -> bool:
        """自分が載せたインスタンスを 1 つ下ろす。つながらなければ False（記録は残し、次に下ろす）

        断られた（4xx。手で下ろされて、もう載っていないなど）ものは、記録から消す"""
        try:
            await self.http.request("POST", "/api/v1/models/unload", json={"instance_id": iid})
            log.info("lmstudio unloaded %s (%s)", iid, why)
        except LMStudioUnavailable:
            if self.http.is_down:
                return False
        self.loaded.pop(iid, None)
        self.models.listed_unloaded(iid)
        return True

    async def _unload_mine(self, why: str, stop: Callable[[], bool] = lambda: False) -> bool:
        """自分が載せたインスタンスをすべて下ろす

        先に一覧で、もう載っていないもの・手で載せ直されたものを忘れる（_forget_gone）。
        つながらなければ、残りも諦める（記録は残し、次に下ろす。止めるときに LM Studio が
        応答しないと、インスタンスごとに待たされるため）。stop() が True になったら、そこで
        やめて False を返す。インスタンスごとに確かめる"""
        async with self._vram:
            if not self.loaded:
                return True
            try:
                await self.models.llms()
            except LMStudioUnavailable:
                if self.http.is_down:
                    return True
            for iid in sorted(self.loaded):
                if stop():
                    return False
                if not await self._unload(iid, why):
                    break
        return True

    # --- 保持の時間（keepAliveMin）---

    def _keep_alive_sec(self) -> float:
        """下ろすまでの時間（秒）。Ollama と共通の ollama.keepAliveMin（#325）"""
        return self.settings.get().ollama.keep_alive_min * 60

    def _touch(self) -> None:
        """使った。ここから keepAliveMin 分たったら下ろすように、タイマーをかけ直す"""
        self._last_used = self._clock()
        if self._timer is None or self._timer.done():
            self._timer = asyncio.create_task(self._idle())

    def _in_use(self) -> bool:
        """録音中か、生成している途中（タイマーで下ろさない）"""
        return self.recording() or self._active > 0

    async def _idle(self) -> None:
        """最後に使ってから keepAliveMin 分たったら、自分が載せたものを下ろす

        録音中・生成の途中なら何もせずに終わる（録音が終わったとき・生成が終わったときに
        かけ直す）。待っている間に使われたら、そこから数え直す"""

        def used_again() -> bool:
            # 下ろすのを待っている間に使われた（生成の途中・録音中・数え直した）
            return self._in_use() or self._clock() - self._last_used < self._keep_alive_sec()

        while True:
            if self._in_use():
                return
            left = self._last_used + self._keep_alive_sec() - self._clock()
            if left > 0:
                await self._sleep(left)
                continue
            if await self._unload_mine("not used for keepAliveMin", stop=used_again):
                return

    async def unload_all(self, cancelled: Callable[[], bool] | None = None) -> None:
        """このクライアントが載せたインスタンスを下ろして VRAM を空ける（最終の文字起こしの前。
        #121。バックエンドを切り替えたときにも呼ぶ）

        手で載せたものは下ろさない。残っていれば、文字起こしが遅くなるかもしれないとログに書く。
        つながらなければ何もしない（記録は残し、次に下ろす）。断られた（4xx。もう載っていない
        など）ものは記録から消す。cancelled() が True になったら、次のインスタンスからは下ろさない
        （切り替えたバックエンドにすぐ戻したとき。LlmSwitch）。切り替えのとき（cancelled を
        渡したとき）は、使わなくなったバックエンドなので、手で載せたものを確かめない
        """
        done = await self._unload_mine("to free VRAM", stop=cancelled or (lambda: False))
        if not done or cancelled is not None or self.http.is_down:
            return
        with contextlib.suppress(LMStudioUnavailable):
            llms = await self.models.llms(fresh=True)
            manual = sorted(
                iid
                for entry in llms.values()
                for iid, _ in entry_instances(entry)
                if iid not in self.loaded
            )
            if manual:
                log.warning(
                    "lmstudio still has %s loaded by hand; not unloading it, but the "
                    "transcription may be slower while it uses VRAM",
                    ", ".join(manual),
                )

    async def recording_ended(self) -> None:
        """録音がすべて終わった。録音中は下ろさなかったので、ここから keepAliveMin 分を数える"""
        if not self.recording():
            self._touch()
