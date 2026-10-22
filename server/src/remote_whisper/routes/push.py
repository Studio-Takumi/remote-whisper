"""最終要約ができたときの通知（Web Push）の API（#245）。spec/api.md 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.push import Subscription

router = APIRouter(prefix="/api/push")

Ctx = Annotated[AppContext, Depends(get_ctx)]


def _push(ctx: AppContext):
    if ctx.push is None:
        raise HTTPException(status_code=404, detail="このサーバーでは通知を使えません")
    return ctx.push


@router.get("/key")
def get_key(ctx: Ctx) -> dict[str, Any]:
    """ブラウザが購読するときの applicationServerKey（VAPID の公開鍵）。秘密鍵は渡さない"""
    return {"publicKey": _push(ctx).public_key()}


@router.post("/subscriptions", status_code=204)
def add_subscription(body: dict[str, Any], ctx: Ctx) -> None:
    """ブラウザの PushSubscription.toJSON() をそのまま受け取る。同じ送り先は置き換える"""
    push = _push(ctx)
    try:
        subscription = Subscription.from_json(body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    push.add(subscription)


@router.delete("/subscriptions", status_code=204)
def delete_subscription(ctx: Ctx, endpoint: Annotated[str, Query(max_length=2048)]) -> None:
    """通知をやめる（その端末の設定をオフにした）。なければ何もしない"""
    _push(ctx).remove(endpoint)
