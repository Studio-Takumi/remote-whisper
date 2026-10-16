"""設定で選べる値の API。spec 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.mock import MOCK_OLLAMA_MODELS
from remote_whisper.ollama import OllamaUnavailable
from remote_whisper.settings import has_model

router = APIRouter(prefix="/api/settings")

WHISPER_MODELS = ["large-v3-turbo", "large-v3", "medium", "small"]
COMPUTE_TYPES = ["float16", "int8_float16", "int8"]


@router.get("/options")
async def get_options(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    """Whisper のモデル、Ollama のモデルと、それぞれが思考モードに対応しているか

    Ollama につながらなければ、Ollama のモデルは空の一覧にする（status の ollama が error になる）
    """
    if ctx.mock:
        ollama = MOCK_OLLAMA_MODELS
    else:
        try:
            ollama = await ctx.ollama.models()
        except OllamaUnavailable:
            ollama = []
    # 処理ごとのモデル（#178）のうち、Ollama に入っていないもの（setting.json の models のキー）。
    # 動かすときは代わりのモデルを使う。一覧を取れない（つながらない）ときは空
    installed = {m["name"] for m in ollama}
    models = ctx.settings.get().ollama.models.model_dump(by_alias=True)
    missing = (
        [key for key, name in models.items() if not has_model(installed, name)] if installed else []
    )
    # 最終の文字起こし（WhisperX）を作れるサーバーか（#121・#124。画面は作り直すボタンを出し分ける）
    final = ctx.final_transcriber is not None and ctx.final_transcriber.available()
    return {
        "whisper": {
            "models": WHISPER_MODELS,
            "computeTypes": COMPUTE_TYPES,
            "finalTranscript": final,
        },
        "ollama": {"models": ollama, "missing": missing},
    }
