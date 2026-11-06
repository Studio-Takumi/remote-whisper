"""テスト用の偽の Python（#291）。WhisperX を入れる流れを、本物の pip を使わずに確かめる

`python fake_python.py <引数>` で、本物の Python の `python <引数>` のまねをする。
入っているパッケージは環境変数 FAKE_SITE の JSON（名前 → 版）。
FAKE_PIP でふるまいを変える: ok（既定）・fail（途中まで入れて失敗）・change（ほかの版も変えて
失敗）・hang（入れたまま止まる）
"""

import json
import os
import sys
import time

site = os.environ["FAKE_SITE"]
args = sys.argv[1:]


def load() -> dict[str, str]:
    with open(site, encoding="utf-8") as f:
        return json.load(f)


def save(pkgs: dict[str, str]) -> None:
    with open(site, "w", encoding="utf-8") as f:
        json.dump(pkgs, f)


if args[:1] == ["-c"]:
    # 入っているものの一覧
    print(json.dumps(load()))
    sys.exit(0)
if args[:3] == ["-m", "pip", "--version"]:
    print("pip 99.0 (fake)")
    sys.exit(0)
if args[:3] == ["-m", "pip", "uninstall"]:
    pkgs = load()
    for name in args[3:]:
        if not name.startswith("-"):
            pkgs.pop(name, None)
    save(pkgs)
    sys.exit(0)
if args[:3] == ["-m", "pip", "install"]:
    pkgs = load()
    if "--no-deps" in args:
        # 版を戻す
        for spec in args:
            if "==" in spec:
                name, version = spec.split("==")
                pkgs[name] = version
        save(pkgs)
        sys.exit(0)
    mode = os.environ.get("FAKE_PIP", "ok")
    print("Collecting whisperx==3.8.6 (from -r requirements.txt (line 1))", flush=True)
    print("  Downloading whisperx-3.8.6-py3-none-any.whl (1.2 MB)", flush=True)
    print("Collecting torch==2.8.0+cu128", flush=True)
    print("  Downloading torch-2.8.0%2Bcu128-cp311-cp311-win_amd64.whl (3.3 GB)", flush=True)
    pkgs["whisperx"] = "3.8.6"
    pkgs["torch"] = "2.8.0"
    if mode == "change":
        pkgs["numpy"] = "9.9.9"
    save(pkgs)
    if mode == "hang":
        time.sleep(60)
    if mode in ("fail", "change"):
        print("ERROR: something went wrong", flush=True)
        sys.exit(1)
    print("Installing collected packages: torch, whisperx", flush=True)
    print("Successfully installed torch-2.8.0 whisperx-3.8.6", flush=True)
    sys.exit(0)
print(f"fake python: unknown args {args}", file=sys.stderr)
sys.exit(2)
