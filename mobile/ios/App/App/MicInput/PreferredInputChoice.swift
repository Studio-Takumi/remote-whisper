import Foundation

/// 入力の装置。`AVAudioSessionPortDescription` から、選ぶのに要るものだけを取り出したもの（テストで作れるように）
struct AudioInput: Equatable {
    let uid: String
    /// `portName`。WKWebView の `enumerateDevices` の label はこれと同じ（WebKit の AVAudioSessionCaptureDevice）
    let name: String
}

/// 経路を見て、何をするか（spec/mobile.md 11.7）
enum PreferredInputAction: Equatable {
    /// OS に任せる（固定を外す）
    case clear
    /// もう選んだ入力で録っていて、固定もしてある
    case keep
    /// この入力に固定する
    case prefer(uid: String)
    /// 選んだ入力がつながっていない。何もせず、つながったら（経路が変わったら）選び直す
    case missing
}

/// web/ で選んだマイク（label）から、固定する入力を選ぶ
enum PreferredInputChoice {
    /// - Parameters:
    ///   - label: web/ で選んだマイクの名前。nil・空は「OS に任せる」
    ///   - available: `availableInputs`
    ///   - current: 今の経路の入力（`currentRoute.inputs`）
    ///   - preferredUID: 今の固定（`preferredInput?.uid`）
    static func decide(label: String?, available: [AudioInput], current: [AudioInput], preferredUID: String?) -> PreferredInputAction {
        guard let label, !label.isEmpty else { return .clear }
        let named = available.filter { $0.name == label }
        // 同じ名前が複数あるときは、今録っているもの、なければ今の固定、なければ先に見つかったもの
        // （web は deviceId で開いているので、録っているものが web で開いたものに近い）
        guard let target = named.first(where: { input in current.contains { $0.uid == input.uid } })
            ?? named.first(where: { $0.uid == preferredUID })
            ?? named.first
        else { return .missing }
        // 録っている入力が合っていても、固定していなければ固定する（このあとイヤホンをつないでも切り替わらないように）
        if preferredUID == target.uid, current.contains(where: { $0.uid == target.uid }) {
            return .keep
        }
        return .prefer(uid: target.uid)
    }
}

/// 続けて固定し直した回数。iOS が固定を受け付けず、経路の変化が続くときに回り続けないよう、上限で止める
struct PreferredInputRetry {
    static let limit = 3
    private(set) var attempts = 0

    /// 固定し直してよいか。よければ 1 回数える
    mutating func allow() -> Bool {
        guard attempts < Self.limit else { return false }
        attempts += 1
        return true
    }

    /// web から伝え直した・装置がつながった／外れた・メディアサービスのリセット・選んだ入力で録れた（`.keep`）ときに数え直す
    mutating func reset() {
        attempts = 0
    }
}
