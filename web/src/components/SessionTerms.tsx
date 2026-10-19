import { useState } from 'react';

import { PlusIcon, TagsIcon, XIcon } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { useAppStore } from '@/store';
import { splitTerms } from '@/terms';
import type { Session } from '@/types';

// 用語リストの欄。手で足した語と、録音中に文字起こしから拾って足した語（#103）を出し、どちらも × で外せる。
// 手で足す入力は、録音中・一時停止中・録音後のどれでも出す（#175）。
// 拾った語の一覧は showPicked（全体設定 display.showPickedTerms、#147）がオンのときだけ出す
export function SessionTerms({ session, showPicked }: { session: Session; showPicked: boolean }) {
    const reject = useAppStore((s) => s.rejectTerm);
    const addTerm = useAppStore((s) => s.addTerm);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    // 録音を終えたあとに足した語は、浄書済みの文字起こしを作り直すまで反映されない
    const [addedAfterRecording, setAddedAfterRecording] = useState(false);
    const manual = session.manualTerms ?? [];
    const picked = showPicked ? (session.pickedTerms ?? []) : [];

    const add = async (terms: string[]) => {
        if (terms.length === 0 || busy) {
            return;
        }
        setBusy(true);
        try {
            let ok = true;
            for (const term of terms) {
                ok = (await addTerm(session.id, term)) && ok;
            }
            if (ok) {
                setDraft('');
            }
            if (session.status !== 'recording') {
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
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                void add(splitTerms(draft));
                            }
                        }}
                        onPaste={(e) => {
                            const text = e.clipboardData.getData('text');
                            // 複数行の貼り付けは、行ごとに足す
                            if (/[\r\n]/.test(text)) {
                                e.preventDefault();
                                void add(splitTerms(text));
                            }
                        }}
                    />
                </label>
            </div>
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
