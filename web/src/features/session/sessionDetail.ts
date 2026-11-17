// セッションの中身（文字起こし・最終の文字起こし・要約）を、キャッシュにある API の返事から組み立てる（#361）
import type { SessionFiles, SummaryInfoJson, SummaryJson, TranscriptJson } from '@/api/api';
import { toSummary } from '@/api/data';
import type { FinalTranscript, FinalTranscriptInfo, Session } from '@/api/types';
import { withLineSources } from '@/features/session/sources';

// キャッシュにある、1 つのセッションの返事。summaryTexts は summaryInfos と同じ順
export type SessionParts = {
    transcript?: TranscriptJson;
    finalTranscripts?: FinalTranscriptInfo[];
    finalTranscript?: FinalTranscript;
    summaryInfos?: SummaryInfoJson[];
    summaryTexts: (SummaryJson | undefined)[];
    liveSummary?: SummaryJson;
};

// 中身を取ったセッション（ストアの loadedSessions）。finalTranscript は出している世代、failed は取れなかったとき
export type LoadedSession = { finalTranscript?: string; failed?: boolean };

// 中身がキャッシュにそろっているか（キャッシュの既定の時間で捨てられていたら、開いたときに取り直す）
function hasDetail(files: SessionFiles | undefined, parts: SessionParts) {
    if (files?.transcript && !parts.transcript) {
        return false;
    }
    return !files?.summaries || (!!parts.summaryInfos && parts.summaryTexts.every((x) => x !== undefined));
}

function detailFrom(parts: SessionParts) {
    const meta = parts.transcript?.meta;
    return {
        transcript: withLineSources(parts.transcript?.lines ?? [], meta?.lineSources),
        // 音源（#357）。音源が 1 つのセッションは持たない
        sources: (meta?.sources?.length ?? 0) >= 2 ? meta?.sources : undefined,
        pickedTerms: meta?.pickedTerms ?? [],
        manualTerms: meta?.manualTerms ?? [],
        materialRange: meta?.materialRange ?? undefined,
        corrections: meta?.corrections ?? [],
        finalTranscripts: parts.finalTranscripts,
        finalTranscript: parts.finalTranscript,
        summaries: (parts.summaryInfos ?? []).map((info, i) => toSummary(info, parts.summaryTexts[i]?.text)),
        liveSummary: parts.liveSummary?.kind === 'live' ? parts.liveSummary.text : undefined,
    };
}

// 一覧の行と、キャッシュにある中身から、画面に出すセッションを作る。中身を取っていなければ一覧の行のまま
export function sessionFrom(row: Session, parts: SessionParts, loaded: LoadedSession | undefined): Session {
    if (!loaded || (!loaded.failed && !hasDetail(row.files, parts))) {
        return row;
    }
    return { ...row, ...detailFrom(parts), loaded: true };
}
