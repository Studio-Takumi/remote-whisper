@testable import App
import XCTest

final class RecordingActivityStateTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    func testStartedAtCountsBackFromElapsed() {
        let state = RecordingActivityState.make(phase: .recording, elapsed: 754, title: "t", lines: [], now: now)
        XCTAssertEqual(state.startedAt, now.addingTimeInterval(-754))
        XCTAssertEqual(state.elapsed, 754)
        // 録音中は止めない（端末が数える）
        XCTAssertNil(state.pausedAt)
    }

    func testPausedStopsAtElapsed() {
        let state = RecordingActivityState.make(phase: .paused, elapsed: 754, title: "t", lines: [], now: now)
        XCTAssertEqual(state.pausedAt, now)
    }

    func testNegativeElapsedIsZero() {
        let state = RecordingActivityState.make(phase: .recording, elapsed: -3, title: "t", lines: [], now: now)
        XCTAssertEqual(state.elapsed, 0)
        XCTAssertEqual(state.startedAt, now)
    }

    func testDropsEmptyLinesAndKeepsOrder() {
        let state = RecordingActivityState.make(
            phase: .recording, elapsed: 0, title: "t", lines: ["1", "2", "  ", "3", "\n4 "], now: now
        )
        XCTAssertEqual(state.lines, ["1", "2", "3", "4"])
    }

    func testShortLinesAreKeptUpToMaxLines() {
        // 短い区切りが続くときは、3 行ぶん（約 60 文字）が埋まるように多めに持つ
        let lines = (1...30).map { "区切り\($0)。" }
        let state = RecordingActivityState.make(phase: .recording, elapsed: 0, title: "t", lines: lines, now: now)
        XCTAssertEqual(state.lines.count, RecordingActivityState.maxLines)
        XCTAssertEqual(state.lines.last, "区切り30。")
        XCTAssertGreaterThanOrEqual(state.lines.joined().count, 60)
    }

    func testStopsKeepingOlderLinesOnceEnoughCharacters() {
        // 新しいほうから 120 文字に届いたら、それより前は持たない（届いた区切りは全部入れる）
        let a = String(repeating: "あ", count: 70)
        let b = String(repeating: "い", count: 70)
        let c = String(repeating: "う", count: 70)
        let state = RecordingActivityState.make(phase: .recording, elapsed: 0, title: "t", lines: [a, b, c], now: now)
        XCTAssertEqual(state.lines, [b, c])
    }

    func testLongLineKeepsTheEnd() {
        let long = String(repeating: "あ", count: 200) + "おわり"
        let state = RecordingActivityState.make(phase: .recording, elapsed: 0, title: "t", lines: [long], now: now)
        let line = state.lines[0]
        XCTAssertEqual(line.count, RecordingActivityState.maxLineLength)
        XCTAssertTrue(line.hasPrefix("…"))
        XCTAssertTrue(line.hasSuffix("おわり"))
    }

    func testPausedKeepsTheSameLines() {
        let state = RecordingActivityState.make(phase: .paused, elapsed: 0, title: "t", lines: ["1", "2", "3"], now: now)
        XCTAssertEqual(state.lines, ["1", "2", "3"])
    }

    func testJoinsJapaneseWithoutSpaceAndEnglishWithSpace() {
        XCTAssertEqual(TranscriptJoin.joined(["今日は", "晴れです。"]), "今日は晴れです。")
        XCTAssertEqual(TranscriptJoin.joined(["Hello world.", "Next one"]), "Hello world. Next one")
        XCTAssertEqual(TranscriptJoin.joined(["ok", "next"]), "ok next")
        XCTAssertEqual(TranscriptJoin.joined(["バージョン", "2 です"]), "バージョン2 です")
        XCTAssertEqual(TranscriptJoin.joined([]), "")
    }

    func testFitKeepsEverythingThatFits() {
        XCTAssertEqual(TranscriptJoin.fit(["今日は", "晴れです。"], budget: 20), ["今日は", "晴れです。"])
        XCTAssertEqual(TranscriptJoin.fit([], budget: 20), [])
    }

    func testFitCutsOnlyTheHeadWithAnEllipsis() {
        // 新しいほうから入れ、入りきらない区切りは後ろだけ残して頭を「…」にする。新しい区切りは切らない
        let fitted = TranscriptJoin.fit(["あいうえお", "かきくけこ", "さしすせそ"], budget: 9)
        XCTAssertEqual(fitted, ["…くけこ", "さしすせそ"])
        XCTAssertLessThanOrEqual(TranscriptJoin.width(fitted.joined()), 9)
    }

    func testFitCutsInsideASingleLongLine() {
        let fitted = TranscriptJoin.fit([String(repeating: "あ", count: 50) + "おわり"], budget: 10)
        XCTAssertEqual(fitted.count, 1)
        XCTAssertTrue(fitted[0].hasPrefix("…"))
        XCTAssertTrue(fitted[0].hasSuffix("おわり"))
        XCTAssertLessThanOrEqual(TranscriptJoin.width(fitted[0]), 10)
    }

    func testFitCountsAsciiAsNarrow() {
        XCTAssertEqual(TranscriptJoin.fit(["Hello world."], budget: 7), ["Hello world."])
        XCTAssertEqual(TranscriptJoin.fit(["Hello", "world."], budget: 7), ["Hello", " world."])
    }

    func testFitDropsTheSpaceBeforeAnEllipsis() {
        // 切った区切りの頭の空白は要らない。入りきらない区切りが 1 文字も入らなければ、前の区切りの頭に付ける
        XCTAssertEqual(TranscriptJoin.fit(["Hello", "world."], budget: 3).joined(), "…ld.")
        XCTAssertEqual(TranscriptJoin.fit(["Hello", "world."], budget: 4).joined(), "…world.")
    }

    func testFitDropsLeadingPunctuationAfterTheEllipsis() {
        // 「…」の直後が読点・句点にならないように 1 文字削る
        XCTAssertEqual(TranscriptJoin.fit(["あいう、えお"], budget: 4), ["…えお"])
        XCTAssertEqual(TranscriptJoin.fit(["あいう。。えお"], budget: 5).joined(), "…えお")
    }

    func testFitWithOnlyAsciiLetters() {
        let long = String(repeating: "abcdefghij", count: 10)
        let fitted = TranscriptJoin.fit([long], budget: 10)
        XCTAssertEqual(fitted.count, 1)
        XCTAssertTrue(fitted[0].hasPrefix("…"))
        XCTAssertTrue(long.hasSuffix(String(fitted[0].dropFirst())))
        XCTAssertLessThanOrEqual(TranscriptJoin.width(fitted[0]), 10)
    }

    func testFitWhenNothingFitsPutsTheEllipsisOnTheLastLine() {
        // 予算が小さすぎて 1 文字も入らないときは、入った区切りの頭に付ける。空にはしない
        XCTAssertEqual(TranscriptJoin.fit(["あいうえお", "か"], budget: 1.5), ["…か"])
        XCTAssertEqual(TranscriptJoin.fit(["あいうえお"], budget: 0.5), [])
    }

    func testFitHandlesEmptyInput() {
        XCTAssertEqual(TranscriptJoin.fit([], budget: 10), [])
        XCTAssertEqual(TranscriptJoin.fit(["", ""], budget: 10).joined(), "")
    }

    func testFitEstimatesCapitalsAndDigitsWiderThanLowercase() {
        XCTAssertGreaterThan(TranscriptJoin.width("CPU12"), TranscriptJoin.width("cpuab"))
        XCTAssertEqual(TranscriptJoin.width("あい"), 2)
    }

    func testBudgetLeavesRoomForWrapping() {
        // 行数が増えるほど、折り返しのぶんを多めに引く
        XCTAssertEqual(TranscriptJoin.budget(lines: 1, perLine: 18), 17)
        XCTAssertEqual(TranscriptJoin.budget(lines: 3, perLine: 18), 49)
        XCTAssertLessThan(TranscriptJoin.budget(lines: 3, perLine: 18), 3 * 18 - 1)
    }

    func testFitsActivityKitPayloadLimit() throws {
        // ActivityKit の中身は 4KB まで
        // 長い区切りを 10 個、短い区切りを 40 個（持つのは最大 12 区切り・約 120 文字）
        for lines in [Array(repeating: String(repeating: "漢", count: 500), count: 10), Array(repeating: "あ", count: 40)] {
            let state = RecordingActivityState.make(
                phase: .recording, elapsed: 3600, title: String(repeating: "題", count: 40), lines: lines, now: now
            )
            XCTAssertLessThan(try JSONEncoder().encode(state).count, 4096)
        }
    }
}

final class LiveActivityRequestTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    func testParsesStart() throws {
        let request = try LiveActivityRequest.parse(
            ["sessionId": "s1", "state": "paused", "elapsed": NSNumber(value: 12.5), "title": "情報理論", "lines": ["a", 3, "b"]],
            requireSession: true, now: now
        )
        XCTAssertEqual(request.sessionId, "s1")
        XCTAssertEqual(request.state.phase, .paused)
        XCTAssertEqual(request.state.elapsed, 12.5)
        XCTAssertEqual(request.state.title, "情報理論")
        XCTAssertEqual(request.state.lines, ["a", "b"])
    }

    func testStartNeedsSession() {
        XCTAssertThrowsError(try LiveActivityRequest.parse(["state": "recording"], requireSession: true)) {
            XCTAssertEqual($0 as? LiveActivityRequest.ParseError, .missing("sessionId"))
        }
    }

    func testUpdateDoesNotNeedSession() throws {
        let request = try LiveActivityRequest.parse(["state": "recording"], requireSession: false, now: now)
        XCTAssertNil(request.sessionId)
        XCTAssertEqual(request.state.elapsed, 0)
        XCTAssertEqual(request.state.lines, [])
    }

    func testRejectsUnknownState() {
        XCTAssertThrowsError(try LiveActivityRequest.parse(["sessionId": "s", "state": "idle"], requireSession: true)) {
            XCTAssertEqual($0 as? LiveActivityRequest.ParseError, .invalidState("idle"))
        }
        XCTAssertThrowsError(try LiveActivityRequest.parse(["sessionId": "s"], requireSession: true)) {
            XCTAssertEqual($0 as? LiveActivityRequest.ParseError, .missing("state"))
        }
    }
}

final class LiveActivityControllerTests: XCTestCase {
    private final class FakeClient: LiveActivityClient {
        var enabled = true
        var calls: [String] = []
        private var nextId = 0

        func request(sessionId: String, state: RecordingActivityState) throws -> String {
            nextId += 1
            calls.append("request \(sessionId) \(state.phase.rawValue) -> a\(nextId)")
            return "a\(nextId)"
        }

        func update(id: String, state: RecordingActivityState) {
            calls.append("update \(id) \(state.phase.rawValue)")
        }

        func end(id: String) {
            calls.append("end \(id)")
        }

        func endAll() {
            calls.append("endAll")
        }
    }

    private func state(_ phase: RecordingPhase) -> RecordingActivityState {
        .make(phase: phase, elapsed: 1, title: "t", lines: [])
    }

    func testStartUpdateEnd() throws {
        let client = FakeClient()
        let controller = LiveActivityController(client: client)
        XCTAssertEqual(try controller.start(sessionId: "s1", state: state(.recording)), .started)
        XCTAssertEqual(controller.update(state: state(.paused)), .updated)
        XCTAssertEqual(controller.end(), .ended)
        XCTAssertNil(controller.current)
        XCTAssertEqual(client.calls, ["request s1 recording -> a1", "update a1 paused", "endAll"])
    }

    func testUpdateWithoutActivityIsIgnored() {
        let client = FakeClient()
        let controller = LiveActivityController(client: client)
        XCTAssertEqual(controller.update(state: state(.recording)), .ignored)
        XCTAssertEqual(client.calls, [])
    }

    func testEndWithoutActivityStillClearsLeftovers() {
        let client = FakeClient()
        let controller = LiveActivityController(client: client)
        XCTAssertEqual(controller.end(), .ignored)
        XCTAssertEqual(client.calls, ["endAll"])
    }

    func testStartAgainForSameSessionUpdates() throws {
        let client = FakeClient()
        let controller = LiveActivityController(client: client)
        _ = try controller.start(sessionId: "s1", state: state(.recording))
        XCTAssertEqual(try controller.start(sessionId: "s1", state: state(.paused)), .updated)
        XCTAssertEqual(client.calls, ["request s1 recording -> a1", "update a1 paused"])
    }

    func testStartForAnotherSessionReplaces() throws {
        let client = FakeClient()
        let controller = LiveActivityController(client: client)
        _ = try controller.start(sessionId: "s1", state: state(.recording))
        XCTAssertEqual(try controller.start(sessionId: "s2", state: state(.recording)), .started)
        XCTAssertEqual(controller.current?.sessionId, "s2")
        XCTAssertEqual(client.calls, ["request s1 recording -> a1", "end a1", "request s2 recording -> a2"])
    }

    func testDisabledDoesNotRequest() throws {
        let client = FakeClient()
        client.enabled = false
        let controller = LiveActivityController(client: client)
        XCTAssertEqual(try controller.start(sessionId: "s1", state: state(.recording)), .disabled)
        XCTAssertEqual(controller.update(state: state(.recording)), .ignored)
        XCTAssertEqual(client.calls, [])
    }
}

final class LiveActivityReplyTests: XCTestCase {
    private struct RequestError: LocalizedError {
        var errorDescription: String? { "too many activities" }
    }

    func testShownHasNoReason() {
        XCTAssertEqual(LiveActivityReply(outcome: .started).payload as NSDictionary, ["shown": true])
        XCTAssertEqual(LiveActivityReply(outcome: .updated).payload as NSDictionary, ["shown": true])
    }

    func testNotAllowedInSettings() {
        XCTAssertEqual(
            LiveActivityReply(outcome: .disabled).payload as NSDictionary,
            ["shown": false, "reason": "not-allowed"])
    }

    func testIosTooOld() {
        XCTAssertEqual(
            LiveActivityReply.iosTooOld.payload as NSDictionary,
            ["shown": false, "reason": "ios-too-old"])
    }

    func testRequestFailureCarriesMessage() {
        XCTAssertEqual(
            LiveActivityReply(failure: RequestError()).payload as NSDictionary,
            ["shown": false, "reason": "request-failed", "message": "too many activities"])
    }

    func testIgnoredHasNoReason() {
        XCTAssertEqual(LiveActivityReply(outcome: .ignored).payload as NSDictionary, ["shown": false])
    }

    func testControllerThrowsWhenRequestFails() {
        final class Failing: LiveActivityClient {
            var enabled = true
            func request(sessionId: String, state: RecordingActivityState) throws -> String { throw RequestError() }
            func update(id: String, state: RecordingActivityState) {}
            func end(id: String) {}
            func endAll() {}
        }
        let controller = LiveActivityController(client: Failing())
        XCTAssertThrowsError(
            try controller.start(sessionId: "s1", state: .make(phase: .recording, elapsed: 1, title: "t", lines: []))
        ) {
            XCTAssertEqual(LiveActivityReply(failure: $0).reason, .requestFailed)
        }
        XCTAssertNil(controller.current)
    }
}
