// OAuth のプロバイダ（Google・Discord・GitHub）。コードフロー＋PKCE（S256）。
// 使う範囲は ID・表示名・メールだけ（spec/cloud.md 10.7）
import type { Env } from './index';

export type Provider = 'google' | 'discord' | 'github';

export const PROVIDERS: readonly Provider[] = ['google', 'discord', 'github'];

// プロバイダから取ったユーザーの情報
export type Profile = { subject: string; displayName: string; email: string | null };

type Config = {
    authorizeUrl: string;
    tokenUrl: string;
    scope: string;
    clientId: (env: Env) => string | undefined;
    clientSecret: (env: Env) => string | undefined;
    profile: (accessToken: string) => Promise<Profile>;
};

async function getJson<T>(url: string, accessToken: string): Promise<T> {
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            // GitHub の API は User-Agent が要る
            'User-Agent': 'remote-whisper-relay',
        },
    });
    if (!res.ok) {
        throw new Error(`profile ${res.status}`);
    }
    return (await res.json()) as T;
}

export const CONFIGS: Record<Provider, Config> = {
    google: {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scope: 'openid email profile',
        clientId: (env) => env.GOOGLE_CLIENT_ID,
        clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
        profile: async (token) => {
            const p = await getJson<{ sub: string; name?: string; email?: string }>(
                'https://openidconnect.googleapis.com/v1/userinfo',
                token,
            );
            return { subject: p.sub, displayName: p.name ?? p.email ?? 'Google', email: p.email ?? null };
        },
    },
    discord: {
        authorizeUrl: 'https://discord.com/oauth2/authorize',
        tokenUrl: 'https://discord.com/api/oauth2/token',
        scope: 'identify email',
        clientId: (env) => env.DISCORD_CLIENT_ID,
        clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
        profile: async (token) => {
            const p = await getJson<{
                id: string;
                username: string;
                global_name?: string | null;
                email?: string | null;
            }>('https://discord.com/api/users/@me', token);
            return { subject: p.id, displayName: p.global_name || p.username, email: p.email ?? null };
        },
    },
    github: {
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        // メールは表示用で、公開しているものだけでよい（/user/emails は呼ばないので user:email は要らない）
        scope: 'read:user',
        clientId: (env) => env.GITHUB_CLIENT_ID,
        clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
        profile: async (token) => {
            const p = await getJson<{ id: number; login: string; name?: string | null; email?: string | null }>(
                'https://api.github.com/user',
                token,
            );
            return { subject: String(p.id), displayName: p.name || p.login, email: p.email ?? null };
        },
    },
};

export function isProvider(value: string): value is Provider {
    return (PROVIDERS as readonly string[]).includes(value);
}

// 認可のコードをアクセストークンに替える
export async function exchangeCode(
    provider: Provider,
    env: Env,
    code: string,
    verifier: string,
    redirectUri: string,
): Promise<string> {
    const config = CONFIGS[provider];
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId(env) ?? '',
        client_secret: config.clientSecret(env) ?? '',
        code_verifier: verifier,
    });
    const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
    });
    if (!res.ok) {
        throw new Error(`token ${res.status}`);
    }
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!data.access_token) {
        throw new Error(`token ${data.error ?? 'missing'}`);
    }
    return data.access_token;
}
