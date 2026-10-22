# 画面に出る日本語の文字列の一覧（#239 のレビュー用・一時的なファイル）

**このファイルはマージの前に消します。** 文言を直してほしい行に、PR の「Files changed」でコメントしてください。

- 対象: 画面（web/src）、通知（push-sw.js）、PWA の名前（vite.config.ts）、ホスト（server）の文字列。ホストの文字列は、トレイ・メニューバーと、エラーのときに画面のトーストに出るもの（`HTTPException` の detail など）
- 除いたもの: コメント・docstring・ログ、テスト、`?demo` のサンプルデータ（mock.ts）、shadcn/ui の部品、ホストの Ollama へのプロンプト（prompts.py）・ハルシネーションの語（hallucination.py）・モックの台本（mock.py）
- 「読み上げ（aria）」は画面には見えない文字列（スクリーンリーダー用）。#239 では変えていない
- 行の番号は、このファイルを足したコミットのもの。リンクはそのコミットのコード

## web/src/App.tsx
全部で 797 行。


- [L106](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/App.tsx#L106) `toast.success('設定を保存しました');`

## web/src/api.ts

- [L24](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/api.ts#L24) `throw new ApiError(0, 'ホストにつながりません');`

## web/src/audio/microphone.ts

- [L76](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/audio/microphone.ts#L76) `throw new MicrophoneError('unavailable', 'このページではマイクを使えません（HTTPS で開いてください）');`
- [L85](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/audio/microphone.ts#L85) `throw new MicrophoneError('denied', 'マイクの使用が許可されていません');`
- [L87](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/audio/microphone.ts#L87) throw new MicrophoneError('unavailable', `マイクを開けません: ${(e as Error).message}`);
- [L103](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/audio/microphone.ts#L103) throw new MicrophoneError('unavailable', `音声の処理を始められません: ${(e as Error).message}`);

## web/src/components/AccountDialog.tsx

- [L55](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L55) toast.error(`外せません: ${(e as Error).message}`);
- [L67](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L67) toast.error(`変更できません: ${(e as Error).message}`);
- [L78](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L78) toast.error(`退会できません: ${(e as Error).message}`);
- [L84](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L84) `toast.success('退会しました');`
- [L97](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L97) `<DialogTitle>アカウント</DialogTitle>`
- [L98](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L98) <DialogDescription>{me ? `${me.displayName} でログインしています` : ''}</DialogDescription>
- [L103](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L103) `<h3 className='font-medium'>ログインの手段</h3>`
- [L115](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L115) `title={canRemove(me) ? undefined : '最後のログインの手段は外せません'}`
- [L118](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L118) `外す`
- [L127](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L127) `{PROVIDER_LABELS[p]} を足す`
- [L137](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L137) `データ収集を許可する`
- [L148](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L148) `現在は収集していません。収集を始めるときは、何を何に使うかをここに書きます`
- [L153](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L153) `ログアウト`
- [L158](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L158) `アカウントとホストの登録を消します。元に戻せません`
- [L161](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L161) `退会する`
- [L166](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AccountDialog.tsx#L166) `退会…`

## web/src/components/AnnouncementBanner.tsx

- [L58](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AnnouncementBanner.tsx#L58) `詳しく見る`
- [L65](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AnnouncementBanner.tsx#L65)（読み上げ（aria）） `aria-label='閉じる'`

## web/src/components/AppSidebar.tsx

- [L54](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AppSidebar.tsx#L54) `tooltip='新規プロジェクト作成'`
- [L61](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AppSidebar.tsx#L61) `<span>新規プロジェクト作成</span>`
- [L104](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AppSidebar.tsx#L104) `tooltip='設定'`
- [L111](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AppSidebar.tsx#L111) `<span>設定</span>`
- [L118](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AppSidebar.tsx#L118) `tooltip='アカウント'`
- [L125](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AppSidebar.tsx#L125) `<span>アカウント</span>`

## web/src/components/AudioUpload.tsx

- [L15](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AudioUpload.tsx#L15) `const label = '音声ファイルから作る';`
- [L54](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/AudioUpload.tsx#L54) `{uploading.name} をアップロードしています… {uploading.percent}%`

## web/src/components/CloudEntry.tsx

- [L13](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudEntry.tsx#L13) `hosts: { title: 'ホストの選択', body: '使うホスト（文字起こしをするマシン）を選ぶ画面が入ります（#161）' },`
- [L14](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudEntry.tsx#L14) `ready: { title: 'ホストにつながっています', body: '' },`
- [L47](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudEntry.tsx#L47) `<p className='text-xs text-muted-foreground'>Remote Whisper（クラウド版・準備中）</p>`
- [L50](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudEntry.tsx#L50) `<h1 className='text-xl font-semibold'>ログイン</h1>`
- [L51](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudEntry.tsx#L51) `{checked ? <LoginButtons /> : <p className='text-sm text-muted-foreground'>確かめています…</p>}`
- [L57](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudEntry.tsx#L57) `<p className='text-sm text-muted-foreground'>確かめています…</p>`
- [L67](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudEntry.tsx#L67) `{me.displayName} でログインしています`
- [L69](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudEntry.tsx#L69) `ログアウト`

## web/src/components/CloudHostBadge.tsx

- [L18](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudHostBadge.tsx#L18) `title='押すとホストを切り替える'`
- [L23](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/CloudHostBadge.tsx#L23) `<span className='truncate'>{name ?? 'ホスト'} につないでいます</span>`

## web/src/components/ConsentForm.tsx

- [L30](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L30) toast.error(`同意を送れませんでした: ${(e as Error).message}`);
- [L44](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L44) `toast.error('同意は送れましたが、状態を取り直せませんでした。もう一度「同意して進む」を押してください');`
- [L52](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L52) `<h1 className='text-xl font-semibold'>利用規約への同意</h1>`
- [L54](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L54) `使い始める前に、`
- [L56](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L56) `利用規約`
- [L58](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L58) `と`
- [L60](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L60) `プライバシーポリシー`
- [L62](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L62) `をお読みください`
- [L66](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L66) `<Label htmlFor='consent-tos'>利用規約とプライバシーポリシーに同意する</Label>`
- [L70](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L70) `<Label htmlFor='consent-data'>データ収集を許可する（任意）</Label>`
- [L80](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L80) `現在は収集していません。収集を始めるときは、何を何に使うかをここに書きます。あとから設定で変えられます`
- [L84](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L84) `同意して進む`
- [L88](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L88) `進むには、利用規約とプライバシーポリシーへの同意が必要です`
- [L92](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L92) `{me.displayName} でログインしています`
- [L94](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ConsentForm.tsx#L94) `ログアウト`

## web/src/components/ContextSetSheet.tsx

- [L17](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L17) `generating: '（作成中…）',`
- [L19](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L19) `failed: '（失敗）',`
- [L42](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L42) `参考資料`
- [L46](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L46) {current ? `${contextSetName(current)}${statusLabel[current.status]}` : 'なし'}
- [L53](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L53) `<SheetTitle>参考資料</SheetTitle>`
- [L55](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L55) `選んだ資料から用語リストとコンテキストを作り、文字起こしと要約に使います（プロジェクトごと）`
- [L60](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L60) `<p className='text-xs text-muted-foreground'>プロジェクト：{project.name}</p>`
- [L70](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L70) `<SelectItem value={NONE}>使わない</SelectItem>`
- [L82](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L82) `作成中です。録音を始めても、できた時点から使います`
- [L87](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L87) `資料を選んで新しく作る`
- [L90](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L90) `用語リストを使う`
- [L98](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L98) `コンテキストを使う`
- [L108](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L108) `録音中に用語を拾う`
- [L111](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L111) `? '文字起こしに何度も出てくる固有名詞・専門用語を、用語リストに足す'`
- [L112](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L112) `: '設定（要約）でオフになっています'}`
- [L123](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ContextSetSheet.tsx#L123) `<p className='px-4 text-sm text-muted-foreground'>先にメニューからプロジェクトを選んでください。</p>`

## web/src/components/DensitySelect.tsx

- [L5](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DensitySelect.tsx#L5) `{ value: 1, label: '1 ごく短く' },`
- [L6](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DensitySelect.tsx#L6) `{ value: 2, label: '2 短め' },`
- [L7](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DensitySelect.tsx#L7) `{ value: 3, label: '3 ふつう' },`
- [L8](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DensitySelect.tsx#L8) `{ value: 4, label: '4 詳しく' },`
- [L9](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DensitySelect.tsx#L9) `{ value: 5, label: '5 できるだけ細かく' },`

## web/src/components/DevPanel.tsx

- [L26](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DevPanel.tsx#L26) `<p className='font-semibold'>開発用</p>`
- [L44](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DevPanel.tsx#L44) `label='接続'`
- [L50](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DevPanel.tsx#L50) `label='マイク'`
- [L56](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DevPanel.tsx#L56) `プロジェクトを空にする`
- [L64](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/DevPanel.tsx#L64)（読み上げ（aria）） `aria-label='開発用パネル'`

## web/src/components/GpuIndicator.tsx

- [L33](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L33)（読み上げ（aria）） `aria-label='GPU の状態とジョブの一覧'`
- [L47](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L47) `待ち {waitingCount}`
- [L76](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L76) `使用率 {gpu.util}% ・ VRAM {(gpu.memUsedMb / 1024).toFixed(1)} /{' '}`
- [L80](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L80) `<p className='text-xs text-muted-foreground'>使用率は取れません（NVIDIA の GPU がないなど）</p>`
- [L84](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L84) `<h3 className='text-xs font-semibold text-muted-foreground'>実行中</h3>`
- [L89](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L89) time={`${formatElapsed(Math.floor(jobs.running.runningSec + since))} 経過`}
- [L92](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L92) `<p className='text-xs text-muted-foreground'>なし</p>`
- [L96](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L96) `<h3 className='text-xs font-semibold text-muted-foreground'>待っている（実行する順）</h3>`
- [L104](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L104) time={`${formatElapsed(Math.floor(w.waitingSec + since))} 待ち`}
- [L110](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L110) `<p className='text-xs text-muted-foreground'>なし</p>`
- [L114](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/GpuIndicator.tsx#L114) `GPU は 1 つずつ順に使います。要約を作っている間は、文字起こしが待たされます`

## web/src/components/HostPicker.tsx

- [L66](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L66) `<h1 className='text-xl font-semibold'>ホストの選択</h1>`
- [L68](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L68) `ホストの一覧を読めませんでした: {error}`
- [L71](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L71) `もう一度`
- [L79](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L79) `ホストを確かめています…`
- [L86](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L86) `<h1 className='text-xl font-semibold'>PC を登録してください</h1>`
- [L87](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L87) `<p className='text-sm'>文字起こしをする PC（ホスト）が、まだ登録されていません。</p>`
- [L89](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L89) `<li>PC で Remote Whisper を起動する</li>`
- [L90](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L90) `<li>タスクトレイ（Mac はメニューバー）のアイコンから「クラウド版にログイン」を選ぶ</li>`
- [L91](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L91) `<li>開いた画面で、トレイと同じコードが出ているのを確かめて承認する</li>`
- [L95](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L95) `登録したので確かめる`
- [L102](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L102) `<h1 className='text-xl font-semibold'>ホストを選ぶ</h1>`
- [L117](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L117) `{h.online === true ? 'オンライン' : h.online === false ? 'オフライン' : ''}`
- [L125](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L125) `どの PC もオフラインです。PC で Remote Whisper が動いているか確かめてください`
- [L130](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostPicker.tsx#L130) `一覧を読み直す`

## web/src/components/HostsSection.tsx

- [L28](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L28) toast.error(`名前を変えられません: ${(e as Error).message}`);
- [L35](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L35) toast.success(`${host.name} を外しました`);
- [L41](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L41) toast.error(`外せません: ${(e as Error).message}`);
- [L56](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L56)（読み上げ（aria）） `aria-label='ホストの名前'`
- [L63](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L63) `保存`
- [L66](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L66) `やめる`
- [L74](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L74) `{host.online === true ? 'オンライン' : host.online === false ? 'オフライン' : ''}`
- [L81](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L81)（読み上げ（aria）） aria-label={`${host.name} の名前を変える`}
- [L87](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L87) `名前`
- [L92](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L92)（読み上げ（aria）） aria-label={`${host.name} を外す`}
- [L94](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L94) `title={locked ? '録音中は、つないでいるホストを外せません' : undefined}`
- [L97](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L97) `外す`
- [L105](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L105) `外すと、この端末はクラウド版からつながらなくなります`
- [L108](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L108) `外す`
- [L111](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L111) `やめる`
- [L130](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L130) `<h3 className='font-medium'>ホスト（文字起こしをする PC）</h3>`
- [L132](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L132) `<p className='text-xs text-muted-foreground'>読み込んでいます…</p>`
- [L135](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/HostsSection.tsx#L135) `まだありません。PC のトレイの「クラウド版にログイン」から登録します`

## web/src/components/LiveSummary.tsx

- [L12](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/LiveSummary.tsx#L12) `const OVERVIEW = 'ここまでの概要';`
- [L66](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/LiveSummary.tsx#L66) `（続いている要約区間）`

## web/src/components/LoginButtons.tsx

- [L13](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/LoginButtons.tsx#L13) `{PROVIDER_LABELS[p]} でログイン`

## web/src/components/MaterialPickerDialog.tsx

- [L47](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MaterialPickerDialog.tsx#L47) `<DialogTitle>参考資料を選ぶ</DialogTitle>`
- [L49](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MaterialPickerDialog.tsx#L49) `選んだ資料から用語リストとコンテキストを作ります（数分かかります）`
- [L93](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MaterialPickerDialog.tsx#L93) `<Message>フォルダの一覧を取れません: {error}</Message>`
- [L95](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MaterialPickerDialog.tsx#L95) `<Message>読み込んでいます…</Message>`
- [L97](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MaterialPickerDialog.tsx#L97) `<Message>読み込めるフォルダがありません。設定の「参考資料」で追加してください。</Message>`
- [L113](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MaterialPickerDialog.tsx#L113) `<p className='text-xs text-muted-foreground'>読み込める拡張子：{extensions.join(', ')}</p>`
- [L115](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MaterialPickerDialog.tsx#L115) `<p className='mr-auto text-xs text-muted-foreground'>{selected.length} 件選択中</p>`
- [L117](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MaterialPickerDialog.tsx#L117) `<Button variant='outline'>キャンセル</Button>`
- [L120](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MaterialPickerDialog.tsx#L120) `この資料で作成`

## web/src/components/MicAlert.tsx

- [L54](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicAlert.tsx#L54) `マイクを開き直す`

## web/src/components/MicButton.tsx

- [L110](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L110) label: `「${recordingTitle ?? '新しいセッション'}」で${state === 'paused' ? '一時停止中' : '録音中'}です。クリックで戻ります`,
- [L118](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L118) `label: 'クリックして一時停止',`
- [L126](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L126) `label: 'クリックして録音再開',`
- [L134](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L134) `onClick: () => toast.info('ほかの端末で録音中です。操作はその端末でしてください'),`
- [L135](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L135) label: `${describeWatched(watchedState)}です。この端末では閲覧専用です`,
- [L144](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L144) label: `クリックして続きから録音（録音を終えてから ${windowMin} 分の間は、続きから録音できます。${describeLeft(continueLeft)}）`,
- [L145](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L145) `hint: '押すと続きから録音',`
- [L152](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L152) label: `クリックして「${target.projectName}」に新しいセッションを作成`,
- [L153](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L153) `hint: '押すと新しいセッション',`
- [L161](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L161) `label: 'マイクが許可されていません。ブラウザの設定でマイクを許可してください',`
- [L162](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L162) `hint: 'マイクが許可されていません',`
- [L169](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L169) `label: 'クリックして録音開始',`
- [L170](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L170) `hint: '押すと録音開始',`
- [L176](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L176) `label: '録音するプロジェクトをメニューから選んでください',`
- [L177](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L177) `hint: 'プロジェクトを選んでください',`
- [L237](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L237)（読み上げ（aria）） `aria-label='クリックして録音終了'`
- [L241](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L241) `終了`
- [L245](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/MicButton.tsx#L245) `<TooltipContent side='right'>クリックして録音終了</TooltipContent>`

## web/src/components/ModelsPage.tsx

- [L16](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L16) `return missing ? <p className='text-amber-700 dark:text-amber-400'>入っていません</p> : null;`
- [L63](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L63) `処理ごとのモデルです。薄い文字のものは表示だけで、選べません`
- [L72](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L72) `おすすめに戻す`
- [L75](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L75) `<Section title='参考資料' description='Ollama で、資料から用語リストとコンテキストを作ります'>`
- [L76](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L76) `{ollamaRow('materialTerms', '用語リスト（資料抽出）')}`
- [L77](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L77) `{ollamaRow('context', 'コンテキスト', thinkingNote(options, models.context))}`
- [L78](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L78) `{ollamaRow('scope', '範囲の判断', '資料のどこを使うかを判断します。小さいモデルでは答えが安定しません')}`
- [L80](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L80) `<Section title='リアルタイム文字起こし'>`
- [L81](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L81) `<Row id='model-vad' label='無音区間の判別'>`
- [L84](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L84) `<Row id='whisper-model' label='文字起こし' locked={whisperLocked}>`
- [L92](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L92) `{ollamaRow('transcriptTerms', '用語リスト（文字起こし抽出）')}`
- [L94](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L94) `<Section title='浄書' description='録音終了後に、録音全体から作り直します'>`
- [L95](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L95) `<Row id='model-final-transcript' label='文字起こし'>`
- [L96](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L96) `<Fixed>WhisperX（Whisper: {whisperModel}。リアルタイム文字起こしと同じ）</Fixed>`
- [L98](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L98) `<Row id='model-align' label='時刻合わせ'>`
- [L101](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L101) `<Row id='model-diarize' label='話者分け'>`
- [L105](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L105) `<Section title='リアルタイム要約' description='録音中に数分おきに作ります（思考モードはオフ）'>`
- [L106](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L106) `{ollamaRow('liveSummary', '要約')}`
- [L107](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L107) `{ollamaRow('liveTitle', 'タイトル')}`
- [L109](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L109) `<Section title='最終要約' description='録音終了後に作ります'>`
- [L110](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L110) `{ollamaRow('overview', '全体概要', thinkingNote(options, models.overview))}`
- [L111](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L111) `{ollamaRow('detail', '要約詳細', thinkingNote(options, models.detail))}`
- [L112](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ModelsPage.tsx#L112) `{ollamaRow('finalTitle', 'タイトル')}`

## web/src/components/NewProjectDialog.tsx

- [L32](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/NewProjectDialog.tsx#L32) `<DialogTitle>新規プロジェクト作成</DialogTitle>`
- [L34](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/NewProjectDialog.tsx#L34) `プロジェクトにするフォルダを選んでください。最終要約のコピーはこのフォルダに置かれます`
- [L59](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/NewProjectDialog.tsx#L59) `<Message>フォルダの一覧を取れません: {error}</Message>`
- [L61](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/NewProjectDialog.tsx#L61) `<Message>読み込んでいます…</Message>`
- [L63](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/NewProjectDialog.tsx#L63) `<Message>読み込めるフォルダがありません。設定の「参考資料」で追加してください。</Message>`
- [L81](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/NewProjectDialog.tsx#L81) `{selected ?? 'フォルダを選んでください'}`
- [L84](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/NewProjectDialog.tsx#L84) `<Button variant='outline'>キャンセル</Button>`
- [L87](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/NewProjectDialog.tsx#L87) `このフォルダで作成`

## web/src/components/PairPage.tsx

- [L24](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L24) message: `${request.hostName} は、ほかのアカウントで承認されています。心当たりがなければ、PC のトレイから「クラウド版から外す」を選んでください`,
- [L26](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L26) : { kind: 'done', message: `${request.hostName} は登録済みです` };
- [L29](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L29) `return { kind: 'done', message: 'この登録は拒否されたか、取り消されました' };`
- [L63](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L63) message: `${request.hostName} を登録しました。PC のトレイにも通知が出ます`,
- [L67](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L67) `setView({ kind: 'done', message: '登録を拒否しました' });`
- [L78](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L78) `<p className='text-xs text-muted-foreground'>Remote Whisper（クラウド版）</p>`
- [L79](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L79) `<h1 className='text-xl font-semibold'>ホストの登録</h1>`
- [L81](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L81) `<p className='text-sm text-muted-foreground'>確かめています…</p>`
- [L84](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L84) `<p className='text-sm'>ログインしてから、登録する PC を確かめます。</p>`
- [L88](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L88) `<p className='text-sm text-muted-foreground'>読み込んでいます…</p>`
- [L95](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L95) `<a href='/'>Remote Whisper を開く</a>`
- [L101](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L101) `<span className='font-medium'>{view.request.hostName}</span> を {me.displayName}{' '}`
- [L102](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L102) `のアカウントに登録しますか？`
- [L109](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L109) `のトレイの通知に出ているコードと同じか確かめてください。違うときや、心当たりがないときは拒否してください`
- [L113](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L113) `承認する`
- [L116](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PairPage.tsx#L116) `拒否する`

## web/src/components/ProjectList.tsx

- [L41](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L41) return `${started} · 録音中`;
- [L48](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L48)（読み上げ（aria）） `draggable: 'プロジェクトの並び順は、Space で持ち上げ、上下の矢印で動かし、Space で置きます。Esc でやめます',`
- [L112](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L112) `return <p className='px-2 text-xs text-muted-foreground'>プロジェクトはまだありません</p>;`
- [L157](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L157)（読み上げ（aria）） onDragStart: ({ active }) => `「${nameOf(active.id)}」を持ち上げました`,
- [L159](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L159) over ? `「${nameOf(active.id)}」を「${nameOf(over.id)}」の位置に動かしています` : undefined,
- [L162](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L162) ? `「${nameOf(active.id)}」を「${nameOf(over.id)}」の位置に置きました`
- [L163](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L163) : `「${nameOf(active.id)}」を戻しました`,
- [L164](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L164)（読み上げ（aria）） onDragCancel: ({ active }) => `「${nameOf(active.id)}」の移動をやめました`,
- [L284](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L284)（読み上げ（aria）） aria-label={`${project.name}の並び順を変える`}
- [L297](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L297)（読み上げ（aria）） aria-label={`${project.name}で新しく録音`}
- [L359](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L359)（読み上げ（aria）） `aria-label='音声ファイルから作成'`
- [L364](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ProjectList.tsx#L364)（読み上げ（aria）） `<span className='ml-auto size-2 shrink-0 rounded-full bg-red-500' aria-label='録音中' />`

## web/src/components/PushToggle.tsx

- [L22](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PushToggle.tsx#L22) `toast.success('最終要約ができたら、この端末に通知します');`
- [L28](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PushToggle.tsx#L28) `toast.error(e instanceof Error ? e.message : '通知を設定できませんでした');`
- [L41](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PushToggle.tsx#L41) `label='最終要約の通知'`

## web/src/components/PwaUpdater.tsx

- [L41](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PwaUpdater.tsx#L41) `toast.warning('画面の一部を読み込めません（ホストが新しいバージョンになりました）', {`
- [L42](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PwaUpdater.tsx#L42) `description: '読み込み直すと直ります',`
- [L44](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PwaUpdater.tsx#L44) `action: { label: '読み込み直す', onClick: () => location.reload() },`
- [L61](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PwaUpdater.tsx#L61) `const id = toast.info('新しいバージョンの画面があります', {`
- [L62](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PwaUpdater.tsx#L62) `description: recording ? '録音を終えてから更新してください' : '更新すると、読み込み直します',`
- [L64](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/PwaUpdater.tsx#L64) `action: recording ? undefined : { label: '更新', onClick: () => void updateServiceWorker(true) },`

## web/src/components/RecordingLock.tsx

- [L6](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/RecordingLock.tsx#L6) `message = '録音中は設定を変更できません',`

## web/src/components/RecordingPlayer.tsx

- [L28](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/RecordingPlayer.tsx#L28)（読み上げ（aria）） `aria-label='録音を再生'`

## web/src/components/SessionTerms.tsx

- [L40](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L40) ...(failed.length > 0 ? [`足せませんでした（${failed.length} 語）`] : []),
- [L62](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L62) `用語`
- [L70](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L70) `title='手で足した語を外す'`
- [L78](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L78) `title='誤った語なら外す（このセッションでは、以後足さない）'`
- [L85](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L85) `placeholder='用語を足す'`
- [L86](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L86)（読み上げ（aria）） `aria-label='用語を足す'`
- [L113](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L113) `置き換え`
- [L123](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L123)（読み上げ（aria）） aria-label={`置き換え「${c.from} → ${c.to}」を外す`}
- [L124](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L124) `title='外す（以後は当たらない。もう直した行は戻さない）'`
- [L139](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L139) `<p className='text-muted-foreground'>浄書済み文字起こしを再生成すると反映されます</p>`
- [L163](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionTerms.tsx#L163)（読み上げ（aria）） aria-label={`「${term}」を用語リストから外す`}

## web/src/components/SessionView.tsx

- [L119](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L119) `<TabsTrigger value='transcript'>文字起こし</TabsTrigger>`
- [L120](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L120) `<TabsTrigger value='summary'>要約</TabsTrigger>`
- [L139](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L139) `<span className='ml-2 text-xs font-normal text-muted-foreground'>（仮のタイトル）</span>`
- [L146](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L146) `? '・録音中'`
- [L147](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L147) : `・${describeWatched(watching?.sessionId === session.id ? watching.state : undefined)}（この端末では閲覧専用です）`)}
- [L148](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L148) `{session.status === 'interrupted' && '・途中で中断'}`
- [L152](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L152) `音声ファイルから作成`
- [L168](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L168) `続きから録音`
- [L181](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L181) `<h1 className='text-lg font-semibold'>新しいセッション</h1>`
- [L183](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L183) `{project.name}（{project.path}）に録音します`
- [L189](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L189) `音声ファイル（wav・mp3・m4a など）をドロップしても作れます`
- [L204](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L204) `{session && !session.loaded && <p className='text-sm text-muted-foreground'>読み込んでいます…</p>}`
- [L206](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L206) `<p className='text-sm text-muted-foreground'>文字起こしは期限切れのため消えています。</p>`
- [L240](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L240) `<p className='text-sm text-muted-foreground'>マイクボタンを押すと録音が始まります。</p>`
- [L244](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L244) `ほかのセッションで録音中です。終えると、ここから録音できます`
- [L259](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L259) `録音が始まると、{liveIntervalMin} 分おきにリアルタイム要約がここに出ます`
- [L350](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L350) `{whisperModel} で{final ? '再生成する' : '浄書する'}`
- [L360](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L360) `text: final ? '浄書済み文字起こしを再生成しています…' : '浄書中…',`
- [L365](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L365) `<p className='text-xs text-muted-foreground'>録音ファイルがないため、再生成できません。</p>`
- [L383](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L383) [g.model, showSpeakers && g.diarization === 'done' ? `話者 ${g.speakers} 人` : null, g.generatedAt]
- [L385](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L385) `.join('・');`
- [L398](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L398)（読み上げ（aria）） `<SelectTrigger size='sm' className='text-xs' aria-label='表示する浄書済み文字起こし'>`
- [L410](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L410) <span className='text-xs text-muted-foreground'>{`浄書済み文字起こし（${label(final)}）`}</span>
- [L415](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L415) `<p className='text-xs text-muted-foreground'>{whisperModel} の浄書済み文字起こしはまだありません。</p>`
- [L419](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L419) `話者分けはできませんでした（HuggingFace のトークンまたはモデルの利用条件への同意がありません）`
- [L459](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L459) const status = <StatusIndicator status={{ tone: 'active', text: `${generating.model} で要約を作成中…` }} />;
- [L473](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L473) `? { label: '今の要約（再生成した要約が届き次第差し替えます）', text: summary.text, live: false }`
- [L475](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L475) `? { label: 'リアルタイム要約（最終要約が届き次第差し替えます）', text: live, live: true }`
- [L511](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L511) `{finalModel} で{summary ? '再生成する' : '要約を作る'}`
- [L525](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L525) `{summary ? '直近の要約の再生成に失敗しました' : '最終要約を作れませんでした'}`
- [L530](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L530) `? '文字起こしが残っていないため、再生成できません'`
- [L531](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L531) `: 'ほかの要約を作り終えてから、再生成してください'`
- [L533](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L533) `? 'Ollama には今つながっています。再生成してください（保存に失敗した場合は、ディスクの空きも確かめてください）'`
- [L534](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L534) `: 'Ollama に接続できません。動いているか確かめてから再生成してください'}`
- [L550](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L550) `リアルタイム要約{session.status === 'recording' ? '（録音中に数分おきに更新します）' : ''}`
- [L566](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L566) `{expired(session, 'summary') ? '要約は期限切れのためありません' : 'まだ要約がありません'}`
- [L575](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L575) `${finalModelLabel({ ...models, overview: s.overviewModel ?? s.model, detail: s.model })} で生成・${s.generatedAt}`;
- [L587](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L587)（読み上げ（aria）） `<SelectTrigger size='sm' className='text-xs' aria-label='表示する要約'>`
- [L605](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L605) `title='要約を Markdown のままコピーします'`
- [L608](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L608) `() => toast.success('要約をコピーしました'),`
- [L609](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L609) `() => toast.error('要約をコピーできませんでした'),`
- [L614](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L614) `コピー`
- [L620](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L620) `<p className='text-xs text-muted-foreground'>{finalModel} の要約はまだありません。</p>`
- [L660](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L660) `<p className='text-lg font-semibold text-foreground'>見つかりません</p>`
- [L661](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L661) `<p className='max-w-md text-sm'>このセッションまたはプロジェクトは、消えたか期限切れです。</p>`
- [L672](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L672) `{hasProjects ? 'セッションを開くか、新しく録音しましょう' : 'まずはプロジェクトを作りましょう'}`
- [L676](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L676) `? 'メニューからセッションを開くか、プロジェクトの ＋ で新しく作れます'`
- [L677](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SessionView.tsx#L677) `: 'メニューの「新規プロジェクト作成」から、録音をまとめるフォルダを選んでください'}`

## web/src/components/SettingsDialog.tsx

- [L80](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L80) `<DialogTitle>設定</DialogTitle>`
- [L82](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L82) `{recording ? '全体設定（録音中は一部の項目は変更不可）' : '全体設定（どの端末でも共通）'}`
- [L171](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L171) `モデル`
- [L175](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L175) `参考資料`
- [L179](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L179) `録音`
- [L183](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L183) `文字起こし`
- [L187](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L187) `要約`
- [L191](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L191) `保存`
- [L195](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L195) `表示・その他`
- [L203](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L203) `label='計算の精度'`
- [L205](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L205) `description='int8 にすると VRAM が減りますが、精度が少し落ちます'`
- [L216](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L216) `label='ビームサイズ'`
- [L217](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L217) `description='大きいほど精度が上がりますが、遅くなります'`
- [L226](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L226) `<Row id='partial-interval' label='途中結果の間隔'>`
- [L232](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L232) `unit='秒'`
- [L236](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L236) `<Row id='silence-ms' label='区切りとみなす無音' locked={lock(recordingLocks.segmentation)}>`
- [L242](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L242) `unit='ミリ秒'`
- [L246](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L246) `<Row id='max-segment' label='チャンクの最大の長さ' locked={lock(recordingLocks.segmentation)}>`
- [L251](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L251) `unit='秒'`
- [L257](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L257) `label='話し声の判定'`
- [L259](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L259) `description='自動では Silero VAD で判定し、手動では音量で判定します'`
- [L272](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L272) `<SelectItem value='auto'>自動</SelectItem>`
- [L273](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L273) `<SelectItem value='manual'>手動（音量）</SelectItem>`
- [L281](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L281) `label='手動のときの音量'`
- [L283](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L283) `description='この音量より大きい音を話し声とみなします（-70〜-10）'`
- [L297](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L297) `label='浄書'`
- [L298](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L298) `description='録音終了後、文字起こしが読みやすくなるように浄書します'`
- [L308](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L308) `label='話者分け'`
- [L309](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L309) `description='浄書済み文字起こしを「話者 1」などに分けます。HuggingFace のトークンやモデルの利用条件への同意が必要です'`
- [L318](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L318) `<Row id='unload-after' label='録音終了後にモデルを停止するまでの時間'>`
- [L323](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L323) `unit='分'`
- [L342](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L342) `<Row id='ollama-host' label='Ollama の URL'>`
- [L351](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L351) `<Section title='要約度' description='1 は要点だけで、5 になるにつれてより細かくなります'>`
- [L352](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L352) `<Row id='live-density' label='リアルタイム要約' description='約 4000 文字ごとの要約'>`
- [L361](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L361) `label='全体概要'`
- [L362](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L362) `description='長い録音で、一番上に置く「全体概要」の箇条書き'`
- [L372](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L372) `label='要約詳細'`
- [L373](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L373) `description='部分ごとの要約（短い録音では要約そのもの）'`
- [L385](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L385) `label='参考資料のページの表示'`
- [L386](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L386) `description='要約詳細の項目に「〇〇.pdf p.12 の内容」のように資料の該当ページを表示します（PDF のみ）'`
- [L394](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L394) `<Row id='live-interval' label='リアルタイム要約の間隔'>`
- [L399](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L399) `unit='分'`
- [L405](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L405) `label='録音中の用語抽出'`
- [L406](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L406) `description='GPU の負荷が上がります。参考資料のスイッチもオンのときだけ抽出します'`
- [L414](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L414) `<Row id='keep-alive' label='要約後にモデルを停止するまでの時間'>`
- [L419](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L419) `unit='分'`
- [L428](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L428) `<Row id='max-concurrent' label='同時に録音できる数'>`
- [L436](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L436) `<Row id='resume-timeout' label='接続が切れたときに待つ時間'>`
- [L441](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L441) `unit='分'`
- [L445](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L445) `<Row id='continue-window' label='録音を終えても、続きから録音できる時間'>`
- [L450](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L450) `unit='分'`
- [L454](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L454) `<Row id='noise-suppression' label='ブラウザの雑音抑制' locked={lock(recordingLocks.microphone)}>`
- [L463](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L463) `label='ブラウザの自動音量調整'`
- [L474](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L474) `label='ブラウザのエコー除去'`
- [L487](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L487) `<Section title='保存期間' description='期間を過ぎたファイルは自動で消えます。0 にすると無期限です'>`
- [L488](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L488) `<Row id='keep-recording' label='録音ファイル'>`
- [L493](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L493) `unit='日'`
- [L497](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L497) `<Row id='keep-transcript' label='文字起こし'>`
- [L502](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L502) `unit='日'`
- [L506](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L506) `<Row id='keep-summary' label='要約' description='選んだディレクトリに置いたコピーは消しません'>`
- [L511](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L511) `unit='日'`
- [L515](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L515) `<Row id='keep-context' label='参考資料'>`
- [L520](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L520) `unit='日'`
- [L528](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L528) `<Section title='読み込めるフォルダ'>`
- [L536](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L536)（読み上げ（aria）） aria-label={`フォルダ ${i + 1}`}
- [L548](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L548)（読み上げ（aria）） `aria-label='このフォルダを外す'`
- [L566](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L566) `フォルダを追加`
- [L570](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L570) `<Section title='読み込める拡張子'>`
- [L571](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L571) `<Row id='extensions' label='拡張子'>`
- [L584](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L584) `<Row id='session-meta' label='サイドバーの録音日時と長さ'>`
- [L591](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L591) `<Row id='show-picked-terms' label='用語リスト（文字起こし抽出）の表示'>`
- [L598](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L598) `<Row id='show-speakers' label='話者の表示'>`
- [L605](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L605) `<Row id='mic-shortcut' label='マイクボタンのショートカット'>`
- [L614](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L614) `<Section title='この端末' description='保存を押さなくても、切り替えた時点で効きます'>`
- [L626](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L626) `<Button variant='outline'>キャンセル</Button>`
- [L628](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/SettingsDialog.tsx#L628) `<Button onClick={save}>保存</Button>`

## web/src/components/ShortcutInput.tsx

- [L22](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ShortcutInput.tsx#L22) `const modifiers = isMacPlatform() ? '⌃・⌥・⇧・⌘' : 'Ctrl・Alt・Shift・Win';`
- [L46](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ShortcutInput.tsx#L46) `const label = capturing ? 'キーを押してください…' : value === '' ? '使わない' : formatShortcut(value);`
- [L83](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ShortcutInput.tsx#L83) `既定に戻す`
- [L86](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ShortcutInput.tsx#L86) `使わない`
- [L91](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ShortcutInput.tsx#L91) {error ? `${modifiers} のどれかと一緒に押してください` : 'Esc で取り消します'}

## web/src/components/ThemeToggle.tsx

- [L10](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ThemeToggle.tsx#L10) `{ value: 'system', label: 'OS に合わせる', icon: MonitorIcon },`
- [L11](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ThemeToggle.tsx#L11) `{ value: 'light', label: 'ライト', icon: SunIcon },`
- [L12](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ThemeToggle.tsx#L12) `{ value: 'dark', label: 'ダーク', icon: MoonIcon },`
- [L23](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ThemeToggle.tsx#L23) const label = `テーマ: ${current.label}`;
- [L27](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ThemeToggle.tsx#L27) tooltip={`${label}（押すと「${next.label}」に切り替えます）`}
- [L41](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/ThemeToggle.tsx#L41) `<Row id='theme' label='テーマ'>`

## web/src/components/TopBar.tsx

- [L44](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TopBar.tsx#L44) `モデル`
- [L49](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TopBar.tsx#L49)（読み上げ（aria）） `aria-label='モデルの設定を開く'`
- [L67](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TopBar.tsx#L67)（読み上げ（aria）） `<SidebarTrigger className='size-9 md:hidden' aria-label='メニューを開く' />`
- [L71](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TopBar.tsx#L71) `<RecordingLock locked={recording} message='録音中はホストを切り替えられません'>`

## web/src/components/Transcript.tsx

- [L72](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/Transcript.tsx#L72) `再生位置に戻る`
- [L107](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/Transcript.tsx#L107)（読み上げ（aria）） aria-label={`${line.time} から再生`}
- [L122](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/Transcript.tsx#L122) `const SPEAKER_RE = /^話者 (\d+): (.*)$/s;`
- [L153](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/Transcript.tsx#L153) <span className={`mr-1.5 rounded px-1.5 py-0.5 text-xs whitespace-nowrap ${color}`}>話者 {m[1]}</span>

## web/src/components/TranscriptCorrection.tsx

- [L125](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TranscriptCorrection.tsx#L125) toast.success(`「${picked.wrong}」を「${value}」に置き換え、用語に足しました`);
- [L141](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TranscriptCorrection.tsx#L141)（読み上げ（aria）） `aria-label='選んだ文字を置き換える'`
- [L159](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TranscriptCorrection.tsx#L159) `<p>置き換わる箇所はありません（すでに『{value}』になっています）</p>`
- [L162](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TranscriptCorrection.tsx#L162) `閉じる`
- [L169](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TranscriptCorrection.tsx#L169) `このセッションの {n} 箇所を『{value}』に置き換えます`
- [L173](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TranscriptCorrection.tsx#L173) `全部`
- [L176](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TranscriptCorrection.tsx#L176) `この行だけ`
- [L179](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TranscriptCorrection.tsx#L179) `やめる`
- [L186](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/TranscriptCorrection.tsx#L186) `「{picked.wrong}」を正しい語に直して Enter`

## web/src/components/UnsentAlert.tsx

- [L27](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/UnsentAlert.tsx#L27) `前にページを開いていたとき、ホストに届かなかった録音が`
- [L28](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/UnsentAlert.tsx#L28) {unsent.seconds < 60 ? ` ${unsent.seconds} 秒` : ` 約 ${Math.round(unsent.seconds / 60)} 分`}あります
- [L29](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/UnsentAlert.tsx#L29) {title ? `（${title}）` : ''}。送って、同じセッションの続きを録音できます
- [L33](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/UnsentAlert.tsx#L33) `送って続きを録音`
- [L36](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/UnsentAlert.tsx#L36) `捨てる`

## web/src/components/VersionInfo.tsx

- [L15](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/VersionInfo.tsx#L15) `ホスト {serverVersion ?? '—'} ・ クライアント {webVersion}`
- [L21](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/VersionInfo.tsx#L21) `クライアントがホストと違うバージョンです`
- [L23](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/components/VersionInfo.tsx#L23) `読み込み直す`

## web/src/connection.ts

- [L72](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/connection.ts#L72) `reject(new Error('ホストにつながりません'));`
- [L83](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/connection.ts#L83) `reject(new Error('ホストにつながりません'));`
- [L135](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/connection.ts#L135) `reject(new Error('ホストから応答がありません'));`

## web/src/continueWindow.ts

- [L26](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/continueWindow.ts#L26) return leftSec < 60 ? 'あと 1 分未満' : `あと ${Math.floor(leftSec / 60)} 分`;

## web/src/copyMarkdown.ts

- [L99](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/copyMarkdown.ts#L99) `if (!document.execCommand('copy')) throw new Error('コピーできませんでした');`

## web/src/corrections.ts

- [L49](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/corrections.ts#L49) `const SPEAKER_RE = /^話者 \d+: /;`
- [L70](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/corrections.ts#L70) `return '文字を選んでください';`
- [L73](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/corrections.ts#L73) `return '1 行の中で選んでください';`
- [L76](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/corrections.ts#L76) return `${CORRECTION_MAX_CHARS} 文字までにしてください`;
- [L84](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/corrections.ts#L84) `return '正しい語を入れてください';`
- [L87](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/corrections.ts#L87) `return '選んだ文字列と同じです';`
- [L132](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/corrections.ts#L132) ? `（${c.line.transcript === 'final' ? '浄書' : 'リアルタイム'}の ${c.line.index + 1} 行目だけ）`

## web/src/data.ts

- [L34](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/data.ts#L34) `title: json.title ?? '新しいセッション',`

## web/src/endpoint.ts

- [L41](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/endpoint.ts#L41) `throw new Error('ホストが選ばれていません');`

## web/src/materialRange.ts

- [L11](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/materialRange.ts#L11) `const unit = (file: string) => (file.toLowerCase().endsWith('.pdf') ? 'ページ' : '番目の区切り');`
- [L12](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/materialRange.ts#L12) const parts = [...byFile].map(([file, spans]) => `${file} の ${spans.join('・')} ${unit(file)}`);
- [L13](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/materialRange.ts#L13) return `参考資料は、今回扱った範囲（${parts.join('、')}）で作り直しました`;

## web/src/move.ts

- [L18](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/move.ts#L18) `return '録音中のセッションは移せません';`
- [L21](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/move.ts#L21) `return '浄書済み文字起こしを作っている途中のセッションは移せません';`
- [L24](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/move.ts#L24) `return '要約を作っている途中のセッションは移せません';`
- [L28](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/move.ts#L28) `return 'GPU の処理を待っている・実行しているセッションは移せません';`

## web/src/options.ts

- [L34](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/options.ts#L34) `return 'このモデルは思考モードに対応していないため、オフで実行します';`
- [L37](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/options.ts#L37) `return '思考モードはオン（対応していないモデルではオフで実行します）';`
- [L39](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/options.ts#L39) `return '思考モードはオン';`

## web/src/push.ts

- [L48](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/push.ts#L48) `return 'HTTPS で開いているときだけ使えます（http では使えません）';`
- [L50](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/push.ts#L50) `return 'このブラウザでは使えません。iPhone はホーム画面に追加したアプリ（iOS 16.4 以降）でだけ使えます';`
- [L52](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/push.ts#L52) `return '通知が許可されていません。ブラウザの設定で、このサイトの通知を許可してください';`

## web/src/recording.ts

- [L7](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/recording.ts#L7) `whisperModel: '録音中は変えられません',`
- [L9](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/recording.ts#L9) `segmentation: '録音中は変えられません',`
- [L11](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/recording.ts#L11) `microphone: '録音中は変えられません',`
- [L13](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/recording.ts#L13) `contextSet: '録音中は参考資料を変えられません',`
- [L15](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/recording.ts#L15) `regenerate: '録音中は再生成できません',`
- [L17](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/recording.ts#L17) `continueRecording: '録音中は、ほかのセッションの続きを録音できません',`

## web/src/status.ts

- [L35](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L35) `transcribe: '文字起こし',`
- [L36](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L36) `whisperLoad: '文字起こしのモデル読み込み',`
- [L37](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L37) `liveSummary: 'リアルタイム要約',`
- [L38](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L38) `finalSummary: '最終要約',`
- [L39](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L39) `contextSet: '参考資料の作成',`
- [L40](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L40) `terms: '文字起こしからの用語抽出',`
- [L41](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L41) `finalTranscript: '文字起こしの浄書',`
- [L42](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L42) `materialRange: '扱った範囲での参考資料の再生成',`
- [L43](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L43) `other: 'その他',`
- [L48](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L48) `liveSummary: 'リアルタイム要約の生成中',`
- [L49](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L49) `finalSummary: '最終要約の生成中',`
- [L50](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L50) `contextSet: '参考資料の作成中',`
- [L51](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L51) `terms: '用語抽出中',`
- [L52](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L52) `finalTranscript: '浄書中',`
- [L53](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L53) `materialRange: '参考資料の再生成中',`
- [L84](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L84) `? { tone: 'warning', text: 'ホストにつながっていません。つなぎ直しています…' }`
- [L85](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L85) `: { tone: 'idle', text: '待機中' };`
- [L91](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L91) `text: 'ホストに再接続しています…（録音は手元で続けています）',`
- [L95](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L95) `return { tone: 'paused', text: '一時停止中' };`
- [L98](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L98) `return { tone: 'error', text: '文字起こしが止まっています。音声は保存しているので、後から再生成できます' };`
- [L106](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L106) text: `${blockingReason[blocking] ?? 'ほかの処理'}のため、文字起こしを待っています…（音声は保存しています）`,
- [L110](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L110) `return { tone: 'warning', text: '文字起こしのモデルを読み込んでいます…（音声は保存しています）' };`
- [L112](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L112) `return { tone: 'active', text: '文字起こし中…' };`
- [L121](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L121) `return { tone: 'warning', text: 'ホストに再接続しています…（録音は続けています）' };`
- [L124](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L124) `return { tone: 'error', text: 'Ollama に接続できず、要約を作れません。録音を終えてから再生成できます' };`
- [L127](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L127) `return { tone: 'paused', text: '一時停止中。再開すると要約の更新も再開します' };`
- [L129](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/status.ts#L129) return { tone: 'active', text: `録音中。${intervalMin} 分おきにリアルタイム要約を更新します…` };

## web/src/store.ts

- [L520](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L520) `'届いていない音声が多いため、ここから先はページを読み込み直すと消えます。閉じずに、つながるのを待ってください',`
- [L592](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L592) `title: '新しいセッション',`
- [L630](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L630) `toast.error('マイクが使えません。ブラウザの設定でマイクを許可してください');`
- [L719](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L719) `'録音は途中で終わりました（接続が長く切れた・ホストが再起動したなど）。そこまでの録音は残っています',`
- [L722](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L722) `action: { label: '続きから録音', onClick: () => void get().continueRecording(sessionId) },`
- [L843](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L843) `toast.success('浄書済み文字起こしを再生成しました', {`
- [L845](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L845) `action: { label: '要約も再生成する', onClick: () => void get().regenerateSummary(sessionId) },`
- [L917](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L917) toast.error(`セッションを読み込めません: ${(e as Error).message}`);
- [L965](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L965) `toast.info('デモでは音声ファイルを使えません');`
- [L969](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L969) `toast.info('ほかのファイルをアップロード中です。終わってから選び直してください');`
- [L999](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L999) toast.success(`${file.name} から作ります。要約まで少しかかります`);
- [L1001](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1001) toast.error(`${file.name} をアップロードできません: ${(e as Error).message}`);
- [L1028](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1028) toast.error(`設定を読み込めません: ${(e as Error).message}`);
- [L1054](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1054) toast.error(`プロジェクトを読み込めません: ${(e as Error).message}`);
- [L1071](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1071) toast.success(`${project.path} をプロジェクトにしました`);
- [L1073](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1073) toast.error(`プロジェクトにできません: ${(e as Error).message}`);
- [L1099](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1099) `toast.info('録音するプロジェクトをメニューから選んでください');`
- [L1113](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1113) `toast.warning('前の録音の残りを送るのを待っています。つながってから、もう一度押してください');`
- [L1174](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1174) toast.error(`届いていない音声を送れません: ${(e as Error).message}`);
- [L1225](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1225) toast.error(`用語を消せません: ${(e as Error).message}`);
- [L1257](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1257) toast.error(`用語を足せません: ${(e as Error).message}`);
- [L1283](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1283) toast.success(`「${session.title}」を${to.name}へ移しました`);
- [L1289](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1289) toast.error(`「${session.title}」を移せません: ${(e as Error).message}`);
- [L1293](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1293) toast.success(`「${session.title}」を${to.name}へ移しました`);
- [L1305](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1305) toast.error(`プロジェクトの並びを保存できません: ${(e as Error).message}`);
- [L1331](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1331) toast.error(`置き換えられません: ${(e as Error).message}`);
- [L1360](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1360) toast.error(`置き換えを外せません: ${(e as Error).message}`);
- [L1378](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1378) `toast.success('マイクを開き直しました。録音を続けています');`
- [L1380](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1380) toast.error(`マイクを開き直せません: ${(e as Error).message}`);
- [L1391](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1391) `toast.warning('前の録音の残りを送るのを待っています。つながってから、もう一度押してください');`
- [L1708](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1708) `toast.success('参考資料ができました');`
- [L1710](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1710) `toast.error('参考資料を作れませんでした（資料を読めないか、Ollama に接続できません）');`
- [L1748](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1748) `toast.error('録音中は、文字起こしのモデル・区切り・マイクの処理は変えられません');`
- [L1750](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1750) toast.error(`設定を保存できません: ${(e as Error).message}`);
- [L1758](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1758) `toast.info('デモでは文字起こしを再生成できません');`
- [L1777](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1777) `toast.error('録音中または録音を終えた直後です。少し待ってから再生成してください');`
- [L1779](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1779) `toast.error('録音ファイルが期限切れのため、再生成できません');`
- [L1781](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1781) toast.error(`文字起こしを再生成できません: ${(e as Error).message}`);
- [L1797](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1797) toast.error(`文字起こしを読み込めません: ${(e as Error).message}`);
- [L1803](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1803) `toast.info('デモでは要約を再生成できません');`
- [L1841](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1841) `toast.error('録音中または録音を終えた直後です。少し待ってから再生成してください');`
- [L1843](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1843) `toast.error('文字起こしが期限切れのため、再生成できません');`
- [L1845](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1845) toast.error(`要約を再生成できません: ${(e as Error).message}`);
- [L1884](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1884) `toast.error('録音中は参考資料を変えられません');`
- [L1886](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1886) toast.error(`参考資料の選択を保存できません: ${(e as Error).message}`);
- [L1915](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1915) `toast.info('同じ資料の参考資料があるので、それを使います');`
- [L1919](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1919) toast.error(`参考資料を作れません: ${(e as Error).message}`);
- [L1926](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1926) `toast.info('同じ資料の参考資料があるので、それを使います');`
- [L1941](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1941) `toast.success('参考資料ができました');`
- [L1956](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1956) `'音は届いていますが、文字起こしが出ていません（録音は続いています）。設定の「ブラウザのエコー除去」「ブラウザの雑音抑制」を切ると直ることがあります';`
- [L1961](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1961) `return 'マイクが止まりました。録音されていません。「マイクを開き直す」を押してください';`
- [L1963](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1963) `return 'マイクの音が届いていません（ほかのアプリや OS がマイクを止めています）。録音されていません';`
- [L1965](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/store.ts#L1965) `return '音声の処理が止まりました（電話や通知などのため）。「マイクを開き直す」を押してください';`

## web/src/terms.ts

- [L19](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/terms.ts#L19) return `${MANUAL_MAX_CHARS} 文字を超えています`;
- [L22](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/terms.ts#L22) `return '「/」は使えません';`

## web/src/upload.ts

- [L24](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/upload.ts#L24) return status === 0 ? 'アップロードが途中で切れました' : `ホストが受け付けませんでした（${status}）`;

## web/src/watch.ts

- [L31](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/watch.ts#L31) `return 'ほかの端末で一時停止中';`
- [L33](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/watch.ts#L33) `return 'ほかの端末で録音中（その端末とのつながりが切れています）';`
- [L35](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/watch.ts#L35) `return 'ほかの端末で録音を終えました';`
- [L37](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/src/watch.ts#L37) `return 'ほかの端末で録音中';`

## web/public/push-sw.js

- [L50](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/public/push-sw.js#L50) `await self.registration.showNotification(data.title \|\| '最終要約ができました', {`

## web/vite.config.ts

- [L37](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/web/vite.config.ts#L37) `description: '別のマシンの GPU で、疑似リアルタイムに文字起こしと要約をする',`

## server/src/remote_whisper/__main__.py

- [L28](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/__main__.py#L28) `parser.add_argument("--host", default="127.0.0.1", help="待ち受けるアドレス（既定: 127.0.0.1）")`
- [L29](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/__main__.py#L29) `parser.add_argument("--port", type=int, default=8000, help="待ち受けるポート（既定: 8000）")`
- [L33](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/__main__.py#L33) `help="Whisper と Ollama の代わりにダミーを流す（GPU なしでフロントを開発する用）",`
- [L39](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/__main__.py#L39) `help="モックでリアルタイム要約を送る間隔（秒）",`
- [L44](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/__main__.py#L44) `help="タスクトレイ（Windows）・メニューバー（Mac）にアイコンを出さない",`

## server/src/remote_whisper/announcements.py

- [L33](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/announcements.py#L33) `NEW_VERSION_MESSAGE = "新しい版があります（{version}）"`

## server/src/remote_whisper/audio_convert.py

- [L38](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/audio_convert.py#L38) `raise RuntimeError("mp3 と AAC のどちらのエンコーダーもありません")`
- [L73](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/audio_convert.py#L73) `raise ValueError("音声が入っていません")`
- [L89](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/audio_convert.py#L89) `raise ValueError(f"音声ファイルとして読めません: {e}") from e`

## server/src/remote_whisper/cloud.py

- [L59](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L59) `"登録コードの期限が切れました。もう一度「クラウド版にログイン」からやり直してください"`
- [L305](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L305) `"このホストはすでに登録されています。画面のホストの管理から外してください"`
- [L308](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L308) `raise CloudError("登録の申請が多すぎます。少し待ってからやり直してください")`
- [L309](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L309) `data = _json_or_error(res, "登録を始められませんでした")`
- [L312](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L312) `raise CloudError("中間サーバーの返事が読めませんでした（登録コードがありません）")`
- [L328](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L328) `"署名を確かめてもらえませんでした。PC の時計が合っているか確かめてください"`
- [L331](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L331) `raise CloudRefused(f"登録の状態を確かめられませんでした（HTTP {res.status_code}）")`
- [L332](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L332) `return _json_or_error(res, "登録の状態を確かめられませんでした")`
- [L348](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L348) `raise RegistrationGone(f"クラウド版の登録が見つかりません（HTTP {res.status_code}）")`
- [L349](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L349) `data = _json_or_error(res, "トンネルのトークンをもらえませんでした")`
- [L352](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L352) `raise CloudError("中間サーバーの返事が読めませんでした（トークンがありません）")`
- [L360](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L360) `f"中間サーバー（{self.credentials.relay_url}）につながりません: {type(e).__name__}"`
- [L381](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L381) `raise CloudError(f"{message}（返事が JSON ではありません）") from e`
- [L383](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L383) `raise CloudError(f"{message}（返事の形が違います）")`
- [L511](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L511) `message = f"クラウド版に登録できませんでした: {e}"`
- [L514](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L514) `message = f"クラウド版に登録できませんでした: {type(e).__name__}"`
- [L534](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L534) `f"登録コード: {ticket.code}\n"`
- [L535](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L535) `"ブラウザの画面に同じコードが出ているか確かめて、承認してください"`
- [L570](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L570) `raise CloudError("承認されましたが、中継の鍵を受け取れませんでした")`
- [L578](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L578) `return "クラウド版に登録しました"`
- [L580](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L580) `return "登録が拒否されました"`
- [L584](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L584) `return "クラウド版への登録をやめました"`
- [L609](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L609) `self._notice("クラウド版から外せませんでした。ログを確かめてください")`
- [L615](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L615) `self._notice("クラウド版から外しました")`
- [L618](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L618) `"この端末の登録を消しました。中間サーバーには伝えられなかったので、"`
- [L619](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloud.py#L619) `"画面のホストの管理からも外してください"`

## server/src/remote_whisper/cloudflared.py

- [L49](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloudflared.py#L49) `"cloudflared が見つかりません。インストールして PATH に通すか、"`
- [L50](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloudflared.py#L50) `"設定の cloud.cloudflaredPath に場所を書いてください"`
- [L54](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloudflared.py#L54) `"cloud.cloudflaredPath は、cloudflared への絶対パス（ネットワークのパスは不可）にしてください"`
- [L182](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloudflared.py#L182) `raise RegistrationGone("登録されていません")`
- [L251](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/cloudflared.py#L251) `self._notice(f"cloudflared を起動できませんでした: {type(e).__name__}")`

## server/src/remote_whisper/context.py

- [L62](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context.py#L62) `raise HTTPException(status_code=409, detail="録音中は変更できません")`

## server/src/remote_whisper/context_sets.py

- [L76](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L76) `word = re.sub(r"^\s*(?:[-*・•]\|\d+[.)．、]\|[（(]?\d+[）)])\s*", "", line).strip()`
- [L148](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L148) `body = text[:share] + ("\n（以下省略）" if len(text) > share else "")`
- [L209](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L209) `raise ContextSetError(400, "参考資料を選んでください")`
- [L216](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L216) `raise ContextSetError(403, f"選べる場所の外にある資料です: {m}")`
- [L218](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L218) `raise ContextSetError(404, f"資料がありません: {m}")`
- [L220](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L220) `raise ContextSetError(400, f"この形式の資料は選べません: {m}")`
- [L232](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L232) `raise ContextSetError(404, f"資料を読み込めません: {e}") from e`
- [L326](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L326) `raise ExtractError("資料から文字を取り出せませんでした")`
- [L330](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L330) `raise OllamaUnavailable("用語リストもコンテキストも空でした")`
- [L362](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/context_sets.py#L362) `raise ContextSetError(404, f"コンテキストがありません: {set_id}") from e`

## server/src/remote_whisper/corrections.py

- [L74](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/corrections.py#L74) `SPEAKER_RE = re.compile(r"話者 \d+: ")`

## server/src/remote_whisper/documents.py

- [L76](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/documents.py#L76) `raise FrontmatterError("フロントマターがありません")`
- [L83](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/documents.py#L83) `raise FrontmatterError(f"フロントマターの YAML を読めません: {e}") from e`
- [L85](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/documents.py#L85) `raise FrontmatterError("フロントマターが辞書ではありません")`
- [L87](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/documents.py#L87) `raise FrontmatterError("フロントマターが閉じていません")`

## server/src/remote_whisper/final_summary.py

- [L53](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_summary.py#L53) `OVERVIEW_HEADING = "全体概要"`
- [L67](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_summary.py#L67) `EMPTY_PART = "（この部分は要約できませんでした）"`
- [L138](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_summary.py#L138) `"message": "最終要約を作る途中でエラーになりました",`
- [L167](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_summary.py#L167) `"message": "文字起こしを読み込めないので、最終要約は作りませんでした",`
- [L177](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_summary.py#L177) `"message": "文字起こしが空なので、最終要約は作りませんでした",`
- [L214](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_summary.py#L214) `raise OllamaUnavailable("要約が空でした")`
- [L219](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_summary.py#L219) `await send(ollama_error("最終要約"))`
- [L265](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_summary.py#L265) `"message": "最終要約を保存できませんでした",`

## server/src/remote_whisper/final_transcriber.py

- [L49](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_transcriber.py#L49) `"こんにちは。今日は、言葉の話をしましょう。えっと、そうですね。はい、よろしくお願いします。"`
- [L140](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_transcriber.py#L140) `"message": "浄書できませんでした（ホストのログを見てください）",`

## server/src/remote_whisper/final_transcript.py

- [L53](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_transcript.py#L53) `SPEAKER_LABEL = "話者"`
- [L122](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_transcript.py#L122) `if k + 1 < len(tokens) and tokens[k + 1].feature.pos1 in ("助詞", "助動詞"):`
- [L126](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_transcript.py#L126) `if f.pos2 == "終助詞" or (`
- [L127](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/final_transcript.py#L127) `f.pos1 in ("助動詞", "動詞", "形容詞") and form.startswith("終止形")`

## server/src/remote_whisper/live_summary.py

- [L46](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/live_summary.py#L46) `LIVE_OVERVIEW_HEADING = "ここまでの概要"`
- [L47](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/live_summary.py#L47) `EMPTY_OVERVIEW = "（概要は次の更新で作ります）"`
- [L184](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/live_summary.py#L184) `raise OllamaUnavailable("区間の要約が空でした")`
- [L198](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/live_summary.py#L198) `raise OllamaUnavailable("要約が空でした")`
- [L210](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/live_summary.py#L210) `await self.send(ollama_error("リアルタイム要約"))`
- [L287](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/live_summary.py#L287) `heading = f"{s.start}〜{s.end}" if s.start and s.end else f"区間 {i + 1}"`
- [L289](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/live_summary.py#L289) `heading = f"{current_start}〜" if current_start else f"区間 {len(self.sections) + 1}"`

## server/src/remote_whisper/live_transcriber.py

- [L176](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/live_transcriber.py#L176) `"message": f"文字起こしを保存できません: {e}",`

## server/src/remote_whisper/material_pages.py

- [L149](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_pages.py#L149) `"## 参考資料（[ファイル名 p.ページ] の下がそのページの本文）\n"`
- [L151](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_pages.py#L151) `+ "\n\n## 要約の項目\n"`
- [L153](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_pages.py#L153) `+ "\n\n要約の項目ごとに、その内容が書いてある参考資料のファイル名とページを答えてください"`
- [L154](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_pages.py#L154) `+ "（item は項目の番号、file は [ ] の中のファイル名、pages はページ番号）。"`
- [L155](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_pages.py#L155) `+ "ファイル名とページは、上の参考資料にあるものだけを使ってください。"`
- [L156](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_pages.py#L156) `+ "参考資料に書いていない項目は含めないでください。"`
- [L161](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_pages.py#L161) `"content": "あなたは、要約の各項目が参考資料のどのページの内容かを見分ける係です。",`
- [L238](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_pages.py#L238) `return "、".join(f"{name} {page_label(pages)}" for name, pages in sources) + " の内容"`

## server/src/remote_whisper/material_range.py

- [L91](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_range.py#L91) `return "\n".join([*head, "（中略）", *middle, "（中略）", *tail_lines])`
- [L220](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/material_range.py#L220) `raise OllamaUnavailable("範囲の答えの形が合いませんでした")`

## server/src/remote_whisper/materials.py

- [L30](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/materials.py#L30) `raise ExtractError(f"この形式の資料は読めません: {path.name}")`
- [L38](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/materials.py#L38) `raise ExtractError(f"資料を読み込めません: {path.name}（{e.strerror or e}）") from e`
- [L45](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/materials.py#L45) `f"資料の文字コードが分かりません（UTF-8 か Shift_JIS にしてください）: {path.name}"`
- [L125](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/materials.py#L125) `raise ExtractError(f"この PDF の暗号は読めません: {path.name}") from e`
- [L127](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/materials.py#L127) `raise ExtractError(f"パスワード付きの PDF は読めません: {path.name}")`
- [L140](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/materials.py#L140) `raise ExtractError(f"資料を読み込めません: {path.name}（{e.strerror or e}）") from e`
- [L143](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/materials.py#L143) `raise ExtractError(f"PDF を読めません: {path.name}") from e`

## server/src/remote_whisper/ollama.py

- [L36](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/ollama.py#L36) `"message": f"Ollama に接続できないため、{what}を作れませんでした",`

## server/src/remote_whisper/projects.py

- [L255](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L255) `raise ProjectError(404, f"プロジェクト {pid} はありません")`
- [L277](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L277) `raise _Unreadable(404, f"プロジェクト {pid} はありません")`
- [L282](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L282) `raise _Unreadable(500, f"{path} を読み込めません: {e}") from e`
- [L287](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L287) `500, f"{path} の version {version} はこのホストより新しいため読み込めません"`
- [L292](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L292) `raise _Unreadable(500, f"{path} を読み込めません: {e}") from e`
- [L368](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L368) `raise ProjectError(404, f"プロジェクト {key} はありません")`
- [L379](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L379) `raise ProjectError(404, f"セッション {session_uuid} はありません")`
- [L384](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L384) `raise ProjectError(400, "絶対パスを指定してください")`
- [L387](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L387) `raise ProjectError(403, "許可されたルートの外のディレクトリは登録できません")`
- [L389](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L389) `raise ProjectError(404, "ディレクトリがありません")`
- [L391](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/projects.py#L391) `raise ProjectError(400, "ディレクトリではありません")`

## server/src/remote_whisper/push.py

- [L55](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/push.py#L55) `NOTIFICATION_TITLE = "最終要約ができました"`
- [L98](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/push.py#L98) `raise ValueError("購読の形が違います") from e`
- [L100](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/push.py#L100) `raise ValueError("ブラウザの push サービスの URL ではありません")`
- [L106](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/push.py#L106) `raise ValueError("購読の鍵が読めません") from e`
- [L108](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/push.py#L108) `raise ValueError("購読の鍵が読めません")`
- [L309](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/push.py#L309) `title = writer.meta.title or "新しいセッション"`

## server/src/remote_whisper/recorder.py

- [L312](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L312) `"message": f"音声を保存できません: {e}",`
- [L614](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L614) `raise RecordingError("too_many_recordings", "同時に録音できる数を超えています")`
- [L625](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L625) `raise RecordingError("project_not_found", "プロジェクトがありません") from e`
- [L645](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L645) `raise RecordingError("too_many_recordings", "同時に録音できる数を超えています")`
- [L648](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L648) `raise RecordingError("already_recording", "このセッションは録音中です")`
- [L664](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L664) `"session_not_found", "続きを録音できるセッションがありません"`
- [L705](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L705) `"session_not_found", "続きを録音できるセッションがありません"`
- [L712](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L712) `"cannot_continue", "録音ファイルが残っていないので、続きを録音できません"`
- [L719](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L719) `raise RecordingError("cannot_continue", f"前の録音を読み込めません: {e}") from e`
- [L743](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recorder.py#L743) `raise RecordingError("session_not_found", "再開できるセッションがありません")`

## server/src/remote_whisper/recording.py

- [L32](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recording.py#L32) `"cannot_continue", "続きを録音できるのは、録音を終えたセッションだけです"`
- [L38](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/recording.py#L38) `f"録音を終えてから {minutes} 分を過ぎたので、続きを録音できません",`

## server/src/remote_whisper/routes/fs.py

- [L46](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/fs.py#L46) `raise HTTPException(status_code=400, detail="絶対パスを指定してください")`
- [L49](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/fs.py#L49) `raise HTTPException(status_code=403, detail="許可されたルートの外は見られません")`
- [L51](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/fs.py#L51) `raise HTTPException(status_code=404, detail="ディレクトリがありません")`
- [L60](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/fs.py#L60) `raise HTTPException(status_code=403, detail=f"読み込めません: {e.strerror}") from e`

## server/src/remote_whisper/routes/projects.py

- [L54](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/projects.py#L54) `raise HTTPException(status_code=503, detail="このホストでは参考資料を作れません")`
- [L95](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/projects.py#L95) `raise HTTPException(status_code=400, detail=f"使えない参考資料です: {set_id}")`

## server/src/remote_whisper/routes/push.py

- [L17](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/push.py#L17) `raise HTTPException(status_code=404, detail="このホストでは通知を使えません")`

## server/src/remote_whisper/routes/sessions.py

- [L57](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L57) `raise HTTPException(status_code=404, detail=f"セッション {sid} はありません")`
- [L62](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L62) `return HTTPException(status_code=410, detail=f"{what}は保存期間を過ぎたため消えています")`
- [L96](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L96) `raise HTTPException(status_code=503, detail="このホストではアップロードできません")`
- [L104](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L104) `raise HTTPException(status_code=400, detail="アップロードが途中で切れました") from e`
- [L143](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L143) `return "録音中のセッションは移せません"`
- [L146](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L146) `return "続きの録音を始めている途中のセッションは移せません"`
- [L148](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L148) `return "録音を終えたあとの処理中のセッションは移せません"`
- [L150](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L150) `return "浄書済み文字起こしを作っている途中のセッションは移せません"`
- [L152](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L152) `return "要約を作っている途中のセッションは移せません"`
- [L155](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L155) `return "GPU の処理を待っている・実行しているセッションは移せません"`
- [L222](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L222) `raise _gone("文字起こし")`
- [L226](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L226) `raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e`
- [L244](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L244) `raise _gone("浄書済み文字起こし")`
- [L247](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L247) `raise HTTPException(status_code=404, detail="浄書済み文字起こしがありません")`
- [L250](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L250) `raise _gone("浄書済み文字起こし")`
- [L254](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L254) `raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e`
- [L275](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L275) `detail="このホストには浄書済み文字起こしの機能（WhisperX）がありません",`
- [L279](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L279) `status_code=409, detail="録音中のセッションの文字起こしは再生成できません"`
- [L284](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L284) `status_code=409, detail="このセッションの文字起こしは作っている途中です"`
- [L288](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L288) `raise _gone("録音ファイル")`
- [L293](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L293) `raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e`
- [L322](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L322) `raise _gone("文字起こし") from e`
- [L340](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L340) `detail=f"用語は 1〜{MANUAL_MAX_CHARS} 文字で、「、」「/」と改行は使えません",`
- [L355](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L355) `detail="手で足した語が多すぎて、Whisper に渡せる長さの上限を超えます。"`
- [L356](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L356) `"いらない語を外してから足してください",`
- [L452](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L452) `detail=f"直す文字列は 1〜{CORRECTION_MAX_CHARS} 文字で、改行は使えません",`
- [L456](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L456) `raise HTTPException(status_code=400, detail="直す文字列と正しい語が同じです")`
- [L458](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L458) `raise HTTPException(status_code=400, detail="浄書済み文字起こしの版を指定してください")`
- [L506](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L506) `raise HTTPException(status_code=404, detail="録音ファイルはありません")`
- [L528](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L528) `raise HTTPException(status_code=503, detail="このホストでは要約を作れません")`
- [L531](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L531) `raise HTTPException(status_code=409, detail="録音中のセッションの要約は再生成できません")`
- [L533](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L533) `raise _gone("文字起こし")`
- [L537](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L537) `raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e`
- [L590](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L590) `raise HTTPException(status_code=404, detail=f"要約 {gid} はありません")`
- [L593](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L593) `raise HTTPException(status_code=404, detail=f"要約 {gid} はありません")`
- [L597](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L597) `raise HTTPException(status_code=500, detail=f"要約を読み込めません: {e}") from e`
- [L605](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L605) `raise HTTPException(status_code=404, detail="要約はまだありません")`
- [L609](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/sessions.py#L609) `raise HTTPException(status_code=500, detail=f"リアルタイム要約を読み込めません: {e}") from e`

## server/src/remote_whisper/routes/settings.py

- [L43](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/settings.py#L43) `detail="クラウド版からは、Whisper のモデルにファイルのパスを指定できません",`
- [L57](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/settings.py#L57) `detail="クラウド版からは変えられない項目です（この端末の画面から変えてください）: "`
- [L61](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/settings.py#L61) `status_code=409, detail=f"録音中は変えられない項目です: {', '.join(e.fields)}"`

## server/src/remote_whisper/routes/ws.py

- [L73](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L73) `raise RecordingError("project_not_found", "プロジェクトがありません") from e`
- [L83](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L83) `raise RecordingError("session_not_found", "セッションがありません") from e`
- [L94](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L94) `raise RecordingError("not_recording", "録音していません")`
- [L96](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L96) `raise RecordingError("bad_message", "音声のチャンクが短すぎます")`
- [L169](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L169) `raise RecordingError("bad_message", "session を指定してください")`
- [L190](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L190) `raise RecordingError("bad_message", "メッセージを読めません") from e`
- [L199](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L199) `raise RecordingError("not_available", "このホストではまだ録音できません")`
- [L204](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L204) `raise RecordingError("already_recording", "すでに録音しています")`
- [L207](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L207) `raise RecordingError("bad_message", "project を指定してください")`
- [L213](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L213) `raise RecordingError("already_recording", "すでに録音しています")`
- [L216](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L216) `raise RecordingError("bad_message", "project と session を指定してください")`
- [L218](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L218) `raise RecordingError("not_available", "このホストでは続きを録音できません")`
- [L226](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L226) `raise RecordingError("bad_message", "session と nextSeq を指定してください")`
- [L228](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L228) `raise RecordingError("already_recording", "すでに録音しています")`
- [L232](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L232) `raise RecordingError("not_recording", "録音していません")`
- [L241](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/routes/ws.py#L241) `raise RecordingError("bad_message", f"知らない種類のメッセージです: {kind}")`

## server/src/remote_whisper/session_move.py

- [L114](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_move.py#L114) `raise ProjectError(400, "移動先が同じプロジェクトです")`
- [L121](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_move.py#L121) `raise ProjectError(404, f"セッション {sid} はありません")`
- [L123](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_move.py#L123) `raise ProjectError(409, "移動先に同じ ID のセッションがあります")`
- [L128](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_move.py#L128) `raise ProjectError(409, f"移動先に同じ名前のファイルがあります: {path.name}")`
- [L195](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_move.py#L195) `"使われているファイルがあるため移せませんでした（元のままです）。"`
- [L196](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_move.py#L196) `"ほかの端末で録音を再生していないか確かめてください",`
- [L198](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_move.py#L198) `raise ProjectError(500, f"セッションを移せませんでした（元のままです）: {e}") from e`

## server/src/remote_whisper/session_writer.py

- [L343](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_writer.py#L343) `stem = f"summary-{self.id[:8]}-{safe_filename(self.meta.title or 'タイトルなし')}"`
- [L347](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_writer.py#L347) `raise FileNotFoundError(f"選んだディレクトリがありません: {target_dir}")`
- [L364](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/session_writer.py#L364) `return name or "タイトルなし"`

## server/src/remote_whisper/settings.py

- [L291](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L291) `"Ctrl・Alt・Shift・Meta のどれかを含むキーの組み合わせ（例: Alt+Shift+KeyM）か、"`
- [L292](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L292) `"空にしてください"`
- [L333](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L333) `"空か、cloudflared（cloudflared.exe）への絶対パスにしてください"`
- [L334](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L334) `"（ネットワークのパス \\\\ や // は使えません）"`
- [L344](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L344) `raise ValueError(f"URL として読めません: {e}") from e`
- [L347](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L347) `raise ValueError("https:// の URL（ローカルの開発なら http://localhost）にしてください")`
- [L351](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L351) `raise ValueError("ユーザー名やパスワードを含まない URL にしてください")`
- [L353](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L353) `raise ValueError("パスのない URL（https://example.com）にしてください")`
- [L428](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L428) `raise SettingsError(f"{self.path} を読み込めません: {e}") from e`
- [L432](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L432) `f"{self.path} の version {settings.version} はこのホストより新しいため"`
- [L433](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/settings.py#L433) `f"読み込めません（対応しているのは {SETTINGS_VERSION} まで）"`

## server/src/remote_whisper/term_picker.py

- [L41](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L41) `_DISTINCT_RUN = re.compile(r"[ァ-ヺー・]{3,}\|[A-Za-z][A-Za-z0-9.+\-]+")`
- [L45](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L45) `"チーム",`
- [L46](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L46) `"データ",`
- [L47](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L47) `"スケジュール",`
- [L48](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L48) `"リスク",`
- [L49](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L49) `"システム",`
- [L50](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L50) `"サーバー",`
- [L51](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L51) `"ツール",`
- [L52](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L52) `"プロジェクト",`
- [L53](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L53) `"ミーティング",`
- [L54](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L54) `"メンバー",`
- [L55](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L55) `"テスト",`
- [L56](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L56) `"ユーザー",`
- [L57](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L57) `"サービス",`
- [L58](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L58) `"アプリ",`
- [L59](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L59) `"メール",`
- [L60](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L60) `"ファイル",`
- [L61](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L61) `"タスク",`
- [L62](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L62) `"レビュー",`
- [L63](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L63) `"コスト",`
- [L64](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/term_picker.py#L64) `"ポイント",`

## server/src/remote_whisper/tray.py

- [L265](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray.py#L265) `def confirm(message: str, ok_label: str = "終了") -> bool:`
- [L277](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray.py#L277) `f'buttons {{"キャンセル", "{ok_label}"}} default button "キャンセル" '`
- [L278](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray.py#L278) `'cancel button "キャンセル"'`
- [L505](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray.py#L505) `if self.cloud is None or not confirm(CLOUD_UNPAIR_CONFIRM, "外す"):`

## server/src/remote_whisper/tray_state.py

- [L26](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L26) `"transcribe": "文字起こし",`
- [L27](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L27) `"whisperLoad": "文字起こしのモデル読み込み",`
- [L28](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L28) `"liveSummary": "リアルタイム要約",`
- [L29](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L29) `"finalSummary": "最終要約",`
- [L30](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L30) `"contextSet": "参考資料の作成",`
- [L31](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L31) `"terms": "文字起こしからの用語抽出",`
- [L32](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L32) `"finalTranscript": "文字起こしの浄書",`
- [L39](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L39) `MENU_OPEN = "画面を開く"`
- [L40](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L40) `MENU_LOGS = "ログのフォルダを開く"`
- [L41](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L41) `MENU_QUIT = "終了"`
- [L43](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L43) `MENU_CLOUD_LOGIN = "クラウド版にログイン"`
- [L44](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L44) `MENU_CLOUD_CANCEL = "登録をやめる"`
- [L45](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L45) `MENU_CLOUD_UNPAIR = "クラウド版から外す"`
- [L46](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L46) `CLOUD_UNPAIR_CONFIRM = "この端末をクラウド版から外しますか？ 録音やファイルは消えません"`
- [L78](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L78) `return f"クラウド版: 登録中（コード {view.code}）" if view.code else "クラウド版: 登録中…"`
- [L80](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L80) `return "クラウド版: 外しています…"`
- [L83](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L83) `label = {"connected": "つながっている", "connecting": "つないでいます"}.get(`
- [L84](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L84) `view.tunnel, "止まっている"`
- [L86](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L86) `return f"クラウド版: 登録済み / トンネル: {label}"`
- [L87](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L87) `return f"クラウド版: {'つながっていない' if view.connected is False else 'つながっている'}"`
- [L88](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L88) `return "クラウド版: 登録していない"`
- [L107](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L107) `problems.append("文字起こし（Whisper）が使えません")`
- [L109](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L109) `problems.append("Ollama に接続できません")`
- [L112](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L112) `parts.append(f"録音中 {status.recordings}件")`
- [L114](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L114) `parts.append(f"待ち {waiting}件")`
- [L116](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L116) `parts.append(f"実行中: {JOB_NAMES.get(running.get('kind'), 'その他')}")`
- [L118](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L118) `parts.append("待機中")`
- [L137](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L137) `f"録音中のセッションが {status.recordings} 件あります。"`
- [L138](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tray_state.py#L138) `"終了すると録音もそこで止まります（そこまでは残ります）。終了しますか？"`

## server/src/remote_whisper/tunnel.py

- [L330](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tunnel.py#L330) `f"トンネル専用のポート（{self.port} 番）を開けませんでした。"`
- [L331](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/tunnel.py#L331) `"ほかのプログラムが使っていないか確かめてください"`

## server/src/remote_whisper/uploads.py

- [L159](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/uploads.py#L159) `raise UploadError(415, f"音声ファイルとして読めません（{name}）") from e`
- [L161](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/uploads.py#L161) `raise UploadError(415, f"音声の長さが 0 です（{name}）")`
- [L177](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/uploads.py#L177) `raise UploadError(500, f"録音ファイルを置けませんでした（{name}）") from e`
- [L203](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/uploads.py#L203) `413, f"ファイルが大きすぎます（上限 {limit // MB}MB。設定で変えられます）"`
- [L207](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/uploads.py#L207) `raise UploadError(400, "ファイルが空です")`

## server/src/remote_whisper/whisper_worker.py

- [L66](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/whisper_worker.py#L66) `raise RuntimeError("読み込みに失敗（テスト用）")`
- [L137](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/whisper_worker.py#L137) `raise RuntimeError("モデルを読み込んでいません")`
- [L227](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/whisper_worker.py#L227) `raise WhisperUnavailable("Whisper の読み込みに失敗したばかりです")`
- [L304](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/whisper_worker.py#L304) `raise _ChildDied("Whisper の子プロセスがありません")`
- [L311](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/whisper_worker.py#L311) `raise _ChildDied("Whisper の子プロセスが落ちました")`
- [L314](https://github.com/Studio-Takumi/remote-whisper/blob/763d5ffcd88d6001ba06c45be48b4bbcf1222b50/server/src/remote_whisper/whisper_worker.py#L314) `raise _ChildDied("Whisper の子プロセスとやりとりできません") from e`

