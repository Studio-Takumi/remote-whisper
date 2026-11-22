import AVFoundation
import Foundation

/// web/ で選んだマイクに、iOS の入力を固定する（#458。spec/mobile.md 11.7）。
/// 録音は web/（WKWebView の getUserMedia）のまま。WebKit は getUserMedia で選んだ入力を `setPreferredInput` するが、
/// 経路が変わったとき（イヤホンをつないだなど）には選び直さないので、iOS が新しい入力に切り替えてしまう。
/// ここで `routeChangeNotification` を見て、選んだ入力に固定し直す。
/// カテゴリ・モードは変えない（WebKit が録音のときに PlayAndRecord にする。変えると WebKit の録音とぶつかる）。
/// 状態はすべて `queue` の上で変える。何をしたかは `[MicInput]` を付けて NSLog に出す（mobile/README.md）
final class PreferredInput {
    private let session = AVAudioSession.sharedInstance()
    private let queue = DispatchQueue(label: "dev.studiotakumi.remotewhisper.micinput")
    /// 選んだマイクの名前。nil は OS に任せる
    private var label: String?
    /// 続けて固定し直した回数。iOS が固定を受け付けず、経路の変化が続くときに止めるため
    private var attempts = 0
    private static let maxAttempts = 3
    private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] note in
                let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                let reason = raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
                self?.queue.async { self?.routeChanged(reason) }
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
                self?.queue.async {
                    self?.attempts = 0
                    self?.apply("メディアサービスのリセット")
                }
            },
        ]
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    /// web/ でマイクを開いたときに呼ぶ。nil・空は OS に任せる
    func choose(_ label: String?) {
        queue.async {
            self.label = label?.isEmpty == false ? label : nil
            self.attempts = 0
            self.apply("選択")
        }
    }

    private func routeChanged(_ reason: AVAudioSession.RouteChangeReason?) {
        guard label != nil else { return }
        // 装置がつながった・外れたときは、新しい経路なので数え直す
        if reason == .newDeviceAvailable || reason == .oldDeviceUnavailable {
            attempts = 0
        }
        apply("経路の変化（\(reason.map { String($0.rawValue) } ?? "不明")）")
    }

    private func apply(_ trigger: String) {
        let available = session.availableInputs ?? []
        let action = PreferredInputChoice.decide(
            label: label,
            available: available.map(AudioInput.init),
            current: session.currentRoute.inputs.map(AudioInput.init),
            preferredUID: session.preferredInput?.uid
        )
        switch action {
        case .keep:
            attempts = 0
        case .missing:
            NSLog("[MicInput] 選んだマイクがつながっていません（\(trigger)。選んだもの: \(label ?? "")、つながっているもの: \(available.map(\.portName))）")
        case .clear:
            guard session.preferredInput != nil else { return }
            set(nil, trigger)
        case let .prefer(uid):
            guard attempts < Self.maxAttempts else {
                NSLog("[MicInput] 固定し直すのをやめました（\(trigger)。\(Self.maxAttempts) 回続けて切り替わったため）")
                return
            }
            attempts += 1
            set(available.first { $0.uid == uid }, trigger)
        }
    }

    private func set(_ port: AVAudioSessionPortDescription?, _ trigger: String) {
        do {
            try session.setPreferredInput(port)
            NSLog("[MicInput] 入力を\(port.map { "\($0.portName) に固定" } ?? "OS に任せるように")しました（\(trigger)。今の入力: \(session.currentRoute.inputs.map(\.portName))）")
        } catch {
            NSLog("[MicInput] 入力を固定できませんでした（\(trigger)）: \(error)")
        }
    }
}

extension AudioInput {
    init(_ port: AVAudioSessionPortDescription) {
        self.init(uid: port.uid, name: port.portName)
    }
}
