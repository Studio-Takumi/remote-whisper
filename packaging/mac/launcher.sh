#!/bin/bash
# Remote Whisper.app の起動用（#292）。build-mac.sh が Contents/MacOS/remote-whisper に置く
#
# 同梱の Python でサーバーを起動する（メニューバーのアイコンも出る）。Finder などから開いたときは、
# 起動したら画面をブラウザで開く。ログイン時の起動（メニューバーの「ログイン時に起動」。login_item.py）は
# --login を付けて呼ぶので、ブラウザは開かない。ほかの引数はそのままサーバーに渡す
#
# --auto-port: 8000 番が使われていたら、空いている番号で起動する（Windows のショートカットと同じ。#290）。
# すでに同じデータのルートで動いていれば、2 つ目は起動せずに、動いている方の画面を開く（instance.lock）

contents="$(cd "$(dirname "$0")/.." && pwd -P)"
bundle="$(dirname "$contents")"
app="$contents/Resources/app"
python="$app/python/bin/python3"

alert() {
    /usr/bin/osascript -e "display dialog \"$1\" with title \"Remote Whisper\" with icon stop buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1
}

# .dmg の中から、またはダウンロードしたフォルダから直接開いたとき（macOS が読み取り専用の仮の場所に
# 移して動かす。開くたびに場所が変わり、許可も残らない）は、起動せずに「アプリケーション」へ移すよう出す。
# 署名していないので、Gatekeeper の警告と許可の手順は docs/install-mac.md に書く（ここでは何も外さない）
if [[ "$bundle" == */AppTranslocation/* ]] || { [[ "$bundle" == /Volumes/* ]] && [ ! -w "$contents" ]; }; then
    alert "Remote Whisper を「アプリケーション」フォルダに移してから、もう一度開いてください。"
    exit 1
fi

open_browser=1
auto_port=1
args=()
for a in "$@"; do
    case "$a" in
        --login) open_browser=0 ;;
        # LaunchServices が付けることのあるプロセスの番号（サーバーは知らない引数なので捨てる）
        -psn_*) ;;
        # --port <番号> を渡したときは、その番号だけを使う（--auto-port とは同時に使えない）
        --port | --port=*) auto_port=0; args+=("$a") ;;
        *) args+=("$a") ;;
    esac
done
if [ "$open_browser" = 1 ]; then
    args+=("--open-browser")
fi
if [ "$auto_port" = 1 ]; then
    args+=("--auto-port")
fi

# -I: 利用者の環境変数（PYTHONPATH など）・ユーザーの site-packages を読まない
exec "$python" -I -m remote_whisper "${args[@]}"
