"""LM Studio のクライアント（`llm.LlmClient` の実装）。spec/notes.md 9.3

役割ごとに、`lmstudio_http`（接続）・`lmstudio_models`（一覧と能力）・`lmstudio_vram`（載せ下ろし）・
`lmstudio_chat`（生成）・`lmstudio_schema`（頼みの形と返事の確かめ）に分け、ここでモデルの取得を足す。
"""

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from remote_whisper.llm.llm import PullProgress
from remote_whisper.llm.lmstudio_chat import LMStudioChat
from remote_whisper.llm.lmstudio_http import LMStudioUnavailable, log
from remote_whisper.llm.lmstudio_schema import SchemaMismatch as SchemaMismatch
from remote_whisper.llm.lmstudio_schema import conform as conform
from remote_whisper.llm.lmstudio_schema import parse_structured as parse_structured

# モデルを取っている間、進み具合を見に行く間隔（秒）
DOWNLOAD_POLL_SEC = 1.0
# 取り終えたモデルが一覧に出るまで見に行く回数（DOWNLOAD_POLL_SEC ごと）
DOWNLOAD_LIST_TRIES = 15
# 取った量が増えないまま、この時間（秒）たったら見るのをやめる（LM Studio 側で止まったなど）
DOWNLOAD_STALL_SEC = 600.0
# 見続ける取得の status（`completed`・`failed` とこれ以外の status では見るのをやめる）
DOWNLOAD_RUNNING = "downloading"


def lmstudio_error(what: str) -> dict[str, Any]:
    """要約などを作れなかったことをブラウザに伝えるメッセージ"""
    return {
        "type": "error",
        "code": "lmstudio_unavailable",
        "message": f"LM Studio に接続できないため、{what}を作れませんでした",
    }


class LMStudioClient(LMStudioChat):
    """`llm.LlmClient` の LM Studio での実装。モデルの取得（#327）はここ"""

    async def _wait_listed(self, model: str) -> None:
        """取り終えたモデルが一覧（GET /api/v1/models）に出るまで、少し待つ

        0.4.28 では、completed になった直後の一覧にはまだ出なかった（数秒後には出る）。
        出ないまま終えると、画面が「入っていません」のままになるため。出なければ諦める"""
        for _ in range(DOWNLOAD_LIST_TRIES):
            if model in await self._llms(fresh=True):
                return
            await self._sleep(DOWNLOAD_POLL_SEC)
        log.warning("lmstudio downloaded %s but does not list it yet", model)

    async def pull(self, model: str) -> AsyncIterator[PullProgress]:
        """モデルを取ってくる（#327）。進み具合を、ジョブを 1 つの部分（digest は job_id）として返す

        失敗（カタログにない・LM Studio が failed を返した・つながらない）は LMStudioUnavailable。
        止める API がないので、呼んだ側がやめても（CancelledError）LM Studio は取り続ける"""
        data = await self._request("POST", "/api/v1/models/download", json={"model": model})
        job_id = data.get("job_id")
        if data.get("status") == "already_downloaded" or not job_id:
            self._forget_list()
            yield {"status": "success"}
            return
        job_id = str(job_id)
        log.info("lmstudio is downloading %s (%s)", model, job_id)
        # 取った量が最後に増えた時刻（進まないまま DOWNLOAD_STALL_SEC たったら諦める）
        last_done, moved_at = -1, self._clock()
        try:
            while True:
                await self._sleep(DOWNLOAD_POLL_SEC)
                data = await self._request("GET", f"/api/v1/models/download/status/{job_id}")
                state = str(data.get("status") or "")
                total = int(data.get("total_size_bytes") or 0)
                done = int(data.get("downloaded_bytes") or 0)
                if state == "completed":
                    if total:
                        yield {
                            "status": state,
                            "digest": job_id,
                            "total": total,
                            "completed": total,
                        }
                    await self._wait_listed(model)
                    yield {"status": "success"}
                    return
                if state == "failed":
                    raise LMStudioUnavailable(f"lmstudio failed to download {model}")
                if state == "paused":
                    # LM Studio の画面で一時停止した。見続けると、ほかの取得も始められないままになる
                    raise LMStudioUnavailable(
                        f"lmstudio paused downloading {model}",
                        detail="LM Studio で一時停止されています。"
                        "LM Studio の画面で再開してください",
                    )
                if state != DOWNLOAD_RUNNING:
                    # 知らない status（版によって増えうる。取り消したなど）
                    raise LMStudioUnavailable(
                        f"lmstudio stopped downloading {model} ({state or 'no status'})",
                        detail="LM Studio で取得が止まりました。LM Studio の画面で確かめてください",
                    )
                if done != last_done:
                    last_done, moved_at = done, self._clock()
                elif self._clock() - moved_at >= DOWNLOAD_STALL_SEC:
                    raise LMStudioUnavailable(
                        f"lmstudio made no progress downloading {model} "
                        f"for {DOWNLOAD_STALL_SEC:.0f} seconds",
                        detail="LM Studio の取得が進まないため、見るのをやめました。"
                        "LM Studio の画面で確かめてください",
                    )
                if total:
                    yield {"status": state, "digest": job_id, "total": total, "completed": done}
                else:
                    yield {"status": state}
        except asyncio.CancelledError:
            log.info(
                "stopped watching the download of %s; lmstudio keeps downloading it "
                "(it has no API to stop downloads)",
                model,
            )
            raise
