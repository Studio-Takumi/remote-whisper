import Capacitor
import Foundation

/// ウィジェット・App Intents からアプリを開いたときに、web/ にしてほしいことを伝えるプラグイン
/// （`Capacitor.Plugins.AppEntry`。#454。API は spec/mobile.md 11.6）。録音を始めるのは web/ のいつもの処理
@objc(AppEntryPlugin)
public class AppEntryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppEntryPlugin"
    public let jsName = "AppEntry"
    public let pluginMethods: [CAPPluginMethod] = []

    override public func load() {
        DispatchQueue.main.async { [weak self] in
            AppEntryInbox.shared.receive { request in
                guard let event = request.event else { return }
                // 画面を読み込む前に届いたものは、web/ が聞き始めたときに渡す
                self?.notifyListeners("entry", data: event, retainUntilConsumed: true)
            }
        }
    }
}
