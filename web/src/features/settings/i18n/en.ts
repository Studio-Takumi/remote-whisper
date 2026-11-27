import type { ja } from '@/features/settings/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// 設定（features/settings/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    // DensitySelect.tsx
    'densitySelect.level1': '1 Very brief',
    'densitySelect.level2': '2 Brief',
    'densitySelect.level3': '3 Standard',
    'densitySelect.level4': '4 Detailed',
    'densitySelect.level5': '5 Very detailed',

    // DisplayPage.tsx
    'displayPage.allowedHosts': 'Allowed host names',
    'displayPage.allowedHostsDescription':
        "Names to open with besides IP addresses, localhost, Tailscale names, and this PC's name. Separate with commas",
    'displayPage.connection': 'Connection',
    'displayPage.micShortcut': 'Mic button shortcut',
    'displayPage.sessionMeta': 'Recording date and length in the sidebar',
    'displayPage.showPickedTerms': 'Show term list (from transcript)',
    'displayPage.showSpeakers': 'Show speakers',
    'displayPage.updateCheck': 'Check for updates',
    'displayPage.updateCheckDescription':
        'Sends the host version and an ID (the host ID if registered with the cloud edition, otherwise a random ID) to check for a new version',

    // LanguageRow.tsx
    'languageRow.label': 'Display language',

    // LlmSection.tsx
    'llmSection.backend': 'Summary app',
    'llmSection.backendDescription':
        'The app that makes summaries, term lists, and context. If changed while recording, it switches after the recording stops',
    'llmSection.cancelClear': 'Cancel',
    'llmSection.clear': 'Clear',
    'llmSection.token': '{llm} token',
    'llmSection.tokenClearing': 'Cleared when you save',
    'llmSection.tokenSet': 'Set. Enter only to change it',
    'llmSection.tokenSetShort': 'Set',
    'llmSection.tokenUnset': 'Enter only if {llm} is set to require authentication',
    'llmSection.tokenUnsetShort': 'Not set',
    'llmSection.tunnelLock': "Can't be changed from the cloud edition",
    'llmSection.url': '{llm} URL',

    // MaterialsPage.tsx
    'materialsPage.addFolder': 'Add folder',
    'materialsPage.extensions': 'File types',
    'materialsPage.folder': 'Folder {n}',
    'materialsPage.readFigures': 'Read figures in PDFs',
    'materialsPage.readFiguresDescription':
        'Reads pages with figures as images and uses them for the term list and context. Takes longer to create',
    'materialsPage.removeFolder': 'Remove this folder',
    'materialsPage.sourceFolders': 'Source folders',
    'materialsPage.supportedFileTypes': 'Supported file types',

    // MicDeviceRow.tsx
    'micDeviceRow.allow': 'Allow',
    'micDeviceRow.allowToChoose': 'Allow the microphone to choose one',
    'micDeviceRow.denied': "The microphone can't be used. Allow it in your browser settings",
    'micDeviceRow.label': 'Recording microphone',
    'micDeviceRow.notFound': '{label} (not found)',
    'micDeviceRow.os': 'Let the OS decide',
    'micDeviceRow.unsupported': "Can't be chosen in this browser",
    'micDeviceRow.waitingForDevice': 'Records with the OS default microphone until it connects',

    // ModelsPage.tsx
    'modelsPage.align': 'Timestamp alignment',
    'modelsPage.context': 'Context',
    'modelsPage.figuresDescription': 'Reads figures in PDFs. Choose a model that can read images',
    'modelsPage.finalSummary': 'Final summary',
    'modelsPage.finalSummaryDescription': 'Made after recording stops',
    'modelsPage.intro': "Models for each task ({llm}). Dimmed items are shown only and can't be chosen",
    'modelsPage.notInstalled': 'Not installed',
    'modelsPage.polishDescription': 'Remade from the whole recording after recording stops',
    'modelsPage.polishTranscript': 'WhisperX (Whisper: {model}, same as the real-time transcript)',
    'modelsPage.realTimeSummaryDescription': 'Made every few minutes while recording (thinking mode off)',
    'modelsPage.realTimeTranscript': 'Real-time transcript',
    'modelsPage.referenceMaterialsDescription': 'Creates a term list and context from files with {llm}',
    'modelsPage.restoreRecommended': 'Restore recommended',
    'modelsPage.scope': 'Range selection',
    'modelsPage.scopeDescription': "Decides which parts of the files to use. Small models don't answer consistently",
    'modelsPage.switching': 'Once switched to {llm}, you can choose from the installed models',
    'modelsPage.termListFromMaterials': 'Term list (from materials)',
    'modelsPage.termListFromTranscript': 'Term list (from transcript)',
    'modelsPage.title': 'Title',
    'modelsPage.vad': 'Silence detection',

    // options.ts
    'options.thinkingModeOn': 'Thinking mode on',
    'options.thinkingModeOnMaybeOff': "Thinking mode on (runs with it off on models that don't support it)",
    'options.thinkingModeUnsupported': "This model doesn't support thinking mode, so it runs with it off",

    // push.ts
    'push.denied': 'Notifications are not allowed. Allow notifications for this site in your browser settings',
    'push.insecure': 'Only available when opened over HTTPS (not over http)',
    'push.unsupported':
        'Not available in this browser. On iPhone, only available in the app added to the Home Screen (iOS 16.4 or later)',

    // PushToggle.tsx
    'pushToggle.enabled': 'Notifies this device when the final summary is ready',
    'pushToggle.failed': "Couldn't set up notifications",
    'pushToggle.label': 'Final summary notification',

    // RecordingPage.tsx
    'recordingPage.autoGainControl': 'Browser auto gain control',
    'recordingPage.continueWindow': 'Time to continue recording after it stops',
    'recordingPage.echoCancellation': 'Browser echo cancellation',
    'recordingPage.maxConcurrent': 'Simultaneous recordings',
    'recordingPage.noiseSuppression': 'Browser noise suppression',
    'recordingPage.resumeTimeout': 'Wait time when disconnected',

    // settings.ts
    'settings.autoDetect': 'Auto-detect',
    'settings.sameAsTranscript': 'Same as transcript',

    // settingsActions.ts
    'settingsActions.loadFailed': "Can't load the settings: {message}",
    'settingsActions.lockedWhileRecording':
        "The transcription model, segmentation, and microphone processing can't be changed while recording",
    'settingsActions.notLoaded': "Can't save because the settings haven't loaded",
    'settingsActions.saveFailed': "Can't save the settings: {message}",

    // SettingsDialog.tsx
    'settingsDialog.description': 'Global settings (shared by all devices)',
    'settingsDialog.descriptionRecording': "Global settings (some items can't be changed while recording)",
    'settingsDialog.loadFailed': "The settings haven't loaded",
    'settingsDialog.reload': 'Reload',
    'settingsDialog.title': 'Settings',

    // SettingsForm.tsx
    'settingsForm.cancel': 'Cancel',
    'settingsForm.save': 'Save',

    // SettingsTabList.tsx
    'settingsTabList.display': 'Display & more',
    'settingsTabList.models': 'Models',
    'settingsTabList.recording': 'Recording',
    'settingsTabList.setup': 'Setup',
    'settingsTabList.storage': 'Storage',

    // SetupPage.tsx
    'setupPage.checking': 'Checking…',

    // ShortcutInput.tsx
    'shortcutInput.escToCancel': 'Press Esc to cancel',
    'shortcutInput.modifierSeparator': ', ',
    'shortcutInput.needsModifier': 'Press it together with one of {modifiers}',
    'shortcutInput.none': 'None',
    'shortcutInput.pressKey': 'Press a key…',
    'shortcutInput.reset': 'Reset to default',

    // StoragePage.tsx
    'storagePage.days': 'days',
    'storagePage.recordingFile': 'Recording file',
    'storagePage.retention': 'Retention period',
    'storagePage.retentionDescription': 'Files past the period are deleted automatically. 0 means keep forever',
    'storagePage.summaryDescription': "Copies placed in the chosen directory aren't deleted",

    // SummaryPage.tsx
    'summaryPage.detailedSummaryDescription': 'A summary of each part (for short recordings, the summary itself)',
    'summaryPage.keepAlive': 'Time before stopping the model after summarizing',
    'summaryPage.language': 'Summary language',
    'summaryPage.languageDescription': 'The title is also in this language',
    'summaryPage.materialPages': 'Show reference material pages',
    'summaryPage.materialPagesDescription':
        'Shows the matching page of the files in detailed summary items, like “from xx.pdf p.12” (PDF only)',
    'summaryPage.overviewDescription': 'Bullet points at the top for long recordings',
    'summaryPage.pickTerms': 'Extract terms while recording',
    'summaryPage.pickTermsDescription':
        'Increases GPU load. Terms are only extracted when the switch in Reference materials is also on',
    'summaryPage.realTimeInterval': 'Real-time summary interval',
    'summaryPage.realTimeSummaryDescription': 'A summary about every 4,000 characters',
    'summaryPage.summaryDetailLevel': 'Summary detail level',
    'summaryPage.summaryDetailLevelDescription': '1 is just the key points, getting more detailed toward 5',

    // ThemeToggle.tsx
    'themeToggle.current': 'Theme: {name}',
    'themeToggle.dark': 'Dark',
    'themeToggle.light': 'Light',
    'themeToggle.system': 'Match system',
    'themeToggle.theme': 'Theme',
    'themeToggle.tooltip': '{label} (press to switch to “{next}”)',

    // VersionInfo.tsx
    'versionInfo.mismatch': 'The client is a different version from the host',
    'versionInfo.releaseNotes': 'Release notes',
    'versionInfo.reload': 'Reload',
    'versionInfo.updateAvailable': '{version} is available',
    'versionInfo.versions': 'Host {host} · Client {client}',

    // WhisperPage.tsx
    'whisperPage.beamSize': 'Beam size',
    'whisperPage.beamSizeDescription': 'Larger is more accurate but slower',
    'whisperPage.computeType': 'Compute precision',
    'whisperPage.computeTypeDescription': 'int8 uses less VRAM but is slightly less accurate',
    'whisperPage.language': 'Transcription language',
    'whisperPage.languageDescription': 'With auto-detect, the language is detected when polishing',
    'whisperPage.maxSegment': 'Maximum chunk length',
    'whisperPage.milliseconds': 'ms',
    'whisperPage.partialInterval': 'Partial result interval',
    'whisperPage.polishDescription': 'After recording stops, polishes the transcript to make it easier to read',
    'whisperPage.seconds': 'sec',
    'whisperPage.silence': 'Silence treated as a break',
    'whisperPage.speakerLabelingDescription':
        "Splits the polished transcript into “Speaker 1” and so on. Requires a HuggingFace token and accepting the model's terms of use",
    'whisperPage.speechAuto': 'Auto',
    'whisperPage.speechDbfs': 'Volume in manual mode',
    'whisperPage.speechDbfsDescription': 'Sound louder than this is treated as speech (-70 to -10)',
    'whisperPage.speechManual': 'Manual (volume)',
    'whisperPage.speechThreshold': 'Speech detection',
    'whisperPage.speechThresholdDescription': 'Auto uses Silero VAD; manual uses volume',
    'whisperPage.unloadAfter': 'Time before stopping the model after recording stops',

    // 複数のファイルで使う文
    'common.detailedSummary': 'Detailed summary',
    'common.figureReading': 'Figure reading',
    'common.minutes': 'min',
    'common.overview': 'Overview',
    'common.polish': 'Polish',
    'common.realTimeSummary': 'Real-time summary',
    'common.referenceMaterials': 'Reference materials',
    'common.speakerLabeling': 'Speaker labeling',
    'common.summary': 'Summary',
    'common.thisDevice': 'This device',
    'common.thisDeviceDescription': 'Takes effect as soon as you change it, without pressing Save',
    'common.transcript': 'Transcript',
});
