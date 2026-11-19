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
        var states: [(RecorderState, RecorderReason)] = []
        let stopped = expectation(description: "stopped")
        recorder.onStateChange = { state, reason, _ in
            states.append((state, reason))
            if state == .idle { stopped.fulfill() }
        }

        let started = expectation(description: "started")
        recorder.start { result in
            if case let .failure(error) = result { XCTFail("start: \(error)") }
            started.fulfill()
        }
        wait(for: [started], timeout: 10)
        Thread.sleep(forTimeInterval: 3)

        var info: RecordingInfo?
        recorder.stop { result in
            if case let .success(file) = result { info = file }
        }
        wait(for: [stopped], timeout: 5)

        XCTAssertEqual(states.map(\.0), [.recording, .idle])
        let file = try XCTUnwrap(info)
        XCTAssertGreaterThan(file.durationSec, 2)
        XCTAssertLessThan(file.durationSec, 4)
        let header = try Data(contentsOf: dir.appendingPathComponent(file.name)).prefix(44)
        XCTAssertEqual(WavHeader.declaredDataSize(of: header), file.size - 44)
    }
}
