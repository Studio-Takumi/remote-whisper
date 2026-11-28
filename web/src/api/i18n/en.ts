import type { ja } from '@/api/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// API・状態（api/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    // 2 つ以上のファイルで使う文
    'common.hostUnreachable': "Can't reach the host",

    // connection.ts
    'connection.noResponse': 'No response from the host',

    // endpoint.ts
    'endpoint.noHost': 'No host selected',

    // sessions.ts
    'sessions.newSession': 'New session',

    // status.ts（blockedBy* は status.transcriptWaiting の {reason} に入るので小文字で始める）
    'status.blockedByFinalSummary': 'the final summary is being generated',
    'status.blockedByLiveSummary': 'the real-time summary is being generated',
    'status.blockedByMaterialRange': 'reference materials are being regenerated',
    'status.blockedByOther': 'other work is running',
    'status.blockedByPolish': 'the transcript is being polished',
    'status.blockedByReferenceMaterials': 'reference materials are being created',
    'status.blockedByTerms': 'terms are being extracted',
    'status.jobKindFinalSummary': 'Final summary',
    'status.jobKindLiveSummary': 'Real-time summary',
    'status.jobKindMaterialRange': 'Regenerating reference materials for the covered range',
    'status.jobKindOther': 'Other',
    'status.jobKindPolish': 'Polishing the transcript',
    'status.jobKindReferenceMaterials': 'Creating reference materials',
    'status.jobKindTerms': 'Extracting terms from the transcript',
    'status.jobKindTranscribe': 'Transcript',
    'status.jobKindTranscriptModelLoad': 'Loading the transcription model',
    'status.stepAlign': 'Alignment',
    'status.stepCondense': 'Condensing the detailed summary',
    'status.stepDetailedSummary': 'Detailed summary',
    'status.stepLoad': 'Loading the model',
    'status.stepOverview': 'Overview',
    'status.stepPages': 'Page references',
    'status.stepSpeakerLabeling': 'Speaker labeling',
    'status.stepSummary': 'Summary',
    'status.stepTitle': 'Title',
    'status.stepTranscribe': 'Transcript',
    'status.summaryLlmUnavailable':
        "Can't connect to {llm}, so no summary can be made. You can regenerate it after recording",
    'status.summaryPaused': 'Paused. Summary updates resume when you resume recording',
    'status.summaryReconnecting': 'Reconnecting to the host… (still recording)',
    'status.summaryRecording': 'Recording. The real-time summary is refreshed every {minutes} min…',
    'status.transcriptIdle': 'Idle',
    'status.transcriptIdleReconnecting': 'Not connected to the host. Reconnecting…',
    'status.transcriptLoadingModel': 'Loading the transcription model… (audio is being saved)',
    'status.transcriptPaused': 'Paused',
    'status.transcriptReconnecting': 'Reconnecting to the host… (still recording on this device)',
    'status.transcriptRunning': 'Transcribing…',
    'status.transcriptStopped': 'Transcription has stopped. The audio is saved, so you can regenerate it later',
    'status.transcriptWaiting': 'Waiting to transcribe because {reason}… (audio is being saved)',
});
