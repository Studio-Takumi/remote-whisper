"""設定で選べる値の API。spec 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.mock import MOCK_OLLAMA_MODELS

router = APIRouter(prefix="/api/settings")

WHISPER_MODELS = ["large-v3-turbo", "large-v3", "medium", "small"]
COMPUTE_TYPES = ["float16", "int8_float16", "int8"]


@router.get("/options")
async def get_options(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    """Whisper のモデル、Ollama のモデルと、それぞれが思考モードに対応しているか"""
    # 本物の Ollama のモデル一覧は #25 で取るようにする
    ollama = MOCK_OLLAMA_MODELS if ctx.mock else []
    return {
        "whisper": {"models": WHISPER_MODELS, "computeTypes": COMPUTE_TYPES},
        "ollama": {"models": ollama},
    }
