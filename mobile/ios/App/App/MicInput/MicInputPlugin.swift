import Capacitor
import Foundation

/// JS から呼ぶ、録音に使うマイクのプラグイン（`Capacitor.Plugins.MicInput`。#458。API は spec/mobile.md 11.7）。
/// JS との受け渡しだけ。入力を固定するのは `PreferredInput` が持つ
@objc(MicInputPlugin)
public class MicInputPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MicInputPlugin"
    public let jsName = "MicInput"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setPreferredInput", returnType: CAPPluginReturnPromise),
    ]

    private let input = PreferredInput()

    /// `{ label: string | null }`。label は web/ で選んだマイクの名前。null・空は OS に任せる
    @objc func setPreferredInput(_ call: CAPPluginCall) {
        input.choose(call.getString("label"))
        call.resolve()
    }
}
