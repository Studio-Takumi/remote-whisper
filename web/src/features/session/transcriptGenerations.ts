// 浄書済み文字起こし（#121）の世代の見出し（#124）
import type { FinalTranscriptInfo } from '@/api/types';
import { sessionMessages } from '@/features/session/i18n';

// モデル・話者の数（話者を分けたとき、表示する設定なら。#146）・作った日時を「・」でつなぐ
export function generationLabel(g: FinalTranscriptInfo, showSpeakers: boolean): string {
    return [
        g.model,
        showSpeakers && g.diarization === 'done'
            ? sessionMessages.t('transcriptGenerations.speakers', { n: g.speakers })
            : null,
        g.generatedAt,
    ]
        .filter(Boolean)
        .join(sessionMessages.t('transcriptGenerations.separator'));
}
