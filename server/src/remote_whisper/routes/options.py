"""設定で選べる値の API。spec/api.md 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.llm import LlmUnavailable, backend_of
from remote_whisper.mock import MOCK_LMSTUDIO_MODELS, MOCK_OLLAMA_MODELS
from remote_whisper.settings import has_model

router = APIRouter(prefix="/api/settings")

WHISPER_MODELS = ["large-v3-turbo", "large-v3", "medium", "small"]
COMPUTE_TYPES = ["float16", "int8_float16", "int8"]


@router.get("/options")
async def get_options(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    """Whisper のモデル、使っている LLM（Ollama か LM Studio。#325）のモデルと、それぞれが
    思考モードに対応しているか

    つながらなければ、LLM のモデルは空の一覧にする（status の ollama・lmstudio が error になる）。
    LLM のモデルは `llm` に入れる（#325 で足し、#327 で画面が読むようにしたので、同じ中身の古い
    名前の `ollama` はなくした）
    """
    if ctx.mock:
        backend = ctx.settings.get().llm.backend
        llm_models = MOCK_LMSTUDIO_MODELS if backend == "lmstudio" else MOCK_OLLAMA_MODELS
    else:
        backend = backend_of(ctx.ollama) or ctx.settings.get().llm.backend
        try:
            llm_models = await ctx.ollama.models()
        except LlmUnavailable:
            llm_models = []
    # 処理ごとのモデル（#178）のうち、使っているバックエンドに入っていないもの（setting.json の
    # models のキー）。動かすときは代わりのモデルを使う。一覧を取れない（つながらない）ときは空
    installed = {m["name"] for m in llm_models}
    models = ctx.settings.get().llm_models(backend).model_dump(by_alias=True)
    missing = (
        [key for key, name in models.items() if not has_model(installed, name)] if installed else []
    )
    llm = {"backend": backend, "models": llm_models, "missing": missing}
    # 最終の文字起こし（WhisperX）を作れるサーバーか（#121・#124。画面は作り直すボタンを出し分ける）
    final = ctx.final_transcriber is not None and ctx.final_transcriber.available()
    return {
        "whisper": {
            "models": WHISPER_MODELS,
            "computeTypes": COMPUTE_TYPES,
            "finalTranscript": final,
        },
        "llm": llm,
    }
