"""設定で選べる値の API。spec 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.mock import MOCK_OLLAMA_MODELS
from remote_whisper.ollama import OllamaUnavailable

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
    return {
        "whisper": {"models": WHISPER_MODELS, "computeTypes": COMPUTE_TYPES},
        "ollama": {"models": ollama},
    }
