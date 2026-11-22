// 画面をアプリに同梱したとき（#440。spec/mobile.md 11.8）の接続先の画面。接続先がまだ決まっていないときだけ
// App が出す（ブラウザ版とアプリの server.url では出ない）。保存したら読み込み直して、その接続先で始める。
// 部品は最初のチャンクに入れる（lazy にすると、ブラウザ版の最初に読むファイルが増えるため。11.4 節）
import { type FormEvent, useState } from 'react';

import { bundled, endpoint, modeOfUrl } from '@/api/endpoint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { normalizeEndpointUrl, saveAppEndpoint } from '@/features/native/appEndpoint';

const reload = () => location.reload();

export function AppEndpointSetup({ onSaved = reload }: { onSaved?: () => void }) {
    const [value, setValue] = useState('');
    const [error, setError] = useState<string | null>(null);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        const url = normalizeEndpointUrl(value);
        if (!url) {
            setError('ホストの URL（例: https://pc.example.ts.net）を入れてください。パスは付けません');
            return;
        }
        if (!saveAppEndpoint({ url, mode: modeOfUrl(url) })) {
            setError('保存できませんでした');
            return;
        }
        onSaved();
    };

    return (
        <main className='mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 p-6' data-app-endpoint>
            <p className='text-xs text-muted-foreground'>Remote Whisper</p>
            <h1 className='text-xl font-semibold'>接続先</h1>
            <p className='text-sm'>
                文字起こしをするホストの URL を入れてください。この端末に保存し、次からはそのまま開きます。
            </p>
            <form className='flex flex-col gap-3' onSubmit={submit} noValidate>
                <Label htmlFor='app-endpoint-url'>ホストの URL</Label>
                <Input
                    id='app-endpoint-url'
                    type='url'
                    inputMode='url'
                    autoCapitalize='off'
                    autoCorrect='off'
                    spellCheck={false}
                    placeholder='https://pc.example.ts.net'
                    value={value}
                    aria-invalid={error !== null}
                    onChange={(e) => {
                        setValue(e.target.value);
                        setError(null);
                    }}
                />
                {error && (
                    <p className='text-xs text-destructive' role='alert'>
                        {error}
                    </p>
                )}
                <Button type='submit' className='self-start'>
                    つなぐ
                </Button>
            </form>
        </main>
    );
}

// 設定のモーダルの左下に出す、今の接続先と「変える」。同梱したときだけ（ブラウザ版では何も出さない）
export function AppEndpointInfo({ onCleared = reload }: { onCleared?: () => void }) {
    if (!bundled || !endpoint.base) {
        return null;
    }
    return (
        <p className='text-xs text-muted-foreground'>
            接続先 <span className='font-mono'>{endpoint.base}</span>
            <button
                className='ml-1 underline underline-offset-2'
                onClick={() => {
                    saveAppEndpoint(null);
                    onCleared();
                }}
            >
                変える
            </button>
        </p>
    );
}
