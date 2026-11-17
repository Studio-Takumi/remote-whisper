"""LM Studio への頼みの形（メッセージ・SSE）と、返事の JSON Schema での確かめ。spec/notes.md 9.3"""

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx


def data_url(image: str) -> str:
    """共通の形の画像（base64 の PNG）を data URI にする"""
    return image if image.startswith("data:") else f"data:image/png;base64,{image}"


def native_input(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """メッセージを `/api/v1/chat` の system_prompt と input に分ける"""
    system = "\n\n".join(str(m.get("content") or "") for m in messages if m["role"] == "system")
    items: list[dict[str, Any]] = []
    for m in messages:
        if m["role"] != "user":
            continue
        if m.get("content"):
            items.append({"type": "text", "content": str(m["content"])})
        if m.get("image"):
            items.append({"type": "image", "data_url": data_url(m["image"])})
    return system, items


def openai_message(message: dict[str, Any]) -> dict[str, Any]:
    """共通の形の画像（"image"）を、OpenAI 互換の image_url に直す"""
    if "image" not in message:
        return message
    rest = {k: v for k, v in message.items() if k not in ("image", "content")}
    content: list[dict[str, Any]] = []
    if message.get("content"):
        content.append({"type": "text", "text": str(message["content"])})
    content.append({"type": "image_url", "image_url": {"url": data_url(message["image"])}})
    return {**rest, "content": content}


async def sse(res: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    """SSE を（イベント名, data）の組で返す"""
    event, data = "", []
    async for line in res.aiter_lines():
        if not line:
            if data:
                yield event, "\n".join(data)
            event, data = "", []
            continue
        if line.startswith(":"):
            continue
        key, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if key == "event":
            event = value
        elif key == "data":
            data.append(value)
    if data:
        yield event, "\n".join(data)


class SchemaMismatch(ValueError):
    """返事が JSON Schema に合わない"""


def schema_prompt(schema: dict[str, Any]) -> str:
    """`/api/v1/chat` で構造化出力の代わりにプロンプトの最後に足す指示"""
    text = json.dumps(schema, ensure_ascii=False)
    return (
        "次の JSON Schema に従う JSON だけを返してください。説明やコードブロックは付けないで"
        f"ください。\n{text}"
    )


def _strip_code_block(text: str) -> str:
    """```json ... ``` で囲まれていれば中身だけにする"""
    text = text.strip()
    if text.startswith("```"):
        text = text[3:]
        # 1 行目の言語名（json など）は捨てる
        first, sep, rest = text.partition("\n")
        if sep and (not first.strip() or first.strip().isalpha()):
            text = rest
        text = text.rstrip().removesuffix("```").strip()
    return text


def conform(value: Any, schema: dict[str, Any], path: str = "$") -> Any:
    """value が JSON Schema に合うか確かめる。合わなければ SchemaMismatch

    使っているキーワード（type・properties・required・items・maxItems・maxLength）だけを見る。
    maxLength を超えた文字列と maxItems を超えた配列は、切り詰めて返す（作り直さない）。
    `/v1/chat/completions` の構造化出力も、上限で切れた文字列を返すので、それに合わせる（#322）。
    properties にないキーは、そのまま残す（呼ぶ側は使わない）
    """
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            raise SchemaMismatch(f"{path} is not an object")
        for key in schema.get("required") or []:
            if key not in value:
                raise SchemaMismatch(f"{path}.{key} is missing")
        props = schema.get("properties") or {}
        return {
            k: conform(v, props[k], f"{path}.{k}") if k in props else v for k, v in value.items()
        }
    if kind == "array":
        if not isinstance(value, list):
            raise SchemaMismatch(f"{path} is not an array")
        limit = schema.get("maxItems")
        if isinstance(limit, int):
            value = value[:limit]
        items = schema.get("items")
        if isinstance(items, dict):
            return [conform(v, items, f"{path}[{i}]") for i, v in enumerate(value)]
        return value
    if kind == "string":
        if not isinstance(value, str):
            raise SchemaMismatch(f"{path} is not a string")
        limit = schema.get("maxLength")
        return value[:limit] if isinstance(limit, int) else value
    if kind == "integer":
        # bool は int の子だが、JSON では整数ではない
        if not isinstance(value, int) or isinstance(value, bool):
            raise SchemaMismatch(f"{path} is not an integer")
        return value
    if kind == "number":
        if not isinstance(value, int | float) or isinstance(value, bool):
            raise SchemaMismatch(f"{path} is not a number")
        return value
    if kind == "boolean":
        if not isinstance(value, bool):
            raise SchemaMismatch(f"{path} is not a boolean")
        return value
    return value


def parse_structured(text: str, schema: dict[str, Any]) -> str:
    """プロンプトでスキーマを頼んだ返事を、スキーマに合った JSON の文字列にする

    コードブロックを外して読む。読めない・合わなければ SchemaMismatch"""
    try:
        value = json.loads(_strip_code_block(text))
    except ValueError as e:
        raise SchemaMismatch(f"not JSON: {e}") from e
    return json.dumps(conform(value, schema), ensure_ascii=False)
