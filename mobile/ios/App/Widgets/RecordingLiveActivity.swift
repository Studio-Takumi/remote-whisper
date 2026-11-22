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
                // 1 時間を超えたら 1:12:34（時間を出さないと 72:34 になる）
                ElapsedText(state: state)
                    .font(.system(size: 14, weight: .bold, design: .monospaced))
                    .foregroundColor(state.phase == .paused ? Palette.amber : .white)
                    .frame(maxWidth: 68, alignment: .trailing)
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
            TranscriptLines(lines: state.lines, paused: state.phase == .paused, island: false, lineLimit: 3)
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
            // 録音中は 2 行（ロック画面より狭い）、一時停止中は 1 行
            TranscriptLines(lines: state.lines, paused: state.phase == .paused, island: true, lineLimit: 2)
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
            ElapsedText(state: state)
                .font(.system(size: size, weight: .bold, design: .monospaced))
                .foregroundColor(state.phase == .paused ? Palette.amber : textColor)
        }
    }
}

/// 経過時間。録音中は端末が数え、一時停止中は止めた時間で止まる
@available(iOS 16.1, *)
private struct ElapsedText: View {
    let state: RecordingActivityState

    var body: some View {
        Text(
            timerInterval: state.startedAt...Date.distantFuture,
            pauseTime: state.pausedAt,
            countsDown: false,
            showsHours: true
        )
        .monospacedDigit()
        .multilineTextAlignment(.leading)
    }
}

/// 直近の文字起こし。区切りをつなげて折り返し、あふれたぶんは頭を「…」にする。
/// いちばん新しい区切りだけ濃く（白）、それより前は灰色。一時停止中は 1 行で、全体を薄くする
private struct TranscriptLines: View {
    let lines: [String]
    let paused: Bool
    let island: Bool
    /// ロック画面は 3 行、ダイナミックアイランド（expanded）は 2 行、一時停止中は 1 行
    let lineLimit: Int

    var body: some View {
        TranscriptText(
            lines: lines,
            lineLimit: paused ? 1 : lineLimit,
            perLine: 18,
            size: 16,
            weight: .semibold,
            newest: newest,
            older: older,
            lineSpacing: 2
        )
    }

    private var newest: Color {
        if island {
            return paused ? .white.opacity(0.45) : .white
        }
        return paused ? Palette.faint1 : Palette.text
    }

    private var older: Color {
        island ? .white.opacity(0.45) : Palette.faint1
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
