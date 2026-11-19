import AVFoundation
@testable import App
import XCTest

/// マイクの形式（48kHz・2ch の Float32）から、書く形式（16kHz・モノラル・Int16）への変換。
/// マイクのテストを飛ばしても、録音の中心の変換はシミュレーターで確かめる
final class RecorderConvertTests: XCTestCase {
    private let frequency = 440.0
    private let amplitude: Float = 0.5

    func testConvertsA48kStereoSineTo16kMonoWithoutGaps() throws {
        let input = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2))
        let converter = try XCTUnwrap(Recorder.makeConverter(from: input))

        // 4800 フレーム（0.1 秒）ずつ 20 回、続けて渡す（tap から届くのと同じ）
        var samples: [Int16] = []
        var phase = 0
        for _ in 0 ..< 20 {
            let buffer = try sine(format: input, frames: 4800, startFrame: phase)
            phase += 4800
            let data = try XCTUnwrap(Recorder.convert(buffer, with: converter))
            samples += data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        }

        // ① 長さはおよそ 1/3（2 秒 → 32000 フレーム。変換器が最後に持っている分だけ短くてよい）
        XCTAssertGreaterThan(samples.count, 32000 - 200)
        XCTAssertLessThanOrEqual(samples.count, 32000)

        // ② 欠けていない：変換器の遅れが落ち着いたあとの 1 秒で、440Hz の 0 との交差がおよそ 880 回
        let steady = Array(samples[8000 ..< 24000])
        let crossings = zip(steady, steady.dropFirst()).filter { ($0 < 0) != ($1 < 0) }.count
        XCTAssertEqual(Double(crossings), 2 * frequency, accuracy: 2 * frequency * 0.01)

        // ③ 振幅がおよそ保たれる（2ch とも同じ音なので、モノラルにしても 0.5 前後）
        let peak = Double(steady.map { abs(Int($0)) }.max() ?? 0) / Double(Int16.max)
        XCTAssertEqual(peak, Double(amplitude), accuracy: 0.1)
    }

    private func sine(format: AVAudioFormat, frames: Int, startFrame: Int) throws -> AVAudioPCMBuffer {
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)))
        buffer.frameLength = AVAudioFrameCount(frames)
        let channels = try XCTUnwrap(buffer.floatChannelData)
        for i in 0 ..< frames {
            let t = Double(startFrame + i) / format.sampleRate
            let value = amplitude * Float(sin(2 * .pi * frequency * t))
            for ch in 0 ..< Int(format.channelCount) {
                channels[ch][i] = value
            }
        }
        return buffer
    }
}
