"""プロジェクトの API。spec 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from remote_whisper.context import AppContext, Pid, get_ctx
from remote_whisper.context_sets import ContextSetError, ContextSetService
from remote_whisper.projects import ProjectError, ProjectFile, display_name

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
    }


@router.get("")
def list_projects(ctx: Annotated[AppContext, Depends(get_ctx)]) -> list[dict[str, Any]]:
    return [project_json(pid, p) for pid, p in ctx.projects.all()]


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
        raise HTTPException(status_code=503, detail="このサーバーでは参考資料セットを作れません")
    return ctx.context_sets


@router.get("/{pid}/context-sets")
def list_context_sets(
    pid: Pid, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> list[dict[str, Any]]:
    try:
        return _service(ctx).entries(pid)
    except ContextSetError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e


@router.post("/{pid}/context-sets", status_code=202)
async def create_context_set(
    pid: Pid, body: ContextSetBody, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    """作成を始める（できたら contextSet で知らせる）。同じ資料のセットがあれば、それを返す"""
    try:
        return await _service(ctx).create(pid, body.materials)
    except ContextSetError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e


@router.patch("/{pid}/selection")
def change_selection(
    pid: Pid, body: SelectionBody, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    """使うセットと、用語リスト・コンテキストそれぞれを使うか。録音中は 409（spec 5.3・8）"""
    ctx.ensure_not_recording()
    changes = body.model_dump(exclude_unset=True)

    def change(project: ProjectFile) -> None:
        selection = project.effective_selection().model_copy()
        if "context_set" in changes:
            set_id = changes["context_set"]
            entry = next((s for s in project.context_sets if s.id == set_id), None)
            if set_id is not None and (entry is None or entry.status == "failed"):
                raise HTTPException(status_code=400, detail=f"使えない参考資料セットです: {set_id}")
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
        raise HTTPException(status_code=e.status, detail=e.message) from e
    return project.effective_selection().model_dump(by_alias=True)


@router.post("")
def register_project(
    body: RegisterBody, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    try:
        pid, project = ctx.projects.register(body.path, ctx.settings.get().materials.roots)
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    return project_json(pid, project)
