<#
  配布用のフォルダを作る（#168。Windows）。

    pwsh packaging/build.ps1 [-OutDir packaging/out] [-Version <文字列>]

  <OutDir>/app に、Python ごと同梱したフォルダができる（構成は server/src/remote_whisper/bundle.py）。
  これを packaging/installer.iss でインストーラにする。ビルドは GitHub Actions（package.yml）で回す。
  数 GB のダウンロードと展開があるので、手元の PC では普通は回さない。

  必要なもの: uv、Node.js（画面のビルド）、git
#>
param(
    [string]$OutDir = (Join-Path $PSScriptRoot 'out'),
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 同梱する cloudflared。版と SHA256 を固定する（公式の GitHub Releases の cloudflared-windows-amd64.exe。
# SHA256 はリリースの本文の値）。上げるときは、この 2 つを一緒に変える
$CloudflaredVersion = '2026.9.3'
$CloudflaredSha256 = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'
# 同梱する Python（server/pyproject.toml の requires-python に合わせる）。python-build-standalone を uv で取る。
# 3.11.x まで固定して、同じコミットから同じ Python ができるようにする
$PythonSeries = '3.11.17'

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Server = Join-Path $Repo 'server'
$Web = Join-Path $Repo 'web'

function Invoke-Checked {
    # ネイティブのコマンドを動かし、失敗したら止める
    param([string]$Exe, [string[]]$Arguments)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed (exit code $LASTEXITCODE)" }
}

if (-not $Version) {
    $Version = (& git -C $Repo rev-parse --short HEAD)
    if ($LASTEXITCODE -ne 0 -or -not $Version) { throw 'cannot get the version from git; pass -Version' }
    $Version = "$Version".Trim()
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]*$') { throw "invalid version: $Version" }

$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$App = Join-Path $OutDir 'app'
$Work = Join-Path $OutDir 'work'
if (Test-Path $OutDir) {
    # 消してよいのは、前のビルドの出力（app/ と work/ だけがある、または空）に限る。
    # -OutDir に誤ってリポジトリ・その親・ドライブの直下・無関係なフォルダを渡しても消さない
    $out = $OutDir.TrimEnd('\')
    $unknown = @(Get-ChildItem $OutDir -Force | Where-Object { $_.Name -notin @('app', 'work') })
    # リポジトリそのもの、またはその親（リポジトリの中身ごと消えるもの）
    $isRepoOrParent = ($Repo.TrimEnd('\') + '\').StartsWith($out + '\', [System.StringComparison]::OrdinalIgnoreCase)
    if ($out -eq [System.IO.Path]::GetPathRoot($OutDir).TrimEnd('\') -or $isRepoOrParent -or $unknown.Count -gt 0) {
        throw "refusing to delete $OutDir (not an output folder of this script)"
    }
    Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Force $App, $Work | Out-Null

# 1. 同梱の Python（python-build-standalone。uv の管理下に入れて、そのフォルダをそのまま写す）
Write-Host '== Python'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $Work 'uv-python'
Invoke-Checked uv @('python', 'install', $PythonSeries)
$py = Get-ChildItem $env:UV_PYTHON_INSTALL_DIR -Directory |
    Where-Object { $_.Name -like "cpython-$PythonSeries-*" } | Select-Object -First 1
if (-not $py) { throw "Python $PythonSeries was not installed" }
$AppPython = Join-Path $App 'python'
Copy-Item -Recurse $py.FullName $AppPython
# uv の管理下の印。外すと uv pip install で直接入れられる
Get-ChildItem $AppPython -Filter 'EXTERNALLY-MANAGED' -Recurse | Remove-Item -Force
$PythonExe = Join-Path $AppPython 'python.exe'
if (-not (Test-Path (Join-Path $AppPython 'pythonw.exe'))) { throw 'pythonw.exe is missing' }

# 2. server の wheel と、uv.lock の通りの依存（faster-whisper まで。WhisperX の extra は入れない）
Write-Host '== Python packages'
$Wheels = Join-Path $Work 'wheels'
$Requirements = Join-Path $Work 'requirements.txt'
Push-Location $Server
try {
    Invoke-Checked uv @('build', '--wheel', '--out-dir', $Wheels)
    Invoke-Checked uv @('export', '--locked', '--no-dev', '--no-emit-project', '--output-file', $Requirements)
} finally {
    Pop-Location
}
Invoke-Checked uv @(
    'pip', 'install', '--python', $PythonExe, '--break-system-packages',
    '--link-mode', 'copy', '--compile-bytecode', '--require-hashes', '--requirement', $Requirements
)
$Wheel = Get-ChildItem $Wheels -Filter 'remote_whisper-*.whl' | Select-Object -First 1
if (-not $Wheel) { throw 'the wheel was not built' }
Invoke-Checked uv @(
    'pip', 'install', '--python', $PythonExe, '--break-system-packages',
    '--link-mode', 'copy', '--compile-bytecode', '--no-deps', $Wheel.FullName
)

# 3. 画面
Write-Host '== Web'
Push-Location $Web
try {
    Invoke-Checked npm @('ci')
    Invoke-Checked npm @('run', 'build')
} finally {
    Pop-Location
}
Copy-Item -Recurse (Join-Path $Web 'dist') (Join-Path $App 'web')

# 4. cloudflared（版と SHA256 を固定して、公式から取る）
Write-Host "== cloudflared $CloudflaredVersion"
$CloudflaredExe = Join-Path $App 'cloudflared.exe'
$url = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe"
Invoke-WebRequest -Uri $url -OutFile $CloudflaredExe -UseBasicParsing
$actual = (Get-FileHash $CloudflaredExe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $CloudflaredSha256) {
    Remove-Item -Force $CloudflaredExe
    throw "cloudflared SHA256 mismatch: expected $CloudflaredSha256, got $actual"
}

# 5. ビルドの印（bundle.py が見る。バージョンもここから）
@{ version = $Version; cloudflared = $CloudflaredVersion } | ConvertTo-Json |
    Set-Content -Encoding utf8 (Join-Path $App 'bundle.json')

Remove-Item -Recurse -Force $Work
$size = (Get-ChildItem $App -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ('== done: {0} ({1:N0} MB, version {2})' -f $App, ($size / 1MB), $Version)
