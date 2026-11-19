@testable import App
import XCTest

final class RecorderStateMachineTests: XCTestCase {
    private func next(_ state: RecorderState, _ event: RecorderEvent) -> RecorderTransition? {
        RecorderStateMachine.next(state, event)
    }

    private func t(_ to: RecorderState, _ reason: RecorderReason, _ action: RecorderAction) -> RecorderTransition {
        RecorderTransition(to: to, reason: reason, action: action)
    }

    func testStartAndStop() {
        XCTAssertEqual(next(.idle, .start), t(.recording, .user, .begin))
        XCTAssertEqual(next(.recording, .stop), t(.idle, .user, .finish))
        XCTAssertNil(next(.recording, .start))
        XCTAssertNil(next(.idle, .stop))
    }

    func testInterruptionThatResumes() {
        XCTAssertEqual(next(.recording, .interruptionBegan), t(.interrupted, .interruption, .pause))
        XCTAssertEqual(next(.interrupted, .interruptionEnded(shouldResume: true)), t(.recording, .resumed, .restartEngine))
    }

    func testInterruptionThatDoesNotResumeStops() {
        XCTAssertEqual(next(.interrupted, .interruptionEnded(shouldResume: false)), t(.idle, .interruptionEnded, .finish))
    }

    func testStopWhileInterrupted() {
        XCTAssertEqual(next(.interrupted, .stop), t(.idle, .user, .finish))
        XCTAssertNil(next(.interrupted, .start))
    }

    func testRouteChangeAndResetRebuildTheEngineWhileRecording() {
        XCTAssertEqual(next(.recording, .routeChanged), t(.recording, .routeChange, .restartEngine))
        XCTAssertEqual(next(.recording, .mediaServicesReset), t(.recording, .mediaServicesReset, .restartEngine))
        // 割り込み中は、再開するときに作り直すので何もしない
        XCTAssertNil(next(.interrupted, .routeChanged))
        XCTAssertNil(next(.interrupted, .mediaServicesReset))
    }

    func testFailureStops() {
        XCTAssertEqual(next(.recording, .failed), t(.idle, .error, .finish))
        XCTAssertEqual(next(.interrupted, .failed), t(.idle, .error, .finish))
    }

    func testIdleIgnoresSystemEvents() {
        for event: RecorderEvent in [.interruptionBegan, .interruptionEnded(shouldResume: true), .routeChanged, .mediaServicesReset, .failed] {
            XCTAssertNil(next(.idle, event), "\(event)")
        }
    }
}
