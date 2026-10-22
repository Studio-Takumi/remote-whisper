import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ThemeProvider } from 'next-themes';

import { TooltipProvider } from '@/components/ui/tooltip';
import { answerViewQueries, resyncPush } from '@/push';

import App from './App.tsx';
import './index.css';

// 最終要約の通知（#245）。service worker に開いている画面を答え（そのセッションを開いていれば出さない）、
// 通知をオンにしている端末では購読をホストに送り直す（クラウド版でホストが決まるのを少し待つ）
answerViewQueries();
setTimeout(() => void resyncPush(), 3000);

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {/* テーマは端末ごとの好みなので、setting.json ではなくブラウザ（localStorage）に保存する。既定は OS の設定 */}
        <ThemeProvider attribute='class' defaultTheme='system' enableSystem disableTransitionOnChange>
            <TooltipProvider>
                <App />
            </TooltipProvider>
        </ThemeProvider>
    </StrictMode>,
);
