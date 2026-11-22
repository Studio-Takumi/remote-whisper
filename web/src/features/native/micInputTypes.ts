// iOS アプリの、録音に使うマイクのプラグイン（MicInput。#458）の、JS 向けの型。正本は spec/mobile.md 11.7
export interface MicInputPlugin {
    // label は選んだマイクの名前（enumerateDevices の label。iOS のポートの名前と同じ）。null は OS に任せる
    setPreferredInput(options: { label: string | null }): Promise<void>;
}
