#if DEBUG
import Foundation

/// 見た目を確かめるための Live Activity（Debug のビルドだけ。#453）。
/// シミュレーターはマイクの入力がなく録音を始められないので、起動の引数で見本を出す。
///   xcrun simctl launch booted <Bundle ID> -RWLiveActivityPreview recording   （または paused）
/// 続けて long（長い区切りが続く）・short（短い区切りが続く）・english（英数字が多い）を書くと、文字起こしの見本を替える（#460）
@available(iOS 16.1, *)
enum LiveActivityPreview {
    static let argument = "-RWLiveActivityPreview"

    static func startIfRequested(_ controller: LiveActivityController, arguments: [String] = ProcessInfo.processInfo.arguments) {
        guard let index = arguments.firstIndex(of: argument), index + 1 < arguments.count,
              let phase = RecordingPhase(rawValue: arguments[index + 1])
        else { return }
        let state = RecordingActivityState.make(
            phase: phase,
            elapsed: 12 * 60 + 34,
            title: "情報理論 第8回",
            lines: PreviewTranscript.lines(named: index + 2 < arguments.count ? arguments[index + 2] : nil)
        )
        _ = try? controller.start(sessionId: "preview", state: state)
    }
}

/// 見本の文字起こし（Live Activity とホーム画面のウィジェットで同じものを使う）
enum PreviewTranscript {
    static func lines(named name: String?) -> [String] {
        switch name {
        case "long":
            // 1 つの区切りが 2 行以上ある
            return [
                "えーとですね、前回の講義で説明したエントロピーの定義をもう一度確認しておきたいのですが、確率変数の取りうる値それぞれについて",
                "その値が出る確率の対数をとって符号を反転させたものを平均すると、これが情報量の期待値、つまりエントロピーになるわけです。",
                "ですから、すべての値が同じ確率で出るときにエントロピーは最大になって、逆に結果が必ず決まっているときはゼロになります。",
            ]
        case "short":
            // 1 つの区切りが短い
            return ["はい。", "では次。", "ここ大事です。", "覚えてください。", "期末に出します。", "いいですか。", "では続けます。"]
        case "english":
            // 英語・数字・大文字が多い（折り返しが英単語の途中を避ける）
            return [
                "OK so on slide 12 we compare the CPU and GPU versions of the algorithm,",
                "and the throughput goes from 3.2 GB/s up to 18.4 GB/s on the A100",
                "which is a 5.7x speedup over the baseline running on 64 cores.",
            ]
        default:
            return [
                "じゃあスライドの 12 枚目に戻って、",
                "この式で対数の底を 2 にすると、",
                "単位がビットになるのがわかりますね。",
            ]
        }
    }
}
#endif
