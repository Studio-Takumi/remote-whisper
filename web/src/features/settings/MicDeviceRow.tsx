import { useEffect, useState } from 'react';

import { toast } from 'sonner';

import { useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
    type ChosenMic,
    type MicInput,
    findChosen,
    hasLabels,
    listMicInputs,
    loadChosenMic,
    saveChosenMic,
} from '@/features/recording/audio/micDevice';
import { Row } from '@/features/settings/SettingsParts';

// 「OS に任せる」の値（deviceId には出てこない文字）
const OS = 'os';

// 設定の「録音」の「この端末」にある、録音に使うマイク（#449。spec/ui.md 8 章）。
// 端末ごと（localStorage）で、全体設定の保存とは別に、選んだ時点で効く。録音中なら、録音を続けたまま選んだマイクに切り替える
export function MicDeviceRow() {
    const switchMicrophone = useAppStore((s) => s.switchMicrophone);
    const [chosen, setChosen] = useState<ChosenMic | null>(loadChosenMic);
    // undefined は読み込み中、null は一覧を取れないブラウザ
    const [inputs, setInputs] = useState<MicInput[] | null | undefined>(undefined);
    const [asking, setAsking] = useState(false);

    // 抜き挿ししたら一覧を取り直す
    useEffect(() => {
        let alive = true;
        const refresh = () => {
            void listMicInputs().then((list) => {
                if (alive) {
                    setInputs(list);
                }
            });
        };
        refresh();
        const devices = navigator.mediaDevices;
        devices?.addEventListener?.('devicechange', refresh);
        return () => {
            alive = false;
            devices?.removeEventListener?.('devicechange', refresh);
        };
    }, []);

    // 許可の前はマイクの名前が空なので、許可を求めてから一覧を取り直す（開いたマイクはすぐ閉じる）
    async function allow() {
        setAsking(true);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => t.stop());
            setInputs(await listMicInputs());
        } catch {
            toast.error('マイクが使えません。ブラウザの設定でマイクを許可してください');
        } finally {
            setAsking(false);
        }
    }

    const listed = (inputs ?? []).filter((i) => i.label !== '');
    const found = chosen ? findChosen(chosen, inputs ?? []) : undefined;
    const value = chosen ? (found?.deviceId ?? chosen.deviceId) : OS;
    const labelled = inputs ? hasLabels(inputs) : false;
    const label = (deviceId: string) => {
        if (deviceId === OS) {
            return 'OS に任せる';
        }
        const input = listed.find((i) => i.deviceId === deviceId);
        if (input) {
            return input.label;
        }
        // 選んだマイクが一覧にない（抜いた・許可の前で名前が分からない）
        return found === null ? `${chosen?.label}（見つかりません）` : (chosen?.label ?? '');
    };
    const options = [OS, ...listed.map((i) => i.deviceId)];
    if (chosen && !found) {
        options.push(chosen.deviceId);
    }

    function change(next: string) {
        if (next === value) {
            return;
        }
        const mic = next === OS ? null : { deviceId: next, label: label(next) };
        saveChosenMic(mic);
        setChosen(mic);
        void switchMicrophone();
    }

    let description: React.ReactNode;
    if (inputs === null) {
        description = 'このブラウザでは選べません';
    } else if (inputs && !labelled) {
        description = (
            <span className='flex flex-wrap items-center gap-2'>
                マイクを許可すると選べます
                <Button size='sm' variant='outline' disabled={asking} onClick={() => void allow()}>
                    許可する
                </Button>
            </span>
        );
    } else if (found === null) {
        description = 'つながるまで OS の既定のマイクで録音します';
    }

    return (
        <Row id='mic-device' label='録音に使うマイク' description={description}>
            <Select value={value} onValueChange={change} disabled={inputs === null}>
                {/* マイクの名前は長いことがあるので、収まらない分は「…」にし、全体を title で見られるように */}
                <SelectTrigger id='mic-device' className='w-64' title={label(value)}>
                    <SelectValue>
                        <span className='min-w-0 truncate'>{label(value)}</span>
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    <SelectGroup>
                        {options.map((o) => (
                            <SelectItem key={o} value={o}>
                                {label(o)}
                            </SelectItem>
                        ))}
                    </SelectGroup>
                </SelectContent>
            </Select>
        </Row>
    );
}
