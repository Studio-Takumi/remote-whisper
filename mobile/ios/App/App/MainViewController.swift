import Capacitor
import UIKit

/// アプリの画面。Capacitor の画面に、アプリの中だけのプラグインを登録する（npm のパッケージにしないもの）。
/// 継承はこの 1 段だけにして、Live Activity は LiveActivityPlugin に持たせる。
/// 録音は web/ のいつもの Web の録音（getUserMedia）で行い、Swift では録らない。
/// ウィジェット・App Intents から開いたときの頼みごとは AppEntryPlugin が web/ に伝える。
/// web/ で選んだマイクへの入力の固定は MicInputPlugin → PreferredInput
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
        bridge?.registerPluginInstance(AppEntryPlugin())
        bridge?.registerPluginInstance(MicInputPlugin())
    }
}
