import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ThemeProvider } from 'next-themes';

import { TooltipProvider } from '@/components/ui/tooltip';

import App from './App.tsx';
import './index.css';

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
