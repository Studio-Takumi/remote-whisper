import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// 録音の状態を App Group の共有の置き場に書き、ホーム画面のウィジェットに知らせる（#454。spec/mobile.md 11.6）。
/// LiveActivityPlugin が、web/ から届く Live Activity の start・update・end と一緒に呼ぶ。
/// 置き場がない（App Group を使っていない）ときは何もしない。ウィジェットは待機中の見た目のまま
final class HomeWidgetWriter {
    /// 行だけの変化で作り直す間隔（秒）。作り直せる回数に限りがあり、使い切ると録音を終えたときの作り直しも落ちるため
    static let lineReloadInterval: TimeInterval = 30

    private let store: HomeWidgetStore?
    private let reloadTimelines: () -> Void
    /// 最後に作り直した時刻
    private var reloadedAt: Date?
    /// 行の変化を作り直さずに置き場にだけ書いた
    private var linePending = false

    init(store: HomeWidgetStore?, reload: @escaping () -> Void) {
        self.store = store
        self.reloadTimelines = reload
    }

    /// 本物（Info.plist の App Group の置き場と WidgetCenter）
    static func live() -> HomeWidgetWriter {
        HomeWidgetWriter(store: HomeWidgetStore.shared()) {
            #if canImport(WidgetKit)
            WidgetCenter.shared.reloadTimelines(ofKind: HomeWidgetStore.widgetKind)
            #endif
        }
    }

    /// 録音を始めた・中身が変わった。sessionId は start のときだけ届く（update は前のものを使う）
    /// 前と違うセッションの start が来たら、前のものは前回の録音にせずに上書きする（web/ が録音中のセッションを替えた）
    func recording(sessionId: String?, state: RecordingActivityState, now: Date = Date()) {
        guard let store else { return }
        var current = store.read() ?? HomeWidgetState()
        guard let id = sessionId ?? current.recording?.sessionId else { return }
        let previous = current.recording
        let sameState = previous.map { $0.sessionId == id && $0.phase == state.phase } ?? false
        let next = HomeWidgetState.Recording(
            sessionId: id,
            phase: state.phase,
            startedAt: state.startedAt,
            elapsed: state.elapsed,
            title: state.title,
            lines: state.lines,
            updatedAt: now,
            changedAt: sameState ? previous?.changedAt ?? now : now
        )
        let change = previous.map { Self.change(from: $0, to: next) } ?? .state
        current.recording = next
        store.write(current)
        switch change {
        case .state:
            // 始めた・一時停止・再開・セッション名・経過時間の合わせ直しは、すぐ作り直す
            reload(now: now)
        case .line:
            linePending = true
            reloadPendingLine(now: now)
        case .none:
            // 経過時間だけの変化（端末が数えている）では作り直さない。間引いて待たせていた行があれば、ここで出す
            reloadPendingLine(now: now)
        }
    }

    /// 録音を終えた。録音中のものを前回の録音にして、すぐ作り直す
    func ended(now: Date = Date()) {
        guard let store, var current = store.read(), let recording = current.recording else { return }
        current.recording = nil
        current.last = recording.finished(at: now)
        store.write(current)
        reload(now: now)
    }

    /// アプリを開いたとき。前にアプリが落とされて残った録音中のものを、最後に書いた時刻で終えたことにする
    /// （Web の録音はアプリと一緒に終わっている）
    func launched(now: Date = Date()) {
        guard let store, var current = store.read(), let recording = current.recording else { return }
        current.recording = nil
        current.last = recording.finished(at: recording.updatedAt)
        store.write(current)
        reload(now: now)
    }

    /// アプリが前面に戻ったとき。前面での作り直しは回数に数えられないので、裏で落ちたかもしれない作り直しをここで取り戻す
    func refresh(now: Date = Date()) {
        guard store != nil else { return }
        reload(now: now)
    }

    private func reload(now: Date) {
        reloadedAt = now
        linePending = false
        reloadTimelines()
    }

    private func reloadPendingLine(now: Date) {
        guard linePending else { return }
        if let reloadedAt, now.timeIntervalSince(reloadedAt) < Self.lineReloadInterval { return }
        reload(now: now)
    }

    private enum Change {
        case none
        case line
        case state
    }

    /// ウィジェットの見た目の何が変わったか（経過時間は端末が数えるので、録音中は起点が少しずれても同じと見なす）
    private static func change(from a: HomeWidgetState.Recording, to b: HomeWidgetState.Recording) -> Change {
        guard a.sessionId == b.sessionId, a.phase == b.phase, a.title == b.title else { return .state }
        let sameTime = a.phase == .paused
            ? a.elapsed == b.elapsed
            : abs(a.startedAt.timeIntervalSince(b.startedAt)) < 2
        if !sameTime {
            return .state
        }
        return a.lines == b.lines ? .none : .line
    }
}
