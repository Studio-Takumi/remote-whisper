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
