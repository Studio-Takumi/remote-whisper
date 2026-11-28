import type { ja } from '@/features/materials/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// 参考資料（features/materials/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    // contextSetActions.ts
    'contextSetActions.createFailed': "Can't create reference materials: {error}",
    'contextSetActions.created': 'Reference materials are ready',
    'contextSetActions.lockedWhileRecording': "You can't change reference materials while recording",
    'contextSetActions.reused': 'Reference materials from the same files already exist, so they will be used',
    'contextSetActions.selectionFailed': "Can't save the reference materials selection: {error}",

    // ContextSetSheet.tsx
    'contextSetSheet.createNew': 'Choose files and create new',
    'contextSetSheet.description':
        'Creates a term list and context from the chosen files, used for transcripts and summaries (per project)',
    'contextSetSheet.generating': "Creating. If you start recording, they're used from the moment they're ready",
    'contextSetSheet.none': 'None',
    'contextSetSheet.pickTerms': 'Pick up terms while recording',
    'contextSetSheet.pickTermsDescription':
        'Adds proper nouns and technical terms that appear often in the transcript to the term list',
    'contextSetSheet.pickTermsOff': 'Turned off in Settings (Summary)',
    'contextSetSheet.project': 'Project: {name}',
    'contextSetSheet.selectProject': 'Choose a project from the menu first',
    'contextSetSheet.statusFailed': '(Failed)',
    'contextSetSheet.statusGenerating': '(Creating…)',
    'contextSetSheet.title': 'Reference materials',
    'contextSetSheet.unused': "Don't use",
    'contextSetSheet.useContext': 'Use context',
    'contextSetSheet.useTermList': 'Use term list',

    // MaterialPickerDialog.tsx
    'materialPickerDialog.cancel': 'Cancel',
    'materialPickerDialog.create': 'Create from these files',
    'materialPickerDialog.description': 'Creates a term list and context from the chosen files (takes a few minutes)',
    'materialPickerDialog.extensions': 'Supported file types: {extensions}',
    'materialPickerDialog.listFailed': "Can't load the folder list: {error}",
    'materialPickerDialog.loading': 'Loading…',
    'materialPickerDialog.noFolders': 'No source folders. Add them in Settings under “Reference materials”',
    'materialPickerDialog.selected': '{count} selected',
    'materialPickerDialog.title': 'Choose reference materials',

    // materialRange.ts（例: slides.pdf pages 12–30, 40–42）
    'materialRange.file': '{file} {unit} {spans}',
    'materialRange.page': 'pages',
    'materialRange.partSeparator': '; ',
    'materialRange.redone': 'Reference materials were recreated from the range covered this time ({parts})',
    'materialRange.section': 'sections',
    'materialRange.span': '{from}–{to}',
    'materialRange.spanSeparator': ', ',

    // SummaryDirField.tsx
    'summaryDirField.hint': 'Path relative to the chosen directory',
    'summaryDirField.label': 'Final summary copy location',
    'summaryDirField.placeholder': 'Empty for the top level (e.g. summary)',
    'summaryDirField.save': 'Save',
    'summaryDirField.saveFailed': "Can't save the final summary copy location: {error}",
    'summaryDirField.saved': 'Final summary copy location saved',
});
