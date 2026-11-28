import type { ja } from '@/features/projects/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// プロジェクト（features/projects/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    // loadProjects.ts
    'loadProjects.failed': "Can't load projects: {error}",

    // move.ts
    'move.blockedByGpu': "Can't move a session that is waiting for or running GPU work",
    'move.blockedByPolish': "Can't move a session whose polished transcript is being made",
    'move.blockedByRecording': "Can't move a session that is recording",
    'move.blockedBySummary': "Can't move a session whose summary is being made",

    // NewProjectDialog.tsx
    'newProjectDialog.cancel': 'Cancel',
    'newProjectDialog.chooseFolder': 'Choose a folder',
    'newProjectDialog.create': 'Create with this folder',
    'newProjectDialog.description':
        'Choose the folder to make into a project. Copies of final summaries are placed in this folder',
    'newProjectDialog.listFailed': "Can't load the folder list: {error}",
    'newProjectDialog.loading': 'Loading…',
    'newProjectDialog.noFolders': 'No source folders. Add them in Settings under “Reference materials”',
    'newProjectDialog.title': 'Create project',

    // projectActions.ts
    'projectActions.createFailed': "Can't make it a project: {error}",
    'projectActions.created': 'Made {path} a project',
    'projectActions.moveFailed': "Can't move “{title}”: {error}",
    'projectActions.moved': 'Moved “{title}” to {project}',
    'projectActions.reorderFailed': "Can't save the project order: {error}",

    // ProjectGroup.tsx
    'projectGroup.newSession': 'New recording in {name}',
    'projectGroup.reorder': 'Reorder {name}',

    // ProjectList.tsx
    'projectList.dragCancel': 'Stopped moving “{name}”',
    'projectList.dragEndDropped': 'Placed “{name}” at the position of “{over}”',
    'projectList.dragEndReturned': 'Returned “{name}”',
    'projectList.dragOver': 'Moving “{name}” to the position of “{over}”',
    'projectList.dragStart': 'Picked up “{name}”',
    'projectList.empty': 'No projects yet',
    'projectList.screenReaderInstructions':
        'To reorder projects, press Space to pick one up, the up and down arrows to move it, and Space to drop it. Press Esc to cancel',

    // SessionItem.tsx
    'sessionItem.fromAudioFile': 'Created from audio file',
    'sessionItem.recording': 'Recording',

    // sessionMeta.ts
    'sessionMeta.recording': '{started} · Recording',
});
