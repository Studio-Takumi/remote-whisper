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

    func testPrefersTheInputBeingRecordedWhenNamesAreShared() {
        let first = AudioInput(uid: "USB-1", name: "USB マイク")
        let second = AudioInput(uid: "USB-2", name: "USB マイク")
        // web が deviceId で 2 つめを開き、今それで録っている
        XCTAssertEqual(
            PreferredInputChoice.decide(label: "USB マイク", available: [first, second], current: [second], preferredUID: nil),
            .prefer(uid: second.uid)
        )
        // 録っているのがイヤホンに切り替わったあとは、今の固定のほう
        XCTAssertEqual(
            PreferredInputChoice.decide(label: "USB マイク", available: [first, second, headset], current: [headset], preferredUID: second.uid),
            .prefer(uid: second.uid)
        )
        // どちらでもなければ、先に見つかったほう
        XCTAssertEqual(
            PreferredInputChoice.decide(label: "USB マイク", available: [first, second, headset], current: [headset], preferredUID: nil),
            .prefer(uid: first.uid)
        )
    }

    func testRetryStopsAfterTheLimitUntilReset() {
        var retry = PreferredInputRetry()
        for _ in 0 ..< PreferredInputRetry.limit {
            XCTAssertTrue(retry.allow())
        }
        XCTAssertFalse(retry.allow())
        XCTAssertEqual(retry.attempts, PreferredInputRetry.limit)
        retry.reset()
        XCTAssertTrue(retry.allow())
        XCTAssertEqual(retry.attempts, 1)
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
