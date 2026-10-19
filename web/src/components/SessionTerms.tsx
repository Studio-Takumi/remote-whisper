import { useState } from 'react';

import { PlusIcon, TagsIcon, XIcon } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { useAppStore } from '@/store';
import { addAll, describeInvalid, isSubmitKey, parseTermInput, remainingDraft } from '@/terms';
import type { Session } from '@/types';

// 用語リストの欄。手で足した語と、録音中に文字起こしから拾って足した語（#103）を出し、どちらも × で外せる。
// 手で足す入力は、録音中・一時停止中・録音後のどれでも出す（#175）。
// 拾った語の一覧は showPicked（全体設定 display.showPickedTerms、#147）がオンのときだけ出す
export function SessionTerms({ session, showPicked }: { session: Session; showPicked: boolean }) {
    const reject = useAppStore((s) => s.rejectTerm);
    const addTerm = useAppStore((s) => s.addTerm);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    // 足せなかった語と、その理由
    const [problem, setProblem] = useState('');
    // 録音を終えたあとに足した語は、浄書済みの文字起こしを作り直すまで反映されない
    const [addedAfterRecording, setAddedAfterRecording] = useState(false);
    const manual = session.manualTerms ?? [];
    const picked = showPicked ? (session.pickedTerms ?? []) : [];

    // 入力（複数行でもよい）を、確かめてから行ごとに足す。足せなかった語だけを入力欄に残し、理由を出す
    const add = async (text: string, fromPaste = false) => {
        const { valid, invalid } = parseTermInput(text);
        if (valid.length === 0 && invalid.length === 0) {
            return;
        }
        setBusy(true);
        try {
            const { added, failed } = await addAll(valid, (term) => addTerm(session.id, term));
            const left = [...invalid.map((x) => x.term), ...failed];
            const reasons = [
                ...(invalid.length > 0 ? [describeInvalid(invalid)] : []),
                ...(failed.length > 0 ? [`足せませんでした（${failed.length} 語）`] : []),
            ];
            setProblem(reasons.join(' / '));
            if (left.length > 0) {
                setDraft(remainingDraft(left));
            } else if (!fromPaste) {
                setDraft('');
            }
            // 録音を終えたあとに足せたときだけ出す
            if (added.length > 0 && session.status !== 'recording') {
                setAddedAfterRecording(true);
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className='flex flex-col gap-1.5 text-xs'>
            <div className='flex flex-wrap items-center gap-1.5'>
                <span className='flex items-center gap-1 text-muted-foreground'>
                    <TagsIcon className='size-3.5' />
                    用語
                </span>
                {manual.map((term) => (
                    <TermChip
                        key={`m-${term}`}
                        term={term}
                        manual
                        onRemove={() => void reject(session.id, term)}
                        title='手で足した語を外す'
                    />
                ))}
                {picked.map((term) => (
                    <TermChip
                        key={`p-${term}`}
                        term={term}
                        onRemove={() => void reject(session.id, term)}
                        title='誤った語なら外す（このセッションでは、以後足さない）'
                    />
                ))}
                <label className='flex items-center gap-1'>
                    <PlusIcon className='size-3.5 text-muted-foreground' />
                    <Input
                        className='h-7 w-40 text-xs md:text-xs'
                        placeholder='用語を足す'
                        aria-label='用語を足す'
                        value={draft}
                        disabled={busy}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            // 変換の確定の Enter では足さない
                            if (isSubmitKey({ key: e.key, isComposing: e.nativeEvent.isComposing })) {
                                e.preventDefault();
                                void add(draft);
                            }
                        }}
                        onPaste={(e) => {
                            const text = e.clipboardData.getData('text');
                            // 複数行の貼り付けは、行ごとに足す
                            if (/[\r\n]/.test(text)) {
                                e.preventDefault();
                                void add(text, true);
                            }
                        }}
                    />
                </label>
            </div>
            {problem && (
                <p role='alert' className='text-destructive'>
                    {problem}
                </p>
            )}
            {addedAfterRecording && (
                <p className='text-muted-foreground'>浄書済み文字起こしを再生成すると反映されます</p>
            )}
        </div>
    );
}

function TermChip({
    term,
    manual = false,
    onRemove,
    title,
}: {
    term: string;
    manual?: boolean;
    onRemove: () => void;
    title: string;
}) {
    // 手で足した語は枠を濃くして、拾った語と見分ける
    const border = manual ? 'border-foreground/60 bg-muted' : 'border-border bg-muted/40';
    return (
        <span className={`flex items-center gap-0.5 rounded-full border py-0.5 pr-1 pl-2 ${border}`}>
            {term}
            <button
                className='rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground'
                aria-label={`「${term}」を用語リストから外す`}
                title={title}
                onClick={onRemove}
            >
                <XIcon className='size-3' />
            </button>
        </span>
    );
}
