@testable import App
import XCTest

/// web/ で選んだマイクから、固定する入力を選ぶ（#458）
final class PreferredInputTests: XCTestCase {
    private let builtIn = AudioInput(uid: "Built-In Microphone", name: "iPhone のマイク")
    private let headset = AudioInput(uid: "Wired Microphone", name: "ヘッドセットのマイク")

    func testClearsWhenLeftToTheOS() {
        XCTAssertEqual(
            PreferredInputChoice.decide(label: nil, available: [builtIn, headset], current: [headset], preferredUID: builtIn.uid),
            .clear
        )
        XCTAssertEqual(
            PreferredInputChoice.decide(label: "", available: [builtIn], current: [builtIn], preferredUID: nil),
            .clear
        )
    }

    func testPrefersTheChosenInputWhenAHeadsetTookOver() {
        // 内蔵マイクで録っている途中でイヤホンをつなぎ、iOS がイヤホンのマイクに切り替えた
        XCTAssertEqual(
            PreferredInputChoice.decide(label: builtIn.name, available: [builtIn, headset], current: [headset], preferredUID: nil),
            .prefer(uid: builtIn.uid)
        )
        XCTAssertEqual(
            PreferredInputChoice.decide(label: builtIn.name, available: [builtIn, headset], current: [headset], preferredUID: builtIn.uid),
            .prefer(uid: builtIn.uid)
        )
    }

    func testPrefersEvenWhenAlreadyRecordingFromItButNotPinned() {
        // 今は内蔵で録れていても、固定していなければ、このあとイヤホンをつないだときに切り替わる
        XCTAssertEqual(
            PreferredInputChoice.decide(label: builtIn.name, available: [builtIn], current: [builtIn], preferredUID: nil),
            .prefer(uid: builtIn.uid)
        )
    }

    func testKeepsWhenPinnedAndRecordingFromIt() {
        XCTAssertEqual(
            PreferredInputChoice.decide(label: builtIn.name, available: [builtIn, headset], current: [builtIn], preferredUID: builtIn.uid),
            .keep
        )
    }

    func testWorksForInputsOtherThanTheBuiltInMicrophone() {
        XCTAssertEqual(
            PreferredInputChoice.decide(label: headset.name, available: [builtIn, headset], current: [builtIn], preferredUID: nil),
            .prefer(uid: headset.uid)
        )
    }

    func testMissingWhenTheChosenInputIsNotConnected() {
        XCTAssertEqual(
            PreferredInputChoice.decide(label: headset.name, available: [builtIn], current: [builtIn], preferredUID: nil),
            .missing
        )
        XCTAssertEqual(
            PreferredInputChoice.decide(label: builtIn.name, available: [], current: [], preferredUID: nil),
            .missing
        )
    }
}
