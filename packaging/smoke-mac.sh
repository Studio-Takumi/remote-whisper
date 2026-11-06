#!/bin/bash
# 作った .app（または .dmg から写した .app）が動くかを確かめる（#292。Windows の smoke.ps1 の Mac 版）
#
#     packaging/smoke-mac.sh <Remote Whisper.app> <データの置き場> [ポート]
#
# .app の起動用のスクリプトから --mock --no-tray で起動し、/api/health・/api/version・画面（/）が返ることと、
# 同梱の cloudflared が動くこと、同梱の cloudflared を使う判定になること、配布版（mac-bundle）と
# 判定されることを確かめて止める。8000 番が使われているときに別の番号で起動すること、2 つ目の起動が
# 起動せずに終わること（#290）も見る。本番のデータ（~/.remote-whisper）には触らない
# （REMOTE_WHISPER_HOME をテスト用に向ける）

set -euo pipefail

if [ $# -lt 2 ]; then
    echo "usage: $0 <app> <data dir> [port]" >&2
    exit 2
fi
app_bundle="$(cd "$1" && pwd -P)"
data_dir="$2"
port="${3:-18292}"
mkdir -p "$(dirname "$data_dir")"
data_dir="$(cd "$(dirname "$data_dir")" && pwd -P)/$(basename "$data_dir")"

app="$app_bundle/Contents/Resources/app"
launcher="$app_bundle/Contents/MacOS/remote-whisper"
python="$app/python/bin/python3"
cloudflared="$app/cloudflared"
expected="$("$python" -I -c "import json, sys; print(json.load(open(sys.argv[1]))['version'])" "$app/bundle.json")"

ok() { echo "ok: $1"; }
fail() { echo "smoke test failed: $1" >&2; exit 1; }

unset REMOTE_WHISPER_WEB_DIST REMOTE_WHISPER_BUNDLE_DIR
export REMOTE_WHISPER_HOME="$data_dir"
# 画面を開く代わりに何もしない（CI にブラウザはない。--login でも開かないが、2 つ目の起動は開こうとする）
export BROWSER="/usr/bin/true %s"

pids=()
cleanup() {
    for pid in "${pids[@]:-}"; do
        [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 2
    for pid in "${pids[@]:-}"; do
        [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
    done
    [ -n "${listener:-}" ] && kill "$listener" 2>/dev/null || true
}
trap cleanup EXIT

# Info.plist とアイコン
plutil -lint "$app_bundle/Contents/Info.plist" >/dev/null || fail "Info.plist is valid"
[ "$(plutil -extract CFBundleExecutable raw "$app_bundle/Contents/Info.plist")" = "remote-whisper" ] \
    || fail "CFBundleExecutable is remote-whisper"
[ -x "$launcher" ] || fail "the launcher is executable"
[ -f "$app_bundle/Contents/Resources/remote-whisper.icns" ] || fail "the icon is in the bundle"
ok "the app bundle has Info.plist, the launcher and the icon"

# 同梱の cloudflared が実行できる
cf_version="$("$cloudflared" --version)" || fail "cloudflared runs"
[[ "$cf_version" == *cloudflared* ]] || fail "cloudflared prints its version"
ok "cloudflared runs ($cf_version)"

# 設定が空なら同梱の cloudflared を使う。配布版（mac-bundle）と判定され、WhisperX を同梱の
# Python と固定の一覧で入れられる（#291）。.app を「ログイン時に起動」の対象にできる
found="$("$python" -I -c "from remote_whisper import bundle; print(bundle.bundled_cloudflared())")"
[ "$found" = "$cloudflared" ] || fail "the bundled cloudflared is the default ($found)"
ok "the bundled cloudflared is the default"
setup="$("$python" -I -c "from remote_whisper import bundle; print(bundle.runtime(), bundle.bundled_python(), bundle.bundled_whisperx_requirements())")"
[ "$setup" = "mac-bundle $python $app/whisperx-requirements.txt" ] || fail "the setup guide sees the bundle ($setup)"
ok "the setup guide sees the bundle ($setup)"
found_app="$("$python" -I -c "from remote_whisper import bundle, login_item; print(bundle.app_bundle(), login_item.supported())")"
[ "$found_app" = "$app_bundle True" ] || fail "the app bundle is found for the login item ($found_app)"
ok "the login item can be turned on"

# --mock は mlx-whisper・faster_whisper・メニューバーを読み込まないので、本番の経路の依存がそろっているかを別に見る
"$python" -I -c "import mlx.core, mlx_whisper, faster_whisper, ctranslate2, pystray, PIL, cryptography, AppKit" \
    || fail "mlx, mlx_whisper, faster_whisper, ctranslate2, pystray, PIL and AppKit can be imported"
ok "mlx, mlx_whisper, faster_whisper, ctranslate2, pystray, PIL and AppKit can be imported"
# Metal が使えるか（CI の仮想マシンでは使えないことがあるので、出すだけ）
"$python" -I -c "import mlx.core as mx; print('info: Metal available:', mx.metal.is_available())" || true
"$python" -I -m pip --version >/dev/null || fail "pip is in the bundled Python (WhisperX is installed with it)"
ok "pip is in the bundled Python"
if command -v uv >/dev/null; then
    uv pip check --python "$python" || fail "uv pip check finds no broken dependencies"
    ok "uv pip check finds no broken dependencies"
fi

wait_for() {
    # $1 秒まで、$2 のコマンドが成功するのを待つ
    local i
    for ((i = 0; i < $1; i++)); do
        if eval "$2" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# .app の起動用のスクリプトで、番号を決めて動かす（--login: ブラウザを開かない）
"$launcher" --login --mock --no-tray --port "$port" &
pids+=($!)
base="http://127.0.0.1:$port"
wait_for 60 "curl -fsS $base/api/health" || fail "/api/health answers"
health="$(curl -fsS "$base/api/health")"
[[ "$health" == *'"status":"ok"'* ]] || fail "/api/health returns ok ($health)"
[[ "$health" == *'"mock":true'* ]] || fail "running in mock mode ($health)"
ok "/api/health returns ok in mock mode"
version="$(curl -fsS "$base/api/version")"
[[ "$version" == *"\"version\":\"$expected\""* ]] || fail "/api/version returns the build version ($version)"
ok "/api/version returns the build version ($expected)"
curl -fsS "$base/" | grep -q 'id="root"' || fail "the web UI is served"
ok "the web UI is served"
kill -TERM "${pids[0]}"
wait "${pids[0]}" 2>/dev/null || true
pids=()
[ -f "$data_dir/log/server.log" ] || fail "the data folder was created (log/server.log)"
ok "the data folder was created (log/server.log)"

# 8000 番が使われているとき（#290）: 引数なし（--auto-port）で起動すると別の番号で起動し、
# 使った番号を port.json に書く。もう一度起動すると、2 つ目は起動せずに終わる
busy_data="$data_dir-busy"
export REMOTE_WHISPER_HOME="$busy_data"
if ! lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
    "$python" -I -c "import socket, time; s = socket.socket(); s.bind(('127.0.0.1', 8000)); s.listen(); time.sleep(600)" &
    listener=$!
    wait_for 10 "lsof -nP -iTCP:8000 -sTCP:LISTEN" || fail "port 8000 is taken by the smoke test"
    echo "port 8000 is now in use by the smoke test"
fi
"$launcher" --login --mock --no-tray &
pids+=($!)
wait_for 60 "test -s '$busy_data/port.json'" || fail "port.json was written"
busy_port="$("$python" -I -c "import json, sys; print(json.load(open(sys.argv[1]))['port'])" "$busy_data/port.json")"
[ "$busy_port" != 8000 ] && [ "$busy_port" != 8001 ] || fail "started on another port ($busy_port)"
wait_for 60 "curl -fsS http://127.0.0.1:$busy_port/api/health" || fail "the server answers on port $busy_port"
ok "started on another port ($busy_port) while 8000 was in use"
first_pid="$("$python" -I -c "import json, sys; print(json.load(open(sys.argv[1]))['pid'])" "$busy_data/port.json")"
# 2 つ目（instance.lock が取れない）は起動せずに 0 で終わる
"$launcher" --login --mock --no-tray &
second=$!
for ((i = 0; i < 60; i++)); do
    kill -0 "$second" 2>/dev/null || break
    sleep 1
done
if kill -0 "$second" 2>/dev/null; then
    kill -KILL "$second"
    fail "a second launch exits without starting another server"
fi
wait "$second" || fail "a second launch exits with 0"
ok "a second launch exits without starting another server"
after_pid="$("$python" -I -c "import json, sys; print(json.load(open(sys.argv[1]))['pid'])" "$busy_data/port.json")"
[ "$after_pid" = "$first_pid" ] || fail "the first server is still the one in port.json"
curl -fsS "http://127.0.0.1:$busy_port/api/health" >/dev/null || fail "the first server is still running"
ok "the first server is still running"
echo "smoke test passed"
