import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/api';
import { demoProjects } from '@/api/mock';
import { DEMO_ACTIONS, type DemoAction, blockInDemo, demoRefusal } from '@/app/demoGuard';
import { readProjects, readSession } from '@/app/sessionData';
import { useAppStore } from '@/app/store';

// デモ版のビルド（#414）として読み込む。同梱したデータはないので、mock.ts のダミーデータで動く
vi.mock('@/api/demoBuild', () => ({ isDemoBuild: true }));

const [meetings, lectures] = demoProjects;
const opened = meetings.sessions[0];

// 一覧（プロジェクトの順と、セッションの置き場所）と、開いているセッションの中身
function snapshot() {
    const s = useAppStore.getState();
    return {
        projects: readProjects(s).map((p) => ({ id: p.id, sessions: p.sessions.map((x) => x.id) })),
        session: readSession(s, opened.id),
        selection: s.selection,
        recordingState: s.recordingState,
        uploading: s.uploading,
        pickedAudio: s.pickedAudio,
        generating: s.generating,
        contextSelections: s.contextSelections,
        projectOrder: s.settings.projectOrder,
    };
}

let info: ReturnType<typeof vi.spyOn>;
let calls: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
    vi.restoreAllMocks();
    info = vi.spyOn(toast, 'info');
    calls = (['get', 'post', 'patch', 'put', 'delete'] as const).map((m) => vi.spyOn(api, m));
    useAppStore.setState({ selection: { projectId: meetings.id, sessionId: opened.id } });
});

// 止めた操作は、文言をトーストで出し、サーバーに投げず、データも変えない
async function expectRefused(action: DemoAction, run: () => unknown) {
    const before = snapshot();
    await run();
    expect(info).toHaveBeenCalledWith(demoRefusal(action), expect.anything());
    for (const call of calls) {
        expect(call).not.toHaveBeenCalled();
    }
    expect(snapshot()).toEqual(before);
}

describe('デモ版で止める操作', () => {
    it('文言は「デモ版のため〜はできません」', () => {
        expect(demoRefusal('createProject')).toBe('デモ版のため新たにプロジェクトを作成することはできません');
        expect(demoRefusal('newSession')).toBe('デモ版のため新たにセッションを作成することはできません');
        expect(demoRefusal('copy')).toBe('デモ版のためコピーすることはできません');
        for (const action of Object.keys(DEMO_ACTIONS) as DemoAction[]) {
            expect(demoRefusal(action)).toMatch(/^デモ版のため.+ことはできません$/);
        }
    });

    it('blockInDemo は true を返し、同じ文言のトーストは 1 つにまとめる', () => {
        expect(blockInDemo('copy')).toBe(true);
        const message = demoRefusal('copy');
        expect(info).toHaveBeenCalledWith(message, { id: message });
    });

    it('新規プロジェクトの作成', () =>
        expectRefused('createProject', () => useAppStore.getState().createProject('D:\\work\\new')));

    it('サイドバーの ＋（新しいセッション）', () =>
        expectRefused('newSession', () => useAppStore.getState().newSession(lectures.id)));

    it('録音と続きから録音', async () => {
        await expectRefused('record', () => useAppStore.getState().startRecording());
        await expectRefused('record', () => useAppStore.getState().continueRecording(opened.id));
    });

    it('音声ファイルのアップロード（1 つ・複数・まとめる）', async () => {
        const file = new File(['x'], 'a.mp3', { type: 'audio/mpeg' });
        await expectRefused('upload', () => useAppStore.getState().uploadAudio(meetings.id, file));
        await expectRefused('upload', () => useAppStore.getState().pickAudioFiles(meetings.id, [file, file]));
        useAppStore.setState({ pickedAudio: { projectId: meetings.id, files: [file, file] } });
        await useAppStore.getState().uploadSources(0);
        expect(info).toHaveBeenLastCalledWith(demoRefusal('upload'), expect.anything());
        expect(useAppStore.getState().uploading).toBeNull();
        expect(calls.every((c) => c.mock.calls.length === 0)).toBe(true);
    });

    it('セッションの移動とプロジェクトの並べ替え', async () => {
        await expectRefused('moveSession', () =>
            useAppStore.getState().moveSession(meetings.id, opened.id, lectures.id),
        );
        await expectRefused('reorderProjects', () =>
            useAppStore.getState().reorderProjects([lectures.id, meetings.id]),
        );
    });

    it('要約と浄書済み文字起こしの再生成', async () => {
        await expectRefused('regenerateSummary', () => useAppStore.getState().regenerateSummary(opened.id));
        await expectRefused('regenerateFinalTranscript', () =>
            useAppStore.getState().regenerateFinalTranscript(opened.id),
        );
    });

    it('用語リストと置き換え（修正）', async () => {
        let added: boolean | undefined;
        await expectRefused('terms', async () => (added = await useAppStore.getState().addTerm(opened.id, '新語')));
        expect(added).toBe(false);
        await expectRefused('terms', () => useAppStore.getState().rejectTerm(opened.id, '定例'));
        const correction = { from: '定例', to: '例会', line: null };
        let corrected: boolean | undefined;
        await expectRefused(
            'correct',
            async () => (corrected = await useAppStore.getState().addCorrection(opened.id, correction)),
        );
        expect(corrected).toBe(false);
        await expectRefused('correct', () => useAppStore.getState().removeCorrection(opened.id, correction));
    });

    it('参考資料の選択と作成', async () => {
        await expectRefused('contextSet', () =>
            useAppStore.getState().changeContextSelection({
                setId: null,
                useHotwords: false,
                useContext: false,
                pickTerms: false,
            }),
        );
        await expectRefused('contextSet', () => useAppStore.getState().createContextSet(['a.md']));
    });
});
