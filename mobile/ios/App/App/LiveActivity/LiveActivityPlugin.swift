import Capacitor
import Foundation

/// JS から呼ぶ Live Activity のプラグイン（`Capacitor.Plugins.LiveActivity`。#453。API は spec/mobile.md 11.5）。
/// 録音は web/ のまま。このプラグインは録音の状態を Live Activity に出し、ボタンの操作を web/ に伝えるだけ。
/// Live Activity を出す・変える・終えるのは `LiveActivityController` が持つ
@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    /// iOS 16.1 より前は nil（何もしない）
    private var controller: LiveActivityController?
    private var observer: NSObjectProtocol?

    override public func load() {
        if #available(iOS 16.1, *) {
            let controller = LiveActivityController(client: ActivityKitClient())
            // 前にアプリが落とされたときの Live Activity を残さない（録音は web/ と一緒に終わっている）
            _ = controller.end()
            self.controller = controller
            #if DEBUG
            LiveActivityPreview.startIfRequested(controller)
            #endif
        }
        observer = NotificationCenter.default.addObserver(
            forName: RecordingActivityAction.notification, object: nil, queue: .main
        ) { [weak self] note in
            guard let action = note.userInfo?[RecordingActivityAction.userInfoKey] as? String else { return }
            self?.notifyListeners("action", data: ["action": action])
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    /// 出せたら `{ shown: true }`。iOS 16.1 より前・設定で許可されていないときは `{ shown: false }`
    @objc func start(_ call: CAPPluginCall) {
        run(call, requireSession: true) { controller, request in
            try controller.start(sessionId: request.sessionId ?? "", state: request.state)
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        run(call, requireSession: false) { controller, request in
            controller.update(state: request.state)
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            _ = self?.controller?.end()
            call.resolve()
        }
    }

    /// ActivityKit は main で呼ぶ（プラグインのメソッドは別のスレッドで呼ばれる）
    private func run(
        _ call: CAPPluginCall, requireSession: Bool,
        _ body: @escaping (LiveActivityController, LiveActivityRequest) throws -> LiveActivityController.Outcome
    ) {
        let request: LiveActivityRequest
        do {
            request = try LiveActivityRequest.parse(call.options as? [String: Any] ?? [:], requireSession: requireSession)
        } catch {
            return call.reject("引数が正しくありません", "invalid-argument", error)
        }
        DispatchQueue.main.async { [weak self] in
            guard let controller = self?.controller else { return call.resolve(["shown": false]) }
            do {
                let outcome = try body(controller, request)
                call.resolve(["shown": outcome == .started || outcome == .updated])
            } catch {
                call.reject(error.localizedDescription, "unavailable", error)
            }
        }
    }
}
