import { useEffect, useRef, useState } from 'react';

import { toast } from 'sonner';

import { AppSidebar } from '@/components/AppSidebar';
import { ContextSetSheet } from '@/components/ContextSetSheet';
import { DevPanel } from '@/components/DevPanel';
import { MicButton, type MicTarget } from '@/components/MicButton';
import { NewProjectDialog } from '@/components/NewProjectDialog';
import { SessionView } from '@/components/SessionView';
import { SettingsDialog } from '@/components/SettingsDialog';
import { TopBar } from '@/components/TopBar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { useRecordingTimer } from '@/hooks/useRecordingTimer';
import {
    type ContextSelection,
    type ContextSet,
    type Generating,
    type Project,
    type Session,
    initialContextSets,
    initialProjects,
} from '@/mock';
import type { RecordingState } from '@/recording';
import { type Settings, defaultSettings } from '@/settings';
import { initialServerStatus } from '@/status';
import { formatDateTime, newId } from '@/time';

type Selection = { projectId: string | null; sessionId: string | null };

function updateSession(projects: Project[], sessionId: string, fn: (s: Session) => Session) {
    return projects.map((p) => ({ ...p, sessions: p.sessions.map((s) => (s.id === sessionId ? fn(s) : s)) }));
}

function App() {
    const [projects, setProjects] = useState(initialProjects);
    const [selection, setSelection] = useState<Selection>({ projectId: null, sessionId: null });
    const [recordingState, setRecordingState] = useState<RecordingState>('idle');
    const recording = recordingState !== 'idle';
    const timer = useRecordingTimer(recordingState);
    const [settings, setSettings] = useState(defaultSettings);
    const [server, setServer] = useState(initialServerStatus);
    const [contextSets, setContextSets] = useState(initialContextSets);
    const [contextSelections, setContextSelections] = useState<Record<string, ContextSelection>>({});
    const [generating, setGenerating] = useState<Generating | null>(null);
    const generationTimer = useRef<ReturnType<typeof setInterval>>(undefined);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [newProjectOpen, setNewProjectOpen] = useState(false);
    const [noProjects, setNoProjects] = useState(false);

    useEffect(() => () => clearInterval(generationTimer.current), []);

    const visibleProjects = noProjects ? [] : projects;
    const project = visibleProjects.find((p) => p.id === selection.projectId);
    const session = project?.sessions.find((s) => s.id === selection.sessionId);
    const projectSets = project ? (contextSets[project.id] ?? []) : [];
    const contextSelection = (project && contextSelections[project.id]) ?? {
        setId: projectSets.find((s) => s.status === 'ready')?.id ?? null,
        useHotwords: true,
        useContext: true,
    };

    const micTarget: MicTarget = !project
        ? { kind: 'none' }
        : session
          ? { kind: 'session', projectName: project.name }
          : { kind: 'new' };

    // 最終の要約を作る（ダミー）。少しずつ文字を足して、ストリーミングで届く様子をまねる
    function generateSummary(target: Session, model: string) {
        if (server.ollama === 'error') {
            toast.error('Ollama に接続できないため、要約を作れません');
            return;
        }
        clearInterval(generationTimer.current);
        const base = target.summaries.at(-1)?.text ?? '## 要約\n- 文字起こしが短いため、要約する内容がありません';
        const full = `${base}\n\n> ${model} で作ったダミーの要約です`;
        let length = 0;
        setGenerating({ sessionId: target.id, model, text: '' });
        generationTimer.current = setInterval(() => {
            length += 6;
            if (length < full.length) {
                setGenerating({ sessionId: target.id, model, text: full.slice(0, length) });
                return;
            }
            clearInterval(generationTimer.current);
            setGenerating(null);
            const summary = { generationId: newId(), model, generatedAt: formatDateTime(), text: full };
            setProjects((ps) => updateSession(ps, target.id, (s) => ({ ...s, summaries: [...s.summaries, summary] })));
        }, 50);
    }

    // 簡易設定・設定モーダルのどちらからでも呼ぶ。最終の要約のモデルを変えたとき、そのモデルの要約がなければ作る
    function changeSettings(next: Settings) {
        const model = next.ollama.finalSummaryModel;
        if (
            model !== settings.ollama.finalSummaryModel &&
            session &&
            !session.summaries.some((s) => s.model === model)
        ) {
            generateSummary(session, model);
        }
        setSettings(next);
    }

    function startRecording() {
        if (!project) {
            toast.info('録音するプロジェクトを左のメニューから選んでください');
            return;
        }
        // 既存のセッションを開いていたら、同じプロジェクトの新しいセッションの画面に切り替えるだけにする
        // 録音を始める前に、モデルや参考資料を選び直せるようにするため
        if (session) {
            setSelection({ projectId: project.id, sessionId: null });
            return;
        }
        if (server.microphone === 'denied') {
            toast.error('マイクが使えません。ブラウザの設定でマイクを許可してください');
            return;
        }
        timer.reset();
        setRecordingState('recording');
        // Whisper は録音を始めたときに読み込む（spec 6.2 節）
        if (server.whisper === 'unloaded') {
            setServer((s) => ({ ...s, whisper: 'loading' }));
            setTimeout(() => setServer((s) => (s.whisper === 'loading' ? { ...s, whisper: 'ready' } : s)), 2000);
        }
    }

    // 録音を終えたら、セッションを作って開き、最終の要約を作り始める
    function stopRecording() {
        setRecordingState('idle');
        if (!project) {
            return;
        }
        const now = new Date();
        const created: Session = {
            id: newId(now),
            title: '新しいセッション',
            startedAt: formatDateTime(now),
            status: 'done',
            transcript: [],
            summaries: [],
        };
        setProjects((ps) => ps.map((p) => (p.id === project.id ? { ...p, sessions: [created, ...p.sessions] } : p)));
        setSelection({ projectId: project.id, sessionId: created.id });
        generateSummary(created, settings.ollama.finalSummaryModel);
    }

    function changeContextSelection(next: ContextSelection) {
        if (project) {
            setContextSelections((cs) => ({ ...cs, [project.id]: next }));
        }
    }

    // 同じ資料の組み合わせのセットがあれば、作り直さずに使い回す（spec 6.6 節）
    function createContextSet(materials: string[]) {
        if (!project) {
            return;
        }
        const pid = project.id;
        const same = projectSets.find((s) => s.materials.join('\n') === materials.join('\n'));
        if (same) {
            changeContextSelection({ ...contextSelection, setId: same.id });
            toast.info('同じ資料で作ったセットがあるので、それを使います');
            return;
        }
        const created: ContextSet = { id: newId(), status: 'generating', materials };
        setContextSets((cs) => ({ ...cs, [pid]: [...(cs[pid] ?? []), created] }));
        changeContextSelection({ ...contextSelection, setId: created.id });
        setTimeout(() => {
            setContextSets((cs) => ({
                ...cs,
                [pid]: (cs[pid] ?? []).map((s) => (s.id === created.id ? { ...s, status: 'ready' } : s)),
            }));
            toast.success('参考資料セットができました');
        }, 4000);
    }

    return (
        <SidebarProvider>
            <AppSidebar
                recording={recording}
                projects={visibleProjects}
                activeProject={selection.projectId}
                activeSession={selection.sessionId}
                onSelectSession={(projectId, sessionId) => setSelection({ projectId, sessionId })}
                onNewSession={(projectId) => setSelection({ projectId, sessionId: null })}
                onNewProject={() => setNewProjectOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
            />
            <SidebarInset className='gap-4 p-4'>
                <TopBar
                    recording={recording}
                    settings={settings}
                    onChangeSettings={changeSettings}
                    contextSheet={
                        <ContextSetSheet
                            project={project}
                            sets={projectSets}
                            selection={contextSelection}
                            roots={settings.materials.roots}
                            extensions={settings.materials.extensions}
                            onChangeSelection={changeContextSelection}
                            onCreate={createContextSet}
                        />
                    }
                />
                <SessionView
                    hasProjects={visibleProjects.length > 0}
                    project={project}
                    session={session}
                    recordingState={recordingState}
                    server={server}
                    liveIntervalMin={settings.ollama.liveSummaryIntervalMin}
                    finalModel={settings.ollama.finalSummaryModel}
                    generating={generating}
                />
                <MicButton
                    state={recordingState}
                    target={micTarget}
                    elapsed={timer.elapsed}
                    onStart={startRecording}
                    onStop={stopRecording}
                    onPause={() => setRecordingState('paused')}
                    onResume={() => setRecordingState('recording')}
                />
            </SidebarInset>
            <NewProjectDialog
                open={newProjectOpen}
                onOpenChange={setNewProjectOpen}
                roots={settings.materials.roots}
                onCreate={(path) => toast.success(`${path} をプロジェクトにしました`)}
            />
            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                settings={settings}
                onSave={(s) => {
                    changeSettings(s);
                    toast.success('設定を保存しました');
                }}
            />
            <DevPanel
                server={server}
                onChangeServer={setServer}
                noProjects={noProjects}
                onChangeNoProjects={setNoProjects}
            />
            <Toaster />
        </SidebarProvider>
    );
}

export default App;
