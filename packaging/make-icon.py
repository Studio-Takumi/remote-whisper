"""インストーラ・ショートカットのアイコン（.ico）を、ロゴから作る（#290）

    cd server && uv run python ../packaging/make-icon.py

元は web/public/pwa-512.png（#284 のロゴ。web/public/app-icon.svg を `npm run icons` で書き出したもの）。
16〜256px の複数サイズを 1 つの ICO に入れて、packaging/icon/remote-whisper.ico に書く。
ロゴを変えたら、`npm run icons` のあとにこれをもう一度動かして、できた .ico をコミットする。
Pillow が要る（server の依存に入っている）
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "web" / "public" / "pwa-512.png"
OUTPUT = Path(__file__).resolve().parent / "icon" / "remote-whisper.ico"
# Windows が使う大きさ（タイトルバー・タスクバー・エクスプローラー・高 DPI）
SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> int:
    if not SOURCE.exists():
        print(f"not found: {SOURCE}", file=sys.stderr)
        return 1
    source = Image.open(SOURCE).convert("RGBA")
    if source.width != source.height or source.width < max(SIZES):
        print(f"the source must be a square of at least {max(SIZES)}px: {source.size}", file=sys.stderr)
        return 1
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # 大きさごとに、元の絵から縮めて作る
    frames = [source.resize((size, size), Image.LANCZOS) for size in SIZES]
    frames[-1].save(OUTPUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({', '.join(str(s) for s in SIZES)}px)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
