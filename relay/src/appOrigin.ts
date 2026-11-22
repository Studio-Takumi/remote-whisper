// 画面を iOS アプリに同梱したとき（#440。spec/cloud.md 10.7・spec/mobile.md 11.8）のページのオリジン（capacitor://localhost）。
//
// - 許すオリジンは vars の APP_ORIGINS（カンマ区切り・完全一致）。空か、書いていなければ許さない（設定で止められる）
// - CORS は資格情報なし（Access-Control-Allow-Credentials を付けない）。付けるのはホストへの中継（/h/）と /me だけ
// - このオリジンからのリクエストでは、ログインセッションの Cookie を読まない（auth.ts の currentUser）。
//   Cookie で認める経路に、ほかのオリジンを混ぜないため。アプリのログイン（トークン）は #441 で足す
import type { Env } from './index';

const MAX_AGE_SEC = 600;

export function appOrigins(env: Pick<Env, 'APP_ORIGINS'>): string[] {
    return (env.APP_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o !== '');
}

export function isAppOrigin(request: Request, env: Pick<Env, 'APP_ORIGINS'>): boolean {
    const origin = request.headers.get('Origin');
    return origin !== null && appOrigins(env).includes(origin);
}

function corsPath(path: string): boolean {
    return path.startsWith('/h/') || path === '/me' || path.startsWith('/me/');
}

// CORS の preflight（OPTIONS）。アプリのオリジンからで、CORS を付けるパスのときだけ答える（ほかは null）
export function appPreflight(request: Request, env: Env, path: string): Response | null {
    if (
        request.method !== 'OPTIONS' ||
        !request.headers.has('Access-Control-Request-Method') ||
        !corsPath(path) ||
        !isAppOrigin(request, env)
    ) {
        return null;
    }
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': request.headers.get('Origin')!,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': String(MAX_AGE_SEC),
            Vary: 'Origin',
        },
    });
}

// 返事に CORS のヘッダーを付ける（headers は書き換えてよいもの）。アプリのオリジンでなければ何もしない
export function setAppCors(headers: Headers, request: Request, env: Env, path: string) {
    if (!corsPath(path) || !isAppOrigin(request, env)) {
        return;
    }
    headers.set('Access-Control-Allow-Origin', request.headers.get('Origin')!);
    headers.append('Vary', 'Origin');
}
