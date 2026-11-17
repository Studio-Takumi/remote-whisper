"""Windows の icacls・whoami を偽物にする共通の部品"""

import subprocess
import sys
from pathlib import Path

SID = "S-1-5-21-1111111111-2222222222-3333333333-1001"


WHOAMI = "C:\\Windows\\System32\\whoami.exe"


ICACLS = "C:\\Windows\\System32\\icacls.exe"


def fake_icacls(monkeypatch, results, whoami=f'"example-pc\\taro","{SID}"'):
    """Windows の icacls と whoami を偽物にする。icacls は results の順に答える（int は終了コード、
    例外は投げる）。whoami は whoami の出力（例外なら投げる）

    icacls が呼ばれたときの起動したパス・対象（フォルダなら中の名前、ファイルなら中身）・
    そのときの cloud.json の中身を覚える
    """
    seen: list[dict] = []
    answers = list(results)

    def run(args, **kwargs):
        if args[0].lower().endswith("whoami.exe"):
            assert args[0] == WHOAMI
            if isinstance(whoami, BaseException):
                raise whoami
            return subprocess.CompletedProcess(args, 0, whoami + "\n", "")
        target = Path(args[1])
        home = target.parent if target.is_dir() else target.parent.parent
        seen.append(
            {
                "args": args,
                "target": target,
                "dir": target.is_dir(),
                "listing": sorted(p.name for p in target.iterdir()) if target.is_dir() else None,
                "content": None if target.is_dir() else target.read_bytes(),
                "final": (home / "cloud.json").read_bytes()
                if (home / "cloud.json").exists()
                else None,
            }
        )
        answer = answers.pop(0) if len(answers) > 1 else answers[0]
        if isinstance(answer, BaseException):
            raise answer
        return subprocess.CompletedProcess(args, answer, "", "Access is denied." if answer else "")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("SystemRoot", raising=False)
    # 名前では指さない（SSH のセッションでは USERDOMAIN が WORKGROUP になり、名前を解けない）
    monkeypatch.setenv("USERNAME", "taro")
    monkeypatch.setenv("USERDOMAIN", "WORKGROUP")
    monkeypatch.setattr(subprocess, "run", run)
    return seen
