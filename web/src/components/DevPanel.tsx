import { useState } from 'react';

import { WrenchIcon } from 'lucide-react';

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/store';

// 開発中だけ出す、状態を切り替えるパネル。サーバーがなくても、状態ごとの表示を確かめられるようにする
export function DevPanel() {
    const server = useAppStore((s) => s.server);
    const onChangeServer = useAppStore((s) => s.setServer);
    const noProjects = useAppStore((s) => s.noProjects);
    const onChangeNoProjects = useAppStore((s) => s.setNoProjects);
    const [open, setOpen] = useState(false);

    if (!import.meta.env.DEV) {
        return null;
    }

    return (
        <div className='fixed right-4 bottom-4 z-40 flex flex-col items-end gap-2'>
            {open && (
                <div className='flex w-64 flex-col gap-2 rounded-lg border bg-background p-3 text-xs shadow-lg'>
                    <p className='font-semibold'>開発用</p>
                    <Field
                        label='Whisper'
                        value={server.whisper}
                        options={['unloaded', 'loading', 'ready', 'error']}
                        onChange={(whisper) => onChangeServer({ ...server, whisper })}
                    />
                    <Field
                        label='Ollama'
                        value={server.ollama}
                        options={['ready', 'error']}
                        onChange={(ollama) => onChangeServer({ ...server, ollama })}
                    />
                    <Field
                        label='接続'
                        value={server.connection}
                        options={['connected', 'reconnecting']}
                        onChange={(connection) => onChangeServer({ ...server, connection })}
                    />
                    <Field
                        label='マイク'
                        value={server.microphone}
                        options={['granted', 'denied']}
                        onChange={(microphone) => onChangeServer({ ...server, microphone })}
                    />
                    <label className='flex items-center justify-between'>
                        プロジェクトを空にする
                        <Switch checked={noProjects} onCheckedChange={onChangeNoProjects} />
                    </label>
                </div>
            )}
            <button
                className='flex size-9 items-center justify-center rounded-full border bg-background shadow-sm hover:bg-muted'
                onClick={() => setOpen((o) => !o)}
                aria-label='開発用パネル'
            >
                <WrenchIcon className='size-4' />
            </button>
        </div>
    );
}

function Field<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: T[];
    onChange: (value: T) => void;
}) {
    return (
        <div className='flex items-center justify-between gap-2'>
            {label}
            <Select value={value} onValueChange={(v) => onChange(v as T)}>
                <SelectTrigger size='sm' className='w-32'>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectGroup>
                        {options.map((o) => (
                            <SelectItem key={o} value={o}>
                                {o}
                            </SelectItem>
                        ))}
                    </SelectGroup>
                </SelectContent>
            </Select>
        </div>
    );
}
