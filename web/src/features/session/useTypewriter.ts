import { useEffect, useState } from 'react';

// 確定した文字を少しずつ出す（文字送りの演出）。key が変わったら（次の区間になったら）最初から
export function useTypewriter(text: string, key: number) {
    const [shown, setShown] = useState({ key, length: 0 });
    const length = shown.key === key ? Math.min(shown.length, text.length) : 0;

    useEffect(() => {
        if (length >= text.length) {
            return;
        }
        // 残りが多いほど速く出して、次の partial が来るまでに追いつくようにする
        const timer = setTimeout(() => {
            const step = Math.max(1, Math.ceil((text.length - length) / 8));
            setShown({ key, length: Math.min(text.length, length + step) });
        }, 30);
        return () => clearTimeout(timer);
    }, [key, length, text]);

    return text.slice(0, length);
}
