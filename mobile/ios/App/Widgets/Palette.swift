import SwiftUI

/// デザインの色（ライト・ダーク）。赤・琥珀・青は本体のマイクボタン（bg-red-500・bg-amber-500・bg-blue-500）と同じ
enum Palette {
    static let red = Color(hex: 0xEF4444)
    static let amber = Color(hex: 0xF59E0B)
    static let blue = Color(hex: 0x3B82F6)
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
