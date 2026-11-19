import SwiftUI
import WidgetKit

/// 録音の Live Activity とダイナミックアイランド（#453。spec/mobile.md 11.5。デザインは匠の Pencil の採用案）
@available(iOS 16.1, *)
struct RecordingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            LockScreenView(state: context.state)
                .activityBackgroundTint(Palette.surface)
                .activitySystemActionForegroundColor(Palette.text)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    StatusLabel(state: state, size: 15, textColor: .white)
                        .padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(state.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(Palette.islandSub)
                        .lineLimit(1)
                        .padding(.trailing, 6)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    IslandExpandedView(state: state)
                }
            } compactLeading: {
                if state.phase == .paused {
                    PauseMark(size: 13)
                } else {
                    Wave(heights: [5, 10, 14, 8, 12])
                }
            } compactTrailing: {
                ElapsedText(state: state, showsHours: false)
                    .font(.system(size: 14, weight: .bold, design: .monospaced))
                    .foregroundColor(state.phase == .paused ? Palette.amber : .white)
                    .frame(maxWidth: 52, alignment: .trailing)
            } minimal: {
                if state.phase == .paused {
                    PauseMark(size: 12)
                } else {
                    Wave(heights: [6, 12, 8])
                }
            }
            .keylineTint(state.phase == .paused ? Palette.amber : Palette.red)
        }
    }
}

// MARK: - ロック画面

@available(iOS 16.1, *)
private struct LockScreenView: View {
    let state: RecordingActivityState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                StatusLabel(state: state, size: 14, textColor: Palette.text)
                Spacer(minLength: 8)
                Text(state.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(Palette.sub)
                    .lineLimit(1)
            }
            TranscriptLines(lines: state.visibleLines, paused: state.phase == .paused, island: false)
            ActionButtons(phase: state.phase, island: false)
        }
        .padding(16)
    }
}

// MARK: - ダイナミックアイランド（expanded）

@available(iOS 16.1, *)
private struct IslandExpandedView: View {
    let state: RecordingActivityState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // 録音中は 2 行（ロック画面より狭い）、一時停止中は最後の 1 行
            TranscriptLines(lines: Array(state.visibleLines.suffix(2)), paused: state.phase == .paused, island: true)
            ActionButtons(phase: state.phase, island: true)
        }
        .padding(.horizontal, 6)
        .padding(.top, 4)
    }
}

// MARK: - 部品

/// 左上の印と経過時間。録音中は赤い点、一時停止中は琥珀の一時停止の印（経過時間も琥珀）
@available(iOS 16.1, *)
private struct StatusLabel: View {
    let state: RecordingActivityState
    let size: CGFloat
    let textColor: Color

    var body: some View {
        HStack(spacing: 6) {
            if state.phase == .paused {
                PauseMark(size: 13)
            } else {
                Circle().fill(Palette.red).frame(width: 8, height: 8)
            }
            ElapsedText(state: state, showsHours: true)
                .font(.system(size: size, weight: .bold, design: .monospaced))
                .foregroundColor(state.phase == .paused ? Palette.amber : textColor)
        }
    }
}

/// 経過時間。録音中は端末が数え、一時停止中は止めた時間で止まる
@available(iOS 16.1, *)
private struct ElapsedText: View {
    let state: RecordingActivityState
    let showsHours: Bool

    var body: some View {
        Text(
            timerInterval: state.startedAt...Date.distantFuture,
            pauseTime: state.pausedAt,
            countsDown: false,
            showsHours: showsHours
        )
        .monospacedDigit()
        .multilineTextAlignment(.leading)
    }
}

/// 直近の文字起こし。古い行ほど薄く小さく、最後の行は太字。一時停止中は最後の行も薄くする
private struct TranscriptLines: View {
    let lines: [String]
    let paused: Bool
    let island: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                let age = lines.count - 1 - index
                Text(line)
                    .font(.system(size: Self.size(age), weight: age == 0 ? .bold : .medium))
                    .foregroundColor(color(age))
                    .lineLimit(age == 0 ? 2 : 1)
                    .truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private static func size(_ age: Int) -> CGFloat {
        switch age {
        case 0: 16
        case 1: 14
        default: 13
        }
    }

    private func color(_ age: Int) -> Color {
        if island {
            return age == 0 && !paused ? .white : .white.opacity(0.45)
        }
        switch age {
        case 0: return paused ? Palette.faint1 : Palette.text
        case 1: return Palette.faint1
        default: return Palette.faint2
        }
    }
}

/// 一時停止・再開（左）と終了（右）。ボタンは iOS 17 から（LiveActivityIntent）
private struct ActionButtons: View {
    let phase: RecordingPhase
    let island: Bool

    var body: some View {
        if #available(iOS 17.0, *) {
            HStack(spacing: 8) {
                if phase == .paused {
                    Button(intent: ResumeRecordingIntent()) {
                        ButtonFace(icon: "play.fill", label: "再開", fill: Palette.amber, foreground: .white)
                    }
                } else {
                    Button(intent: PauseRecordingIntent()) {
                        ButtonFace(icon: "pause.fill", label: "一時停止", fill: Palette.red, foreground: .white)
                    }
                }
                Button(intent: StopRecordingIntent()) {
                    ButtonFace(
                        icon: "stop.fill", label: "終了",
                        fill: island ? Palette.islandStop : Palette.stopBackground,
                        foreground: island ? .white : Palette.text
                    )
                }
            }
            .buttonStyle(.plain)
        }
    }
}

private struct ButtonFace: View {
    let icon: String
    let label: String
    let fill: Color
    let foreground: Color

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 12, weight: .bold))
            Text(label).font(.system(size: 13, weight: .bold))
        }
        .foregroundColor(foreground)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 9)
        .padding(.horizontal, 14)
        .background(Capsule().fill(fill))
    }
}

private struct PauseMark: View {
    let size: CGFloat

    var body: some View {
        Image(systemName: "pause.fill")
            .font(.system(size: size, weight: .bold))
            .foregroundColor(Palette.amber)
    }
}

/// ダイナミックアイランドの波形の印（赤）
private struct Wave: View {
    let heights: [CGFloat]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array(heights.enumerated()), id: \.offset) { _, height in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Palette.red)
                    .frame(width: 3, height: height)
            }
        }
    }
}

/// デザインの色（ライト・ダーク）。赤・琥珀は本体のマイクボタン（bg-red-500・bg-amber-500）と同じ
enum Palette {
    static let red = Color(hex: 0xEF4444)
    static let amber = Color(hex: 0xF59E0B)
    static let surface = Color.dynamic(light: 0xFFFFFF, dark: 0x1C1C1E)
    static let text = Color.dynamic(light: 0x111111, dark: 0xF5F5F5)
    static let sub = Color.dynamic(light: 0x8E8E93, dark: 0x98989F)
    static let faint1 = Color.dynamic(light: 0x111111, dark: 0xFFFFFF, alpha: 0.55)
    static let faint2 = Color.dynamic(light: 0x111111, dark: 0xFFFFFF, alpha: 0.30)
    static let stopBackground = Color.dynamic(light: 0xEDEDEF, dark: 0x3A3A3C)
    // ダイナミックアイランドはテーマによらず黒
    static let islandSub = Color(hex: 0x98989F)
    static let islandStop = Color(hex: 0x3A3A3C)
}

private extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(uiColor: UIColor(hex: hex, alpha: alpha))
    }

    static func dynamic(light: UInt32, dark: UInt32, alpha: Double = 1) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light, alpha: alpha)
        })
    }
}

private extension UIColor {
    convenience init(hex: UInt32, alpha: Double) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}
