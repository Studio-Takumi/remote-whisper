"""プロジェクトの API。spec 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.projects import ProjectError, ProjectFile, display_name

router = APIRouter(prefix="/api/projects")


class RegisterBody(BaseModel):
    path: str


def project_json(pid: str, project: ProjectFile) -> dict[str, Any]:
    return {
        "id": pid,
        "name": display_name(project.path),
        "path": project.path,
        "selection": project.effective_selection().model_dump(by_alias=True),
    }


@router.get("")
def list_projects(ctx: Annotated[AppContext, Depends(get_ctx)]) -> list[dict[str, Any]]:
    return [project_json(pid, p) for pid, p in ctx.projects.all()]


@router.post("")
def register_project(
    body: RegisterBody, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    try:
        pid, project = ctx.projects.register(body.path, ctx.settings.get().materials.roots)
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    return project_json(pid, project)
