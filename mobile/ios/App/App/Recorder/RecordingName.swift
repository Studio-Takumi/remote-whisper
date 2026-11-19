import Foundation

/// 録音ファイルの名前（spec/mobile.md 11.3）。`recording-YYYYMMDD-HHMMSS.wav`（端末の時刻、録り始めた時刻）。
/// 同じ秒に 2 つ目ができたら `recording-YYYYMMDD-HHMMSS-2.wav` のように番号を付ける
enum RecordingName {
    static let fileExtension = "wav"

    private static let pattern = try! NSRegularExpression(pattern: #"^recording-\d{8}-\d{6}(-[0-9]{1,4})?\.wav$"#)

    static func make(date: Date, timeZone: TimeZone = .current, index: Int = 1) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let suffix = index > 1 ? "-\(index)" : ""
        return "recording-\(formatter.string(from: date))\(suffix).\(fileExtension)"
    }

    /// JS から渡された名前が、このアプリの録音ファイルの名前か（ほかの場所のファイルを読ませない・消させない）
    static func isValid(_ name: String) -> Bool {
        let range = NSRange(name.startIndex..., in: name)
        return pattern.firstMatch(in: name, range: range) != nil
    }
}
