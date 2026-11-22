// 録音に使うマイクの選択（#449。spec/ui.md 8 章「録音に使うマイク」）。端末ごとにマイクが違うので、setting.json ではなくブラウザ（localStorage）に覚える。
// 選んでいなければ、今までどおり OS に任せる（getUserMedia に deviceId を渡さない）
import { setNativeMicInput } from '@/features/native/nativePlatform';
import {
    type MicState,
    Microphone,
    MicrophoneError,
    type PcmHandler,
    type Processing,
} from '@/features/recording/audio/microphone';

// 選んだマイク。deviceId はブラウザが変えることがあるので、名前（label）でも探す
export type ChosenMic = { deviceId: string; label: string };

// 一覧のマイク。許可の前は label が空になる
export type MicInput = { deviceId: string; label: string };

const KEY = 'rw.micDevice';

export function loadChosenMic(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ChosenMic | null {
    try {
        const raw = storage?.getItem(KEY);
        if (!raw) {
            return null;
        }
        const value = JSON.parse(raw) as Partial<ChosenMic> | null;
        return typeof value?.deviceId === 'string' && value.deviceId !== '' && typeof value.label === 'string'
            ? { deviceId: value.deviceId, label: value.label }
            : null;
    } catch {
        return null;
    }
}

// null で OS に任せる
export function saveChosenMic(
    mic: ChosenMic | null,
    storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage(),
) {
    try {
        if (mic) {
            storage?.setItem(KEY, JSON.stringify(mic));
        } else {
            storage?.removeItem(KEY);
        }
    } catch {
        // 保存できなくても、録音は OS に任せて続けられる
    }
}

// 録音に使えるマイクの一覧。一覧を取れないブラウザでは null。
// Chrome の「既定」「通信」は OS に任せるのと同じなので出さない
export async function listMicInputs(): Promise<MicInput[] | null> {
    if (!navigator.mediaDevices?.enumerateDevices) {
        return null;
    }
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices
            .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
            .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    } catch {
        return null;
    }
}

// マイクの名前が分かるか（許可のあとか）
export function hasLabels(inputs: MicInput[]) {
    return inputs.some((i) => i.label !== '');
}

// 選んだマイクを一覧から探す。ID が同じもの、なければ名前が同じもの。見つからなければ null。
// 許可の前（名前が分からない）は、あるかどうか分からないので undefined
export function findChosen(chosen: ChosenMic, inputs: MicInput[]): MicInput | null | undefined {
    if (!hasLabels(inputs)) {
        return undefined;
    }
    return (
        inputs.find((i) => i.deviceId === chosen.deviceId) ??
        inputs.find((i) => i.label !== '' && i.label === chosen.label) ??
        null
    );
}

// 選んだマイクで開く。選んだマイクがないときは、OS に任せて開き、onFallback で知らせる。
// 選んだものは覚えたままにする（挿し直せば、次に開くときからそのマイクを使う）。
// iOS アプリの中では、開いたマイクを iOS に伝え、録音の途中でイヤホンをつないでも入力が切り替わらないようにする（#458）
export async function openChosenMicrophone(
    onPcm: PcmHandler,
    processing: Processing,
    onState: (state: MicState) => void,
    onFallback: (chosen: ChosenMic) => void,
): Promise<Microphone> {
    const { mic, label } = await openMicrophone(onPcm, processing, onState, onFallback);
    setNativeMicInput(label);
    return mic;
}

// label は開いたマイクの名前。OS に任せたときは null
async function openMicrophone(
    onPcm: PcmHandler,
    processing: Processing,
    onState: (state: MicState) => void,
    onFallback: (chosen: ChosenMic) => void,
): Promise<{ mic: Microphone; label: string | null }> {
    const chosen = loadChosenMic();
    if (!chosen) {
        return { mic: await Microphone.open(onPcm, processing, onState), label: null };
    }
    const found = findChosen(chosen, (await listMicInputs()) ?? []);
    if (found && found.deviceId !== chosen.deviceId) {
        // ID が変わっていたら覚え直す
        saveChosenMic({ deviceId: found.deviceId, label: chosen.label });
    }
    // 名前が分からない（許可の前）ときは、覚えている ID で試す
    const deviceId = found === undefined ? chosen.deviceId : found?.deviceId;
    if (deviceId) {
        try {
            return { mic: await Microphone.open(onPcm, processing, onState, deviceId), label: chosen.label };
        } catch (e) {
            if (!(e instanceof MicrophoneError && e.reason === 'missing')) {
                throw e;
            }
        }
    }
    console.info(`[Mic] chosen microphone not found: ${chosen.label}`);
    onFallback(chosen);
    return { mic: await Microphone.open(onPcm, processing, onState), label: null };
}

function safeStorage(): Storage | null {
    try {
        return localStorage;
    } catch {
        return null;
    }
}
