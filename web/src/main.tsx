import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';

import { TooltipProvider } from '@/components/ui/tooltip';
import { answerViewQueries, resyncPush } from '@/push';
import { queryClient } from '@/query';

import App from './App.tsx';
import './index.css';

// 最終要約の通知（#245）。service worker に開いている画面を答え（そのセッションを開いていれば出さない）、
// 通知をオンにしている端末では購読をホストに送り直す（クラウド版でホストが決まるのを少し待つ）
answerViewQueries();
setTimeout(() => void resyncPush(), 3000);

// キャッシュの中身を見る devtools（#330）。開発のときに URL に ?devtools を付けたときだけ読み込む
// （ビルドには入れない。ボタンがサイドバーの下に重なるので、ふだんは出さない）
const QueryDevtools =
    import.meta.env.DEV && new URLSearchParams(location.search).has('devtools')
        ? lazy(() => import('@tanstack/react-query-devtools').then((m) => ({ default: m.ReactQueryDevtools })))
        : null;

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            {/* テーマは端末ごとの好みなので、setting.json ではなくブラウザ（localStorage）に保存する。既定は OS の設定 */}
            <ThemeProvider attribute='class' defaultTheme='system' enableSystem disableTransitionOnChange>
                <TooltipProvider>
                    <App />
                </TooltipProvider>
            </ThemeProvider>
            {QueryDevtools && (
                <Suspense>
                    <QueryDevtools buttonPosition='bottom-left' />
                </Suspense>
            )}
        </QueryClientProvider>
    </StrictMode>,
);
