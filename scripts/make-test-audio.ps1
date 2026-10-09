# テスト用の音声（架空の打ち合わせ）を Windows の音声合成で作る
# Windows PowerShell 5.1 で日本語を読めるよう、このファイルは BOM 付きの UTF-8 で保存する
# 使い方: powershell -ExecutionPolicy Bypass -File scripts\make-test-audio.ps1 -Out D:\work\test-meeting.wav
# 16kHz・モノラル・16bit の WAV を作る。WAV はコミットしない（.gitignore 済み）
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Voice = 'Microsoft Haruka Desktop'
)

Add-Type -AssemblyName System.Speech

# 架空のリリース計画の打ち合わせ
$script = @(
    '今日はリリース計画について決めていきたいと思います。',
    'まずステージング環境での確認ですが、来週の水曜日までに終わらせる予定です。',
    '負荷試験はまだ手をつけていないので、そこが一番のリスクですね。',
    '負荷試験は外部のツールを使う方向で、見積もりを今週中にもらいます。',
    'リリースノートの下書きは、開発チームで分担して書きましょう。',
    'リリース日は再来週の月曜日を目標にして、金曜日に最終判断をしましょう。'
)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SelectVoice($Voice)
} catch {
    Write-Warning "音声 '$Voice' が見つからないので、既定の音声を使います"
}
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($Out, $format)
# 言語を指定しないと英語として扱われ、日本語の文が読まれない
$prompt = New-Object System.Speech.Synthesis.PromptBuilder([System.Globalization.CultureInfo]'ja-JP')
foreach ($line in $script) {
    $prompt.AppendText($line)
    # 文の間に無音を入れる（区間の切り出しを確かめるため）
    $prompt.AppendBreak([TimeSpan]::FromMilliseconds(900))
}
$synth.Speak($prompt)
$synth.Dispose()
Write-Output "wrote $Out"
