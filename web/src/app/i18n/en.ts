import type { ja } from '@/app/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// アプリの枠（app/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    // App.tsx
    'app.settingsSaved': 'Settings saved',

    // AppSidebar.tsx
    'appSidebar.account': 'Account',
    'appSidebar.newProject': 'Create project',
    'appSidebar.settings': 'Settings',

    // DevPanel.tsx
    'devPanel.connection': 'Connection',
    'devPanel.emptyProjects': 'Clear projects',
    'devPanel.microphone': 'Microphone',
    'devPanel.panel': 'Developer panel',
    'devPanel.title': 'Developer',

    // GpuIndicator.tsx
    'gpuIndicator.waiting': '{count} waiting',

    // GpuJobList.tsx
    'gpuJobList.elapsed': '{time} elapsed',
    'gpuJobList.none': 'None',
    'gpuJobList.note': 'The GPU runs one job at a time. While a summary is being made, transcription has to wait',
    'gpuJobList.running': 'Running',
    'gpuJobList.unavailable': 'Usage is unavailable (e.g. no NVIDIA GPU)',
    'gpuJobList.usage': 'Usage {util}% · VRAM {used} / {total} GB',
    'gpuJobList.waited': 'Waited {time}',
    'gpuJobList.waiting': 'Waiting (in run order)',

    // GpuJobRow.tsx
    'gpuJobRow.detail': '{progress}, {time}',
    'gpuJobRow.notFound': '(Not found)',
    'gpuJobRow.open': 'Open session “{title}” ({kind}, {detail})',
    'gpuJobRow.progress': '{kind} progress',

    // gpuJobs.ts
    'gpuJobs.detailSeparator': ', ',
    'gpuJobs.trigger': 'GPU status and job list',
    'gpuJobs.triggerWithDetails': 'GPU status and job list ({details})',
    'gpuJobs.usage': 'Usage {util}%',
    'gpuJobs.waiting': '{count} waiting',

    // HostUpdateNotice.tsx
    'hostUpdateNotice.available': '{version} is available',
    'hostUpdateNotice.description': 'Update the host to use it',
    'hostUpdateNotice.releaseNotes': 'Release notes',

    // PwaUpdater.tsx
    'pwaUpdater.preloadError': "Part of the screen couldn't be loaded (the host has a new version)",
    'pwaUpdater.preloadErrorHint': 'Reload to fix it',
    'pwaUpdater.reload': 'Reload',
    'pwaUpdater.update': 'Update',
    'pwaUpdater.updateAfterRecording': 'Update after you stop recording',
    'pwaUpdater.updateAvailable': 'A new version of the app is available',
    'pwaUpdater.updateReloads': 'Updating reloads the page',

    // serverMessages.ts
    'serverMessages.referenceMaterialsCreated': 'Reference materials are ready',
    'serverMessages.referenceMaterialsFailed':
        "Couldn't create reference materials (the files can't be read, or can't connect to {llm})",

    // sessionSync.ts
    'sessionSync.loadFailed': "Can't load the session: {error}",
    'sessionSync.polishRegenerated': 'Polished transcript regenerated',
    'sessionSync.regenerateSummary': 'Regenerate the summary too',

    // TopBar.tsx
    'topBar.hostLocked': "You can't switch hosts while recording",
    'topBar.menuOpen': 'Open menu',
    'topBar.model': 'Model',
    'topBar.modelSettings': 'Open model settings ({model})',
});
