@testable import App
import XCTest

final class RecordingNameTests: XCTestCase {
    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    // 2026-11-19 23:18:05 (JST)
    private let date = Date(timeIntervalSince1970: 1_795_097_885)

    func testNameUsesLocalTime() {
        XCTAssertEqual(RecordingName.make(date: date, timeZone: tokyo), "recording-20261119-231805.wav")
    }

    func testSecondFileInTheSameSecondGetsANumber() {
        XCTAssertEqual(RecordingName.make(date: date, timeZone: tokyo, index: 2), "recording-20261119-231805-2.wav")
    }

    func testValidNames() {
        XCTAssertTrue(RecordingName.isValid("recording-20261119-231805.wav"))
        XCTAssertTrue(RecordingName.isValid("recording-20261119-231805-12.wav"))
    }

    func testRejectsOtherFilesAndPaths() {
        for name in [
            "../recording-20261119-231805.wav",
            "recording-20261119-231805.wav/../../secret",
            "recording-20261119-231805.m4a",
            "recording-2026119-231805.wav",
            "notes.txt",
            "",
        ] {
            XCTAssertFalse(RecordingName.isValid(name), name)
        }
    }
}
