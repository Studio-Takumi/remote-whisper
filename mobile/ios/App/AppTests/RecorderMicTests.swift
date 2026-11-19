@testable import App
import XCTest

/// 本物のマイクで数秒録る。マイクの許可が要るので、普段は飛ばす。
/// 回すとき: `xcrun simctl privacy <端末> grant microphone dev.studiotakumi.remotewhisper` のあと、
/// `TEST_RUNNER_RW_MIC_TEST=1 xcodebuild test ...`（mobile/README.md）
final class RecorderMicTests: XCTestCase {
    func testRecordsAFewSecondsFromTheMicrophone() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["RW_MIC_TEST"] == "1", "RW_MIC_TEST=1 のときだけ")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = Recorder(store: RecordingStore(directory: dir))
        // onStateChange は Recorder の queue から呼ばれるので、テストのスレッドと分けて持つ
        let states = StateLog()
        let idle = expectation(description: "idle")
        recorder.onStateChange = { state, _, _ in
            states.append(state)
            if state == .idle { idle.fulfill() }
        }

        let started = expectation(description: "started")
        var startError: Error?
        recorder.start { result in
            if case let .failure(error) = result { startError = error }
            started.fulfill()
        }
        wait(for: [started], timeout: 10)
        if let startError { return XCTFail("start: \(startError)") }
        Thread.sleep(forTimeInterval: 3)

        let stopped = expectation(description: "stopped")
        var result: Result<RecordingInfo, Error>?
        recorder.stop {
            result = $0
            stopped.fulfill()
        }
        wait(for: [stopped, idle], timeout: 5)

        XCTAssertEqual(states.all, [.recording, .idle])
        let file: RecordingInfo
        switch result {
        case let .success(info): file = info
        case let .failure(error): return XCTFail("stop: \(error)")
        case .none: return XCTFail("stop が返らない")
        }
        XCTAssertGreaterThan(file.durationSec, 2)
        XCTAssertLessThan(file.durationSec, 4)
        let header = try Data(contentsOf: dir.appendingPathComponent(file.name)).prefix(44)
        XCTAssertEqual(WavHeader.declaredDataSize(of: header), file.size - 44)
    }
}

private final class StateLog {
    private let lock = NSLock()
    private var states: [RecorderState] = []

    func append(_ state: RecorderState) {
        lock.lock()
        defer { lock.unlock() }
        states.append(state)
    }

    var all: [RecorderState] {
        lock.lock()
        defer { lock.unlock() }
        return states
    }
}
