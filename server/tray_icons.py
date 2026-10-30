"""常駐アイコン（タスクトレイ・メニューバー）の画像を、色ごとに PNG に書き出す（説明用。#151）

使い方: uv run python tray_icons.py <保存先のフォルダ> [大きさ(px)]

点の色 4 つ（灰・青・赤・橙）× 背景の明るさ 2 つ
（dark: 暗いバー用の白い棒 / light: 明るいバー用の黒い棒）を、
アプリと同じ描き方（remote_whisper.tray.icon_image）で書き出す
"""

import sys
from pathlib import Path

from remote_whisper.tray import icon_image
from remote_whisper.tray_state import DOT_COLORS


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out = Path(sys.argv[1])
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 128
    out.mkdir(parents=True, exist_ok=True)
    for color in DOT_COLORS:
        for bar, light in (("dark", False), ("light", True)):
            path = out / f"tray-{bar}-{color}.png"
            icon_image(color, size, light).save(path)
            print(path)


if __name__ == "__main__":
    main()
