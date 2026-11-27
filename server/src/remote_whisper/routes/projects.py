"""プロジェクトの API。spec/api.md 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from remote_whisper.api_errors import ApiError, api_error
from remote_whisper.context import AppContext, Pid, get_ctx
from remote_whisper.materials.context_sets import ContextSetError, ContextSetService
from remote_whisper.storage.projects import (
    SUMMARY_DIR_MAX,
    ProjectError,
    ProjectFile,
    SummaryDirError,
    display_name,
    normalize_summary_dir,
    order_projects,
)

router = APIRouter(prefix="/api/projects")


class RegisterBody(BaseModel):
    path: str


def project_json(pid: str, project: ProjectFile) -> dict[str, Any]:
    return {
        "id": pid,
        "uuid": project.uuid,
        "name": display_name(project.path),
        "path": project.path,
        "selection": project.effective_selection().model_dump(by_alias=True),
        "summaryDir": project.summary_dir,
    }


class ProjectBody(BaseModel):
    """省いたものは今のまま"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    # null は 422（直下に戻すときは空の文字列を送る）
    summary_dir: str = Field(default="", max_length=SUMMARY_DIR_MAX * 2)


@router.patch("/{pid}")
def change_project(
    pid: Pid, body: ProjectBody, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    """プロジェクトの設定を変える（今は最終要約のコピーの置き場所 summaryDir だけ。#341）。
    不正なパスは 422（spec/files.md 5.4）"""
    changes = body.model_dump(exclude_unset=True)
    summary_dir: str | None = None
    if "summary_dir" in changes:
        try:
            summary_dir = normalize_summary_dir(changes["summary_dir"])
        except SummaryDirError as e:
            raise ApiError(422, e.code, e.message, e.params) from e

    def change(project: ProjectFile) -> None:
        if summary_dir is not None:
            project.summary_dir = summary_dir

    try:
        project = ctx.projects.update(pid, change)
    except ProjectError as e:
        raise api_error(e) from e
    return project_json(pid, project)


@router.get("")
def list_projects(ctx: Annotated[AppContext, Depends(get_ctx)]) -> list[dict[str, Any]]:
    # 並びは全体設定の projectOrder（5.3 節、#173）。ここにないものは先頭
    ordered = order_projects(ctx.projects.all(), ctx.settings.get().project_order)
    return [project_json(pid, p) for pid, p in ordered]


class ContextSetBody(BaseModel):
    materials: list[str]


class SelectionBody(BaseModel):
    """省いたものは今のまま"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    context_set: str | None = None
    use_hotwords: bool | None = None
    use_context: bool | None = None
    pick_terms: bool | None = None


def _service(ctx: AppContext) -> ContextSetService:
    if ctx.context_sets is None:
        raise ApiError(503, "referenceMaterials.unsupported", "このホストでは参考資料を作れません")
    return ctx.context_sets


@router.get("/{pid}/context-sets")
def list_context_sets(
    pid: Pid, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> list[dict[str, Any]]:
    try:
        return _service(ctx).entries(pid)
    except ContextSetError as e:
        raise api_error(e) from e


@router.post("/{pid}/context-sets", status_code=202)
async def create_context_set(
    pid: Pid, body: ContextSetBody, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    """作成を始める（できたら contextSet で知らせる）。同じ資料のセットがあれば、それを返す"""
    try:
        return await _service(ctx).create(pid, body.materials)
    except ContextSetError as e:
        raise api_error(e) from e


@router.patch("/{pid}/selection")
def change_selection(
    pid: Pid, body: SelectionBody, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    """使うセットと、用語リスト・コンテキストそれぞれを使うか。
    録音中は 409（spec/files.md 5.3・spec/ui.md 8）"""
    ctx.ensure_not_recording()
    changes = body.model_dump(exclude_unset=True)

    def change(project: ProjectFile) -> None:
        selection = project.effective_selection().model_copy()
        if "context_set" in changes:
            set_id = changes["context_set"]
            entry = next((s for s in project.context_sets if s.id == set_id), None)
            if set_id is not None and (entry is None or entry.status == "failed"):
                raise ApiError(
                    400,
                    "referenceMaterials.unusable",
                    f"使えない参考資料です: {set_id}",
                    {"id": set_id},
                )
            selection.context_set = set_id
        if changes.get("use_hotwords") is not None:
            selection.use_hotwords = changes["use_hotwords"]
        if changes.get("use_context") is not None:
            selection.use_context = changes["use_context"]
        if changes.get("pick_terms") is not None:
            selection.pick_terms = changes["pick_terms"]
        project.selection = selection

    try:
        project = ctx.projects.update(pid, change)
    except ProjectError as e:
        raise api_error(e) from e
    return project.effective_selection().model_dump(by_alias=True)


@router.post("")
def register_project(
    body: RegisterBody, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    try:
        pid, project = ctx.projects.register(body.path, ctx.settings.get().materials.roots)
    except ProjectError as e:
        raise api_error(e) from e
    return project_json(pid, project)
