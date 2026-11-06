<#
  作ったフォルダ（またはインストールしたフォルダ）が動くかを確かめる（#168）。

    pwsh packaging/smoke.ps1 -AppDir <フォルダ> -DataDir <データの置き場> [-Port 18168]

  --mock --no-tray で起動し、/api/health・/api/version・画面（/）が返ることと、
  同梱の cloudflared が動くこと、既定で同梱の cloudflared を使う判定になることを確かめて止める。
  本番のデータ（~/.remote-whisper）には触らない（REMOTE_WHISPER_HOME をテスト用に向ける）
#>
param(
    [Parameter(Mandatory)][string]$AppDir,
    [Parameter(Mandatory)][string]$DataDir,
    [int]$Port = 18168
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppDir = (Resolve-Path $AppDir).Path
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$python = Join-Path $AppDir 'python\python.exe'
$pythonw = Join-Path $AppDir 'python\pythonw.exe'
$cloudflared = Join-Path $AppDir 'cloudflared.exe'
$expected = (Get-Content (Join-Path $AppDir 'bundle.json') -Raw | ConvertFrom-Json).version

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "smoke test failed: $Message" }
    Write-Host "ok: $Message"
}

$env:REMOTE_WHISPER_HOME = $DataDir
Remove-Item Env:\REMOTE_WHISPER_WEB_DIST -ErrorAction SilentlyContinue
Remove-Item Env:\REMOTE_WHISPER_BUNDLE_DIR -ErrorAction SilentlyContinue

# 同梱の cloudflared が実行できる
$cfVersion = & $cloudflared --version
Assert-True ($LASTEXITCODE -eq 0 -and "$cfVersion" -match 'cloudflared') "cloudflared runs ($cfVersion)"

# 設定が空なら同梱の cloudflared を使う判定になる
$found = & $python -I -c "from remote_whisper import bundle; print(bundle.bundled_cloudflared())"
Assert-True ($LASTEXITCODE -eq 0 -and "$found".Trim() -eq $cloudflared) 'the bundled cloudflared is the default'

# --mock は faster_whisper・ctranslate2・トレイを読み込まないので、本番の経路の依存がそろっているかを別に見る
& $python -I -c "import faster_whisper, ctranslate2, pystray, PIL, cryptography, nvidia.cublas, nvidia.cudnn"
Assert-True ($LASTEXITCODE -eq 0) 'faster_whisper, ctranslate2, pystray, PIL and the CUDA libraries can be imported'
& uv pip check --python $python
Assert-True ($LASTEXITCODE -eq 0) 'uv pip check finds no broken dependencies'

# インストール後と同じ起動（コンソールを出さない pythonw）で動かす
$proc = Start-Process -FilePath $pythonw `
    -ArgumentList @('-m', 'remote_whisper', '--mock', '--no-tray', '--port', $Port) `
    -WorkingDirectory $AppDir -PassThru -WindowStyle Hidden
try {
    $base = "http://127.0.0.1:$Port"
    $health = $null
    for ($i = 0; $i -lt 60 -and -not $health; $i++) {
        Start-Sleep -Seconds 1
        if ($proc.HasExited) { throw "the server exited early (code $($proc.ExitCode))" }
        try { $health = Invoke-RestMethod "$base/api/health" -TimeoutSec 3 } catch { $health = $null }
    }
    Assert-True ($null -ne $health -and $health.status -eq 'ok') '/api/health returns ok'
    Assert-True ($health.mock -eq $true) 'running in mock mode'
    $version = Invoke-RestMethod "$base/api/version"
    Assert-True ($version.version -eq $expected) "/api/version returns the build version ($expected)"
    $index = Invoke-WebRequest "$base/" -UseBasicParsing
    Assert-True ($index.StatusCode -eq 200 -and $index.Content -match 'id="root"') 'the web UI is served'
} finally {
    # 子プロセス（cloudflared・文字起こしの worker）も含めて止める（残るとアンインストールで消せない）
    if (-not $proc.HasExited) { & taskkill /F /T /PID $proc.Id | Out-Null }
    $proc.WaitForExit(10000) | Out-Null
}

Assert-True (Test-Path (Join-Path $DataDir 'log\server.log')) 'the data folder was created (log/server.log)'

# 8000 番が使われているとき（#290）: --port なしで起動すると、別の番号で起動し、使った番号を port.json に書く。
# そのあともう一度起動すると、2 つ目は起動せずに終わる（動いている方はそのまま）
$busyData = "$DataDir-busy"
$listener = $null
try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 8000)
    $listener.Start()
    Write-Host 'port 8000 is now in use by the smoke test'
} catch {
    Write-Host 'port 8000 was already in use'
    $listener = $null
}
$env:REMOTE_WHISPER_HOME = $busyData
$busyArgs = @('-m', 'remote_whisper', '--mock', '--no-tray', '--auto-port')
$first = Start-Process -FilePath $pythonw -ArgumentList $busyArgs -WorkingDirectory $AppDir -PassThru -WindowStyle Hidden
try {
    $portFile = Join-Path $busyData 'port.json'
    $info = $null
    for ($i = 0; $i -lt 60 -and -not $info; $i++) {
        Start-Sleep -Seconds 1
        if ($first.HasExited) { throw "the server exited early (code $($first.ExitCode))" }
        if (Test-Path $portFile) { try { $info = Get-Content $portFile -Raw | ConvertFrom-Json } catch { $info = $null } }
    }
    Assert-True ($null -ne $info) 'port.json was written'
    Assert-True ($info.port -ne 8000 -and $info.port -ne 8001) "started on another port ($($info.port)) while 8000 was in use"
    $busyBase = "http://127.0.0.1:$($info.port)"
    $ok = $false
    for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
        try { $ok = (Invoke-RestMethod "$busyBase/api/health" -TimeoutSec 3).status -eq 'ok' } catch { Start-Sleep -Seconds 1 }
    }
    Assert-True $ok 'the server answers on the other port'

    $second = Start-Process -FilePath $pythonw -ArgumentList $busyArgs -WorkingDirectory $AppDir -PassThru -WindowStyle Hidden
    $exited = $second.WaitForExit(60000)
    if (-not $exited) { & taskkill /F /T /PID $second.Id | Out-Null }
    Assert-True ($exited -and $second.ExitCode -eq 0) 'a second launch exits without starting another server'
    $after = Get-Content $portFile -Raw | ConvertFrom-Json
    Assert-True ($after.pid -eq $info.pid -and $after.port -eq $info.port) 'the first server is still the one in port.json'
    Assert-True ((Invoke-RestMethod "$busyBase/api/health").status -eq 'ok') 'the first server is still running'
} finally {
    if (-not $first.HasExited) { & taskkill /F /T /PID $first.Id | Out-Null }
    $first.WaitForExit(10000) | Out-Null
    if ($listener) { $listener.Stop() }
    $env:REMOTE_WHISPER_HOME = $DataDir
}

# 止めてすぐ、同じ番号で --auto-port 起動できる（Windows の排他の bind は、接続が残っていると
# 同じ番号に bind し直せないおそれがあるため。開いたままの接続を残して強制終了する）
$restartData = "$DataDir-restart"
$env:REMOTE_WHISPER_HOME = $restartData
$restartArgs = @('-m', 'remote_whisper', '--mock', '--no-tray', '--auto-port')
$client = $null
$run = Start-Process -FilePath $pythonw -ArgumentList $restartArgs -WorkingDirectory $AppDir -PassThru -WindowStyle Hidden
try {
    $restartFile = Join-Path $restartData 'port.json'
    $before = $null
    for ($i = 0; $i -lt 60 -and -not $before; $i++) {
        Start-Sleep -Seconds 1
        if ($run.HasExited) { throw "the server exited early (code $($run.ExitCode))" }
        if (Test-Path $restartFile) { try { $before = Get-Content $restartFile -Raw | ConvertFrom-Json } catch { $before = $null } }
    }
    Assert-True ($null -ne $before) 'port.json was written (restart test)'
    $restartBase = "http://127.0.0.1:$($before.port)"
    $ok = $false
    for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
        try { $ok = (Invoke-RestMethod "$restartBase/api/health" -TimeoutSec 3).status -eq 'ok' } catch { Start-Sleep -Seconds 1 }
    }
    Assert-True $ok 'the server answers (restart test)'
    1..5 | ForEach-Object { Invoke-RestMethod "$restartBase/api/health" | Out-Null }
    # 開いたままの接続（keep-alive）を残す
    $client = [System.Net.Sockets.TcpClient]::new('127.0.0.1', [int]$before.port)
    $bytes = [System.Text.Encoding]::ASCII.GetBytes("GET /api/health HTTP/1.1`r`nHost: 127.0.0.1:$($before.port)`r`nConnection: keep-alive`r`n`r`n")
    $client.GetStream().Write($bytes, 0, $bytes.Length)
    Start-Sleep -Seconds 1
    & taskkill /F /T /PID $run.Id | Out-Null
    $run.WaitForExit(10000) | Out-Null
    Remove-Item $restartFile -ErrorAction SilentlyContinue
    $run = Start-Process -FilePath $pythonw -ArgumentList $restartArgs -WorkingDirectory $AppDir -PassThru -WindowStyle Hidden
    $after = $null
    for ($i = 0; $i -lt 60 -and -not $after; $i++) {
        Start-Sleep -Seconds 1
        if ($run.HasExited) { throw "the restarted server exited (code $($run.ExitCode))" }
        if (Test-Path $restartFile) { try { $after = Get-Content $restartFile -Raw | ConvertFrom-Json } catch { $after = $null } }
    }
    Assert-True ($null -ne $after) 'port.json was written again'
    Assert-True ($after.port -eq $before.port) "the restarted server uses the same port ($($before.port))"
} finally {
    if ($client) { $client.Close() }
    if (-not $run.HasExited) { & taskkill /F /T /PID $run.Id | Out-Null }
    $run.WaitForExit(10000) | Out-Null
    $env:REMOTE_WHISPER_HOME = $DataDir
}
