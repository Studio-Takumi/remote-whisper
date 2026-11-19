import Foundation

/// 録音の状態（JS の `state`。spec/mobile.md 11.3）
enum RecorderState: String {
    /// 録っていない
    case idle
    /// 録っている
    case recording
    /// 電話などの割り込みで止まっている。割り込みが終わったら続きを同じファイルに録る
    case interrupted
}

/// 状態が変わった理由（JS の `reason`）
enum RecorderReason: String {
    /// JS から start・stop を呼んだ
    case user
    /// 電話・Siri・ほかのアプリの録音などの割り込みが始まった
    case interruption
    /// 割り込みが終わって、続きを録り始めた
    case resumed
    /// 割り込みが終わったので再開を試みたが、できなかったので止めた（ほかのアプリが音声を使い続けているなど）
    case interruptionEnded
    /// 入力の経路が変わった（イヤホンを抜いた・挿したなど）。録音は続けている
    case routeChange
    /// メディアサービスがリセットされた。録音中なら作り直して続けている
    case mediaServicesReset
    /// 録音を続けられなくなった（入力がない・エンジンが動かないなど）
    case error
}

enum RecorderEvent: Equatable {
    case start
    case stop
    case interruptionBegan
    /// 割り込みが終わった。`shouldResume` の有無にかかわらず再開を試みる（講義の録音では、止まると気づけず失うものが大きい。
    /// 録音を勝手に再開しても音は鳴らない）。`shouldResume` はログにだけ出す
    case interruptionEnded
    /// 割り込みの終わりのあと、再開できなかった
    case resumeFailed
    /// アプリが前面に戻った。割り込みの終わりが届かなかったときの保険で、まだ止まっていれば再開を試みる
    case becameActive
    case routeChanged
    case mediaServicesReset
    case failed
}

/// 状態が変わるときにすること
enum RecorderAction: Equatable {
    /// ファイルを作って、エンジンを動かし始める
    case begin
    /// エンジンを止める（ファイルは開いたまま）
    case pause
    /// エンジンを作り直して、同じファイルの続きに録る
    case restartEngine
    /// エンジンを止めて、ファイルを閉じる
    case finish
    /// 何もしない
    case none
}

struct RecorderTransition: Equatable {
    let to: RecorderState
    let reason: RecorderReason
    let action: RecorderAction
}

/// 状態の移り変わり。AVFoundation に触らないので、テストで全部の組み合わせを確かめる
enum RecorderStateMachine {
    /// 受け付けないイベントなら nil（状態は変えない）
    static func next(_ state: RecorderState, _ event: RecorderEvent) -> RecorderTransition? {
        switch (state, event) {
        case (.idle, .start):
            return RecorderTransition(to: .recording, reason: .user, action: .begin)
        case (.recording, .stop), (.interrupted, .stop):
            return RecorderTransition(to: .idle, reason: .user, action: .finish)
        case (.recording, .interruptionBegan):
            return RecorderTransition(to: .interrupted, reason: .interruption, action: .pause)
        case (.interrupted, .interruptionEnded), (.interrupted, .becameActive):
            // 再開できなかったら、割り込みの終わりのときは resumeFailed で止め、前面に戻ったときは止まったまま待つ（Recorder）
            return RecorderTransition(to: .recording, reason: .resumed, action: .restartEngine)
        case (.interrupted, .resumeFailed):
            return RecorderTransition(to: .idle, reason: .interruptionEnded, action: .finish)
        case (.recording, .routeChanged):
            return RecorderTransition(to: .recording, reason: .routeChange, action: .restartEngine)
        case (.recording, .mediaServicesReset):
            return RecorderTransition(to: .recording, reason: .mediaServicesReset, action: .restartEngine)
        case (.recording, .failed), (.interrupted, .failed):
            return RecorderTransition(to: .idle, reason: .error, action: .finish)
        default:
            // 割り込み中の経路の変化・リセットは、再開するときにエンジンを作り直すので何もしない
            return nil
        }
    }
}
