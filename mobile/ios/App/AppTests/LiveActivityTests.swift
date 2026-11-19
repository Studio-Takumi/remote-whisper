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

    func testKeepsLastThreeNonEmptyLines() {
        let state = RecordingActivityState.make(
            phase: .recording, elapsed: 0, title: "t", lines: ["1", "2", "  ", "3", "\n4 "], now: now
        )
        XCTAssertEqual(state.lines, ["2", "3", "4"])
        XCTAssertEqual(state.visibleLines, ["2", "3", "4"])
    }

    func testLongLineKeepsTheEnd() {
        let long = String(repeating: "あ", count: 200) + "おわり"
        let state = RecordingActivityState.make(phase: .recording, elapsed: 0, title: "t", lines: [long], now: now)
        let line = state.lines[0]
        XCTAssertEqual(line.count, RecordingActivityState.maxLineLength)
        XCTAssertTrue(line.hasPrefix("…"))
        XCTAssertTrue(line.hasSuffix("おわり"))
    }

    func testPausedShowsOnlyLastLine() {
        let state = RecordingActivityState.make(phase: .paused, elapsed: 0, title: "t", lines: ["1", "2", "3"], now: now)
        XCTAssertEqual(state.lines, ["1", "2", "3"])
        XCTAssertEqual(state.visibleLines, ["3"])
    }

    func testFitsActivityKitPayloadLimit() throws {
        // ActivityKit の中身は 4KB まで
        let lines = Array(repeating: String(repeating: "漢", count: 500), count: 10)
        let state = RecordingActivityState.make(
            phase: .recording, elapsed: 3600, title: String(repeating: "題", count: 40), lines: lines, now: now
        )
        XCTAssertLessThan(try JSONEncoder().encode(state).count, 4096)
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
