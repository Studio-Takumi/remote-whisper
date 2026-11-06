#!/bin/bash
# Mac（Apple シリコン）の配布用の .app と .dmg を作る（#292）。Windows の build.ps1 の Mac 版
#
#     packaging/build-mac.sh [--out-dir packaging/out-mac] [--version <文字列>] [--no-dmg]
#
# <out-dir>/Remote Whisper.app と <out-dir>/remote-whisper-<版>-mac-arm64.dmg ができる。
# .app の中の形（Contents/Resources/app/ の下は Windows の配布用のフォルダと同じ。bundle.py）:
#
#     Remote Whisper.app/Contents/Info.plist
#     Remote Whisper.app/Contents/MacOS/remote-whisper     起動用のスクリプト（packaging/mac/launcher.sh）
#     Remote Whisper.app/Contents/Resources/remote-whisper.icns
#     Remote Whisper.app/Contents/Resources/app/bundle.json
#     Remote Whisper.app/Contents/Resources/app/python/    同梱の Python（python-build-standalone）
#     Remote Whisper.app/Contents/Resources/app/web/       画面のビルド結果
#     Remote Whisper.app/Contents/Resources/app/cloudflared
#     Remote Whisper.app/Contents/Resources/app/whisperx-requirements.txt
#
# ビルドは GitHub Actions（package.yml の mac。macos-latest）で回す。手元の Mac でも動く（1GB ほど落とす）。
# 署名・公証はしない（docs/install-mac.md）
#
# 必要なもの: uv、Node.js（画面のビルド）、git、curl、hdiutil（macOS に入っている）

set -euo pipefail

# 同梱する cloudflared。版と SHA256 を固定する（公式の GitHub Releases の cloudflared-darwin-arm64.tgz）。
# TGZ_SHA256 は tgz そのもの（GitHub のリリースの asset の digest）、SHA256 は中の cloudflared
# （リリースの本文の値）。上げるときは、この 3 つを一緒に変える（build.ps1 と同じ版にそろえる）
CLOUDFLARED_VERSION="2026.9.3"
CLOUDFLARED_TGZ_SHA256="587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095"
CLOUDFLARED_SHA256="5472c1a01c84bc31b3021056a73b4e5774ddddefc572124ea8fdf6c340639f32"
# 同梱する Python（build.ps1 と同じ）。python-build-standalone を uv で取る
PYTHON_SERIES="3.11.17"
# 動かせる一番古い macOS。mlx（mlx-whisper）の wheel が macOS 14 から。
# ビルドする Mac の版ではなく、この版向けの wheel を選ぶ（新しい macOS 用の wheel だけを入れない）
MACOS_TARGET="14.0"
APP_NAME="Remote Whisper"
BUNDLE_ID="io.github.studio-takumi.remote-whisper"

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
out_dir="$here/out-mac"
version=""
make_dmg=1

while [ $# -gt 0 ]; do
    case "$1" in
        --out-dir) out_dir="$2"; shift 2 ;;
        --version) version="$2"; shift 2 ;;
        --no-dmg) make_dmg=0; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "build this on an Apple silicon Mac (arm64)" >&2
    exit 1
fi

if [ -z "$version" ]; then
    version="$(git -C "$repo" rev-parse --short HEAD)"
fi
if ! [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]]; then
    echo "invalid version: $version" >&2
    exit 1
fi

mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd -P)"
app_bundle="$out_dir/$APP_NAME.app"
work="$out_dir/work"
dmg="$out_dir/remote-whisper-$version-mac-arm64.dmg"

# 消してよいのは、前のビルドの出力（.app・work・dmg だけがある、または空）に限る。
# --out-dir に誤ってリポジトリ・その親・ホームなどを渡しても消さない
case "$repo/" in
    "$out_dir"/*) echo "refusing to use $out_dir (it contains the repository)" >&2; exit 1 ;;
esac
if [ "$out_dir" = "/" ] || [ "$out_dir" = "$HOME" ]; then
    echo "refusing to use $out_dir" >&2
    exit 1
fi
for entry in "$out_dir"/* "$out_dir"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    case "$name" in
        "$APP_NAME.app" | work | remote-whisper-*-mac-arm64.dmg | .DS_Store) ;;
        *) echo "refusing to clean $out_dir (unknown entry: $name)" >&2; exit 1 ;;
    esac
done
rm -rf "$app_bundle" "$work"
rm -f "$out_dir"/remote-whisper-*-mac-arm64.dmg

contents="$app_bundle/Contents"
app="$contents/Resources/app"
mkdir -p "$contents/MacOS" "$app" "$work"

# 1. 同梱の Python（python-build-standalone。uv の管理下に入れて、そのフォルダをそのまま写す）
echo "== Python"
export UV_PYTHON_INSTALL_DIR="$work/uv-python"
uv python install "$PYTHON_SERIES"
py_src="$(find "$UV_PYTHON_INSTALL_DIR" -maxdepth 1 -type d -name "cpython-$PYTHON_SERIES-macos-aarch64-*" | head -n 1)"
if [ -z "$py_src" ]; then
    echo "Python $PYTHON_SERIES was not installed" >&2
    exit 1
fi
# -R は記号リンク（bin/python3 → python3.11 など）をそのまま写す
cp -R "$py_src" "$app/python"
# uv の管理下の印。外すと uv pip install で直接入れられる
find "$app/python" -name EXTERNALLY-MANAGED -delete
python="$app/python/bin/python3"
"$python" -I -c "import sys; assert sys.version_info[:2] == (3, 11)"

# 2. server の wheel と、uv.lock の通りの依存（mlx-whisper まで。WhisperX の extra は入れない）
echo "== Python packages"
wheels="$work/wheels"
requirements="$work/requirements.txt"
(
    cd "$repo/server"
    uv build --wheel --out-dir "$wheels"
    uv export --locked --no-dev --no-emit-project --output-file "$requirements"
    # WhisperX（extra final）を後から入れるときの、版とハッシュを固定した一覧（#291）
    uv export --locked --no-dev --no-emit-project --extra final \
        --output-file "$app/whisperx-requirements.txt"
)
export MACOSX_DEPLOYMENT_TARGET="$MACOS_TARGET"
uv pip install --python "$python" --break-system-packages \
    --python-platform aarch64-apple-darwin \
    --link-mode copy --compile-bytecode --require-hashes --requirement "$requirements"
wheel="$(find "$wheels" -maxdepth 1 -name 'remote_whisper-*.whl' | head -n 1)"
if [ -z "$wheel" ]; then
    echo "the wheel was not built" >&2
    exit 1
fi
uv pip install --python "$python" --break-system-packages \
    --link-mode copy --compile-bytecode --no-deps "$wheel"

# 3. 画面
echo "== Web"
(
    cd "$repo/web"
    npm ci
    npm run build
)
cp -R "$repo/web/dist" "$app/web"

# 4. cloudflared（版と SHA256 を固定して、公式から取る）
echo "== cloudflared $CLOUDFLARED_VERSION"
tgz="$work/cloudflared.tgz"
curl --fail --location --silent --show-error --output "$tgz" \
    "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-darwin-arm64.tgz"
check_sha256() {
    local actual
    actual="$(shasum -a 256 "$1" | cut -d ' ' -f 1)"
    if [ "$actual" != "$2" ]; then
        echo "SHA256 mismatch ($1): expected $2, got $actual" >&2
        exit 1
    fi
}
# 展開する前に tgz を、展開したあとに中身を確かめる
check_sha256 "$tgz" "$CLOUDFLARED_TGZ_SHA256"
mkdir -p "$work/cloudflared"
tar -xzf "$tgz" -C "$work/cloudflared" cloudflared
check_sha256 "$work/cloudflared/cloudflared" "$CLOUDFLARED_SHA256"
cp "$work/cloudflared/cloudflared" "$app/cloudflared"
chmod 755 "$app/cloudflared"

# 5. ビルドの印（bundle.py が見る。バージョンもここから）
printf '{\n  "version": "%s",\n  "cloudflared": "%s"\n}\n' "$version" "$CLOUDFLARED_VERSION" \
    > "$app/bundle.json"

# 6. .app の外側（起動用のスクリプト・Info.plist・アイコン）
echo "== App bundle"
cp "$here/mac/launcher.sh" "$contents/MacOS/remote-whisper"
chmod 755 "$contents/MacOS/remote-whisper"
cp "$here/icon/remote-whisper.icns" "$contents/Resources/remote-whisper.icns"
sed -e "s/@VERSION@/$version/g" -e "s/@BUNDLE_ID@/$BUNDLE_ID/g" \
    -e "s/@MACOS_TARGET@/$MACOS_TARGET/g" "$here/mac/Info.plist" > "$contents/Info.plist"
plutil -lint "$contents/Info.plist"

rm -rf "$work"
size="$(du -sm "$app_bundle" | cut -f 1)"
echo "== app: $app_bundle (${size} MB, version $version)"

# 7. .dmg（.app と、/Applications への記号リンクを入れる）
if [ "$make_dmg" = 1 ]; then
    echo "== dmg"
    stage="$out_dir/work/dmg"
    mkdir -p "$stage"
    cp -R "$app_bundle" "$stage/"
    ln -s /Applications "$stage/Applications"
    hdiutil create -volname "$APP_NAME" -srcfolder "$stage" -fs APFS -format ULMO -ov "$dmg"
    rm -rf "$out_dir/work"
    echo "== dmg: $dmg ($(du -sm "$dmg" | cut -f 1) MB)"
fi
