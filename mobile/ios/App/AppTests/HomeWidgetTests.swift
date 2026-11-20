@testable import App
import XCTest

/// ホーム画面のウィジェット（#454）：共有の置き場の読み書き・タイムラインの作り方・文言
final class HomeWidgetStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        suiteName = "HomeWidgetStoreTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
    }

    func testReadsWhatWasWritten() {
        let store = HomeWidgetStore(defaults: defaults)
        XCTAssertNil(store.read())
        let state = HomeWidgetState(
            recording: .init(
                sessionId: "s1", phase: .paused, startedAt: Date(timeIntervalSince1970: 100), elapsed: 754,
                title: "情報理論 第8回", line: "ここ", updatedAt: Date(timeIntervalSince1970: 900),
                changedAt: Date(timeIntervalSince1970: 800)
            ),
            last: .init(title: "11/19 3限", duration: 5320, endedAt: Date(timeIntervalSince1970: 50))
        )
        store.write(state)
        // 別の HomeWidgetStore（ウィジェット側）からも同じものが読める
        XCTAssertEqual(HomeWidgetStore(defaults: UserDefaults(suiteName: suiteName)!).read(), state)
    }

    func testBrokenDataReadsAsNothing() {
        defaults.set(Data("x".utf8), forKey: HomeWidgetStore.stateKey)
        XCTAssertNil(HomeWidgetStore(defaults: defaults).read())
    }

    func testNoAppGroupInInfoPlistMeansNoStore() {
        // テストのビルドは App Group を使っていない（RW_APP_GROUP が空）
        let group = Bundle.main.object(forInfoDictionaryKey: HomeWidgetStore.infoKey) as? String ?? ""
        if group.isEmpty {
            XCTAssertNil(HomeWidgetStore.shared())
        }
    }
}

final class HomeWidgetWriterTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)
    private var suiteName = ""
    private var store: HomeWidgetStore!
    private var reloads = 0

    override func setUp() {
        suiteName = "HomeWidgetWriterTests-\(UUID().uuidString)"
        store = HomeWidgetStore(defaults: UserDefaults(suiteName: suiteName)!)
        reloads = 0
    }

    override func tearDown() {
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
    }

    private func writer() -> HomeWidgetWriter {
        HomeWidgetWriter(store: store) { [unowned self] in reloads += 1 }
    }

    private func state(_ phase: RecordingPhase = .recording, elapsed: TimeInterval = 60, lines: [String] = ["a", "b"],
                       at time: Date? = nil) -> RecordingActivityState {
        .make(phase: phase, elapsed: elapsed, title: "情報理論", lines: lines, now: time ?? now)
    }

    func testStartWritesRecordingWithLastLine() {
        writer().recording(sessionId: "s1", state: state(), now: now)
        let recording = store.read()?.recording
        XCTAssertEqual(recording?.sessionId, "s1")
        XCTAssertEqual(recording?.line, "b")
        XCTAssertEqual(recording?.startedAt, now.addingTimeInterval(-60))
        XCTAssertEqual(recording?.updatedAt, now)
        XCTAssertEqual(reloads, 1)
    }

    func testUpdateKeepsSessionFromStart() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(), now: now)
        w.recording(sessionId: nil, state: state(lines: ["c"]), now: now)
        XCTAssertEqual(store.read()?.recording?.sessionId, "s1")
        XCTAssertEqual(store.read()?.recording?.line, "c")
    }

    func testLineOnlyChangesAreThrottled() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(), now: now)
        XCTAssertEqual(reloads, 1)
        // 30 秒より前の行の変化は、置き場にだけ書いて作り直さない
        let t10 = now.addingTimeInterval(10)
        w.recording(sessionId: nil, state: state(elapsed: 70, lines: ["c"], at: t10), now: t10)
        XCTAssertEqual(reloads, 1)
        XCTAssertEqual(store.read()?.recording?.line, "c")
        // 30 秒たてば、経過時間だけの update でも、待たせていた行を出す
        let t31 = now.addingTimeInterval(31)
        w.recording(sessionId: nil, state: state(elapsed: 91, lines: ["c"], at: t31), now: t31)
        XCTAssertEqual(reloads, 2)
        // 待たせているものがなければ、経過時間だけでは作り直さない
        let t70 = now.addingTimeInterval(70)
        w.recording(sessionId: nil, state: state(elapsed: 130, lines: ["c"], at: t70), now: t70)
        XCTAssertEqual(reloads, 2)
        // 30 秒たってからの行の変化はすぐ
        w.recording(sessionId: nil, state: state(elapsed: 130, lines: ["d"], at: t70), now: t70)
        XCTAssertEqual(reloads, 3)
    }

    func testStateChangesAndEndReloadRightAway() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(), now: now)
        let t1 = now.addingTimeInterval(1)
        w.recording(sessionId: nil, state: state(lines: ["c"], at: t1), now: t1)
        XCTAssertEqual(reloads, 1)
        // 一時停止は、行を間引いている間でもすぐ
        w.recording(sessionId: nil, state: state(.paused, lines: ["c"], at: t1), now: t1)
        XCTAssertEqual(reloads, 2)
        // セッション名の変化もすぐ
        var renamed = state(.paused, lines: ["c"], at: t1)
        renamed.title = "新しい名前"
        w.recording(sessionId: nil, state: renamed, now: t1)
        XCTAssertEqual(reloads, 3)
        // 終えたら必ずすぐ
        w.ended(now: t1)
        XCTAssertEqual(reloads, 4)
    }

    func testRefreshReloadsWhenStoreExists() {
        let w = writer()
        w.refresh(now: now)
        XCTAssertEqual(reloads, 1)
        let noStore = HomeWidgetWriter(store: nil) { [unowned self] in reloads += 1 }
        noStore.refresh(now: now)
        XCTAssertEqual(reloads, 1)
    }

    func testChangedAtMovesOnlyOnStateChanges() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(), now: now)
        let t60 = now.addingTimeInterval(60)
        w.recording(sessionId: nil, state: state(elapsed: 120, lines: ["c"], at: t60), now: t60)
        // 行・経過時間だけの変化では、8 時間の起点を動かさない
        XCTAssertEqual(store.read()?.recording?.changedAt, now)
        XCTAssertEqual(store.read()?.recording?.updatedAt, t60)
        w.recording(sessionId: nil, state: state(.paused, elapsed: 120, lines: ["c"], at: t60), now: t60)
        XCTAssertEqual(store.read()?.recording?.changedAt, t60)
    }

    func testStartOfAnotherSessionOverwritesWithoutMovingToLast() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(), now: now)
        let t5 = now.addingTimeInterval(5)
        w.recording(sessionId: "s2", state: state(elapsed: 0, lines: [], at: t5), now: t5)
        let saved = store.read()
        XCTAssertEqual(saved?.recording?.sessionId, "s2")
        XCTAssertEqual(saved?.recording?.changedAt, t5)
        // 前のものは前回の録音にしない（終えたときの end で前回の録音になる）
        XCTAssertNil(saved?.last)
        XCTAssertEqual(reloads, 2)
    }

    #if DEBUG
    func testPreviewIsWrittenAfterLaunchCleanup() {
        // アプリが落とされて残った録音中のもの
        writer().recording(sessionId: "s1", state: state(), now: now)
        // プラグインの load() と同じ順：先に片付けて、そのあと見本を書く（見本が片付けで消えない）
        let w = writer()
        w.launched()
        XCTAssertTrue(HomeWidgetPreview.writeIfRequested(w, arguments: ["App", HomeWidgetPreview.argument, "recording"]))
        let saved = store.read()
        XCTAssertEqual(saved?.recording?.sessionId, "preview")
        XCTAssertEqual(saved?.recording?.title, "情報理論 第8回")
        XCTAssertEqual(saved?.last?.endedAt, now)
        XCTAssertFalse(HomeWidgetPreview.writeIfRequested(w, arguments: ["App"]))
    }
    #endif

    func testUpdateWithoutStartDoesNothing() {
        writer().recording(sessionId: nil, state: state(), now: now)
        XCTAssertNil(store.read())
        XCTAssertEqual(reloads, 0)
    }

    func testElapsedOnlyDoesNotReload() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(elapsed: 60), now: now)
        // 10 秒後に、経過時間だけが 10 秒進んだもの（端末が数えているので、見た目は同じ）
        let later = now.addingTimeInterval(10)
        w.recording(sessionId: nil, state: state(elapsed: 70, at: later), now: later)
        XCTAssertEqual(reloads, 1)
        // 置き場の最後に書いた時刻は進める（古くなったかの判断に使う）
        XCTAssertEqual(store.read()?.recording?.updatedAt, later)
    }

    func testPauseReloads() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(), now: now)
        w.recording(sessionId: nil, state: state(.paused), now: now)
        XCTAssertEqual(reloads, 2)
        XCTAssertEqual(store.read()?.recording?.pausedAt, now)
    }

    func testEndMovesRecordingToLast() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(elapsed: 60), now: now)
        w.ended(now: now.addingTimeInterval(30))
        let saved = store.read()
        XCTAssertNil(saved?.recording)
        XCTAssertEqual(saved?.last, .init(title: "情報理論", duration: 90, endedAt: now.addingTimeInterval(30)))
        XCTAssertEqual(reloads, 2)
    }

    func testEndWhilePausedUsesElapsed() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(.paused, elapsed: 60), now: now)
        w.ended(now: now.addingTimeInterval(600))
        XCTAssertEqual(store.read()?.last?.duration, 60)
    }

    func testEndWithoutRecordingKeepsLast() {
        let w = writer()
        w.recording(sessionId: "s1", state: state(elapsed: 60), now: now)
        w.ended(now: now)
        let last = store.read()?.last
        // 読み込み直したときの片付け（録音していない end）では、前回の録音を消さない
        w.ended(now: now.addingTimeInterval(100))
        XCTAssertEqual(store.read()?.last, last)
        XCTAssertEqual(reloads, 2)
    }

    func testLaunchFinishesLeftoverAtLastWrite() {
        writer().recording(sessionId: "s1", state: state(elapsed: 60), now: now)
        // アプリが落とされて、あとで開き直した
        writer().launched()
        let saved = store.read()
        XCTAssertNil(saved?.recording)
        XCTAssertEqual(saved?.last?.duration, 60)
        XCTAssertEqual(saved?.last?.endedAt, now)
    }

    func testNoStoreDoesNothing() {
        let w = HomeWidgetWriter(store: nil) { [unowned self] in reloads += 1 }
        w.recording(sessionId: "s1", state: state(), now: now)
        w.ended(now: now)
        w.launched()
        XCTAssertEqual(reloads, 0)
    }
}

final class HomeWidgetTimelineTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)
    private let last = HomeWidgetState.LastRecording(title: "11/19 3限", duration: 5320, endedAt: Date(timeIntervalSince1970: 0))

    private func recording(updatedAt: Date, changedAt: Date? = nil) -> HomeWidgetState.Recording {
        .init(
            sessionId: "s1", phase: .recording, startedAt: updatedAt.addingTimeInterval(-60), elapsed: 60,
            title: "情報理論", line: "a", updatedAt: updatedAt, changedAt: changedAt ?? updatedAt
        )
    }

    func testNoStoreIsIdleWithoutLast() {
        XCTAssertEqual(HomeWidgetTimeline.content(of: nil, now: now), .idle(last: nil))
        XCTAssertEqual(HomeWidgetTimeline.entries(of: nil, now: now).map(\.content), [.idle(last: nil)])
    }

    func testIdleShowsLast() {
        let state = HomeWidgetState(recording: nil, last: last)
        XCTAssertEqual(HomeWidgetTimeline.content(of: state, now: now), .idle(last: last))
        XCTAssertEqual(HomeWidgetTimeline.entries(of: state, now: now).count, 1)
    }

    func testRecordingIsOneEntryThenIdleWhenStale() {
        let rec = recording(updatedAt: now.addingTimeInterval(-60), changedAt: now.addingTimeInterval(-600))
        let state = HomeWidgetState(recording: rec, last: last)
        let entries = HomeWidgetTimeline.entries(of: state, now: now)
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries[0].date, now)
        XCTAssertEqual(entries[0].content, .recording(rec))
        // 始めた・一時停止・再開してから 8 時間たったら、アプリが落とされたものと見なして待機中にする
        let staleAt = rec.changedAt.addingTimeInterval(HomeWidgetTimeline.staleAfter)
        XCTAssertEqual(entries[1].date, staleAt)
        XCTAssertEqual(entries[1].content, .idle(last: rec.finished(at: rec.updatedAt)))
    }

    func testStaleRecordingIsIdle() {
        let rec = recording(updatedAt: now.addingTimeInterval(-HomeWidgetTimeline.staleAfter - 1))
        let content = HomeWidgetTimeline.content(of: HomeWidgetState(recording: rec, last: last), now: now)
        XCTAssertEqual(content, .idle(last: .init(title: "情報理論", duration: 60, endedAt: rec.updatedAt)))
    }

    func testRecentLineDoesNotKeepOldStateAlive() {
        // 行は最近も書いているが、始めてから 8 時間を過ぎた
        let rec = recording(updatedAt: now.addingTimeInterval(-10), changedAt: now.addingTimeInterval(-HomeWidgetTimeline.staleAfter - 1))
        guard case .idle = HomeWidgetTimeline.content(of: HomeWidgetState(recording: rec, last: nil), now: now) else {
            return XCTFail("8 時間を過ぎたら待機中")
        }
        // 行が変わらなくても（無音が続く）、始めてから 8 時間より前なら録音中のまま
        let quiet = recording(updatedAt: now.addingTimeInterval(-3 * 60 * 60), changedAt: now.addingTimeInterval(-3 * 60 * 60))
        XCTAssertEqual(HomeWidgetTimeline.content(of: HomeWidgetState(recording: quiet, last: nil), now: now), .recording(quiet))
    }
}

final class HomeWidgetTextTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }

    func testLast() {
        let last = HomeWidgetState.LastRecording(title: "11/19 3限", duration: 5320, endedAt: Date())
        XCTAssertEqual(HomeWidgetText.last(last, calendar: calendar), "前回 11/19 3限 · 1:28:40")
    }

    func testLastWithoutTitleUsesDate() {
        // 2026-11-19 12:00（日本時間）
        let ended = Date(timeIntervalSince1970: 1_795_057_200)
        let last = HomeWidgetState.LastRecording(title: " ", duration: 754, endedAt: ended)
        XCTAssertEqual(HomeWidgetText.last(last, calendar: calendar), "前回 11/19 · 12:34")
    }

    func testLastPartsKeepDurationSeparate() {
        let last = HomeWidgetState.LastRecording(title: "リリース計画の打ち合わせ", duration: 754, endedAt: Date())
        let parts = HomeWidgetText.lastParts(last, calendar: calendar)
        XCTAssertEqual(parts.name, "前回 リリース計画の打ち合わせ")
        XCTAssertEqual(parts.duration, " · 12:34")
    }

    func testDuration() {
        XCTAssertEqual(HomeWidgetText.duration(0), "0:00")
        XCTAssertEqual(HomeWidgetText.duration(754.9), "12:34")
        XCTAssertEqual(HomeWidgetText.duration(3600), "1:00:00")
        XCTAssertEqual(HomeWidgetText.duration(-5), "0:00")
    }

    func testQuoted() {
        XCTAssertEqual(HomeWidgetText.quoted("ここ、期末に出しますからね"), "「ここ、期末に出しますからね」")
        XCTAssertNil(HomeWidgetText.quoted("  "))
        // 長いときは後ろ（新しく話したところ）を残す
        let long = String(repeating: "あ", count: 30) + "おわり"
        XCTAssertEqual(HomeWidgetText.quoted(long, maxLength: 6), "「…ああおわり」")
    }
}
