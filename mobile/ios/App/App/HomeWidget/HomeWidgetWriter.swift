import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// 録音の状態を App Group の共有の置き場に書き、ホーム画面のウィジェットに知らせる（#454。spec/mobile.md 11.6）。
/// LiveActivityPlugin が、web/ から届く Live Activity の start・update・end と一緒に呼ぶ。
/// 置き場がない（App Group を使っていない）ときは何もしない。ウィジェットは待機中の見た目のまま
final class HomeWidgetWriter {
    private let store: HomeWidgetStore?
    private let reload: () -> Void

    init(store: HomeWidgetStore?, reload: @escaping () -> Void) {
        self.store = store
        self.reload = reload
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
    func recording(sessionId: String?, state: RecordingActivityState, now: Date = Date()) {
        guard let store else { return }
        var current = store.read() ?? HomeWidgetState()
        guard let id = sessionId ?? current.recording?.sessionId else { return }
        let next = HomeWidgetState.Recording(
            sessionId: id,
            phase: state.phase,
            startedAt: state.startedAt,
            elapsed: state.elapsed,
            title: state.title,
            line: state.lines.last ?? "",
            updatedAt: now
        )
        let changed = current.recording.map { !Self.looksSame($0, next) } ?? true
        current.recording = next
        store.write(current)
        // 経過時間だけの変化（端末が数えている）では、ウィジェットを作り直さない（作り直せる回数に限りがあるため）
        if changed {
            reload()
        }
    }

    /// 録音を終えた。録音中のものを前回の録音にする
    func ended(now: Date = Date()) {
        guard let store, var current = store.read(), let recording = current.recording else { return }
        current.recording = nil
        current.last = recording.finished(at: now)
        store.write(current)
        reload()
    }

    /// アプリを開いたとき。前にアプリが落とされて残った録音中のものを、最後に書いた時刻で終えたことにする
    /// （Web の録音はアプリと一緒に終わっている）
    func launched() {
        guard let store, var current = store.read(), let recording = current.recording else { return }
        current.recording = nil
        current.last = recording.finished(at: recording.updatedAt)
        store.write(current)
        reload()
    }

    /// ウィジェットの見た目が同じか（経過時間は端末が数えるので、録音中は起点が少しずれても同じと見なす）
    private static func looksSame(_ a: HomeWidgetState.Recording, _ b: HomeWidgetState.Recording) -> Bool {
        guard a.sessionId == b.sessionId, a.phase == b.phase, a.title == b.title, a.line == b.line else { return false }
        if a.phase == .paused {
            return a.elapsed == b.elapsed
        }
        return abs(a.startedAt.timeIntervalSince(b.startedAt)) < 2
    }
}
