import { AudioLinesIcon, FolderPlusIcon } from 'lucide-react';

import { isDemoBuild } from '@/api/demoBuild';

// デモ版（#414）の注意書き。文面は匠と合意したもの（2026-11-11）なので、変えるときは Issue で相談する
const DEMO_NOTICE = [
    'これは Remote Whisper のデモ版です。録音やプロジェクトの作成、設定の変更はできません（表示の設定は変えられます）。',
    '表示している文字起こしと要約は、性能を測るために公開されている動画から生成したものです（著作権法第30条の4）。国会の審議は全文を（第40条）、ほかの動画は一部だけを（第47条の5）載せています。元の動画は各要約の冒頭にリンクしています。',
    '載せているのは生成した結果そのままで、Remote Whisper や開発者の政治的な立場を示すものではありません。',
];

// 何も選んでいないとき。デモ版は、見出しの下を注意書きにする
export function EmptyState({ hasProjects }: { hasProjects: boolean }) {
    return (
        <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground'>
            {hasProjects ? <AudioLinesIcon className='size-10' /> : <FolderPlusIcon className='size-10' />}
            <p className='text-lg font-semibold text-foreground'>
                {hasProjects ? 'セッションを開くか、新しく録音しましょう' : 'まずはプロジェクトを作りましょう'}
            </p>
            {isDemoBuild ? (
                <div className='flex max-w-xl flex-col gap-2 text-left text-sm'>
                    {DEMO_NOTICE.map((text) => (
                        <p key={text}>{text}</p>
                    ))}
                </div>
            ) : (
                <p className='max-w-md text-sm'>
                    {hasProjects
                        ? 'メニューからセッションを開くか、プロジェクトの ＋ で新しく作れます'
                        : 'メニューの「新規プロジェクト作成」から、録音をまとめるフォルダを選んでください'}
                </p>
            )}
        </div>
    );
}
