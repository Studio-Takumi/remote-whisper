// ホストのトンネル（#159。spec/cloud.md 10.6・10.17）
//
// Cloudflare の API で、ホストごとに名前つきのトンネル（設定はリモート）と公開ホスト名を作る。
// - 公開ホスト名は <TUNNEL_PREFIX><ホスト ID の頭 12 文字>.<TUNNEL_DOMAIN>（1 段のサブドメイン。無料の証明書が効く）
// - 転送先はホストの http://127.0.0.1:8001（トンネル専用のポート。Worker の署名がなければ断る）
// - 作るのは、ホストが起動のたびにトークンをもらいに来たとき（POST /pair/tunnel）。なければ作る。
//   途中で失敗しても、次に来たときに続きから作る（トンネル → 設定と DNS → tunnel_hostname の順に DB に残す）
// - 解除・退会のときに消す（DNS のレコードとトンネル）。消せなくても DB の行は消す（ログに残す）
import type { Env } from './index';

const API = 'https://api.cloudflare.com/client/v4';
export const TUNNEL_SERVICE = 'http://127.0.0.1:8001';

export class TunnelUnavailable extends Error {}

type CfResponse<T> = { success: boolean; result: T; errors?: { code: number; message: string }[] };

export type HostTunnel = { id: string; tunnel_id: string | null; tunnel_hostname: string | null };

function configured(env: Env): env is Env & { CF_API_TOKEN: string; CF_ACCOUNT_ID: string; CF_ZONE_ID: string } {
    return !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID && env.TUNNEL_DOMAIN && env.TUNNEL_PREFIX);
}

// 公開ホスト名の候補。ふつうはホスト ID の頭 12 桁、ほかのホストがもう使っていたら 32 桁全部
export function tunnelHostnames(env: Env, hostId: string): string[] {
    const hex = hostId.replace(/-/g, '');
    return [hex.slice(0, 12), hex].map((h) => `${env.TUNNEL_PREFIX}${h}.${env.TUNNEL_DOMAIN}`);
}

// 公開ホスト名を D1 で押さえる（hosts.tunnel_hostname は UNIQUE）。DNS を書く前に押さえるので、
// ほかのホストが使っている名前の DNS を書き換えることはない（ホスト ID はホストが決めるので、頭 12 桁を
// 他人に合わせた ID で申請されても、名前は取られない）
async function reserveHostname(env: Env, hostId: string): Promise<string> {
    for (const name of tunnelHostnames(env, hostId)) {
        try {
            const res = await env.DB.prepare(
                'UPDATE hosts SET tunnel_hostname = ? WHERE id = ? AND tunnel_hostname IS NULL',
            )
                .bind(name, hostId)
                .run();
            if (res.meta.changes) {
                return name;
            }
            // 同時に呼ばれて、もう押さえてあった
            const row = await env.DB.prepare('SELECT tunnel_hostname FROM hosts WHERE id = ?')
                .bind(hostId)
                .first<{ tunnel_hostname: string | null }>();
            if (row?.tunnel_hostname) {
                return row.tunnel_hostname;
            }
            throw new Error('the host was removed while reserving its hostname');
        } catch (e) {
            if (!/UNIQUE/i.test((e as Error).message)) {
                throw e;
            }
            // ほかのホストが使っている。次の（長い）名前を試す
        }
    }
    throw new Error('no free hostname for this host');
}

async function cf<T>(
    env: Env,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
): Promise<CfResponse<T>> {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
    });
    const data = (await res.json().catch(() => null)) as CfResponse<T> | null;
    return data ?? { success: false, result: null as T, errors: [{ code: res.status, message: 'not json' }] };
}

async function must<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
    const res = await cf<T>(env, method, path, body);
    if (!res.success) {
        // トークンの値は出さない。どの API が何で失敗したかだけ
        const reason = (res.errors ?? []).map((e) => `${e.code} ${e.message}`).join(', ');
        throw new Error(
            `Cloudflare API ${method} ${path.replace(/\/accounts\/[^/]+|\/zones\/[^/]+/g, '/…')}: ${reason}`,
        );
    }
    return res.result;
}

// ホストのトンネルを作り、hosts.tunnel_id に残して、その ID を返す。
// - 名前はホストごとに決まっている（同じ名前の生きているトンネルは作れない）。作ったあと DB に残す前に失敗していたら、
//   同じ名前のものが残っているので、まず探して使い直す
// - 同時に 2 回呼ばれたら、先に DB に残した方を使い、負けた側が作ったものは消す
async function createTunnel(env: Env, hostId: string): Promise<string> {
    const account = `/accounts/${env.CF_ACCOUNT_ID}`;
    const name = `rw-${env.CLOUD_ENV}-${hostId}`;
    const found = await must<{ id: string }[]>(
        env,
        'GET',
        `${account}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    );
    const ours =
        found[0]?.id ??
        (await must<{ id: string }>(env, 'POST', `${account}/cfd_tunnel`, { name, config_src: 'cloudflare' })).id;
    // 次の手順で失敗しても、作ったトンネルを見失わないように先に残す
    const saved = await env.DB.prepare('UPDATE hosts SET tunnel_id = ? WHERE id = ? AND tunnel_id IS NULL')
        .bind(ours, hostId)
        .run();
    if (saved.meta.changes) {
        return ours;
    }
    const winner = await env.DB.prepare('SELECT tunnel_id FROM hosts WHERE id = ?')
        .bind(hostId)
        .first<{ tunnel_id: string | null }>();
    if (!winner?.tunnel_id) {
        throw new Error('the host was removed while creating its tunnel');
    }
    if (winner.tunnel_id !== ours) {
        await cf(env, 'DELETE', `${account}/cfd_tunnel/${ours}`);
    }
    return winner.tunnel_id;
}

// トンネルを用意して（なければ作って）、cloudflared に渡すトークンと公開ホスト名を返す
export async function ensureTunnel(env: Env, host: HostTunnel): Promise<{ token: string; hostname: string }> {
    if (!configured(env)) {
        throw new TunnelUnavailable('tunnel API is not configured');
    }
    const account = `/accounts/${env.CF_ACCOUNT_ID}`;
    let tunnelId = host.tunnel_id;
    if (!tunnelId) {
        tunnelId = await createTunnel(env, host.id);
    }
    // 名前は D1 で押さえてから使う。転送先の設定と DNS は、呼ばれるたびに確かめ直す
    // （途中で失敗していても、次の起動で直る。どちらも同じ内容なら書き換えない）
    const hostname = host.tunnel_hostname ?? (await reserveHostname(env, host.id));
    const content = `${tunnelId}.cfargotunnel.com`;
    await must(env, 'PUT', `${account}/cfd_tunnel/${tunnelId}/configurations`, {
        config: { ingress: [{ hostname, service: TUNNEL_SERVICE }, { service: 'http_status:404' }] },
    });
    const record = { type: 'CNAME', name: hostname, content, proxied: true };
    const existing = await must<{ id: string; content?: string }[]>(
        env,
        'GET',
        `/zones/${env.CF_ZONE_ID}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    );
    if (existing.length === 0) {
        await must(env, 'POST', `/zones/${env.CF_ZONE_ID}/dns_records`, record);
    } else if (existing[0].content !== content) {
        // この名前は D1 でこのホストのものと確かめてある。違う向き先は、消し損ねた古いレコード
        console.warn(`repointing a stale DNS record for ${hostname} (host ${host.id})`);
        await must(env, 'PUT', `/zones/${env.CF_ZONE_ID}/dns_records/${existing[0].id}`, record);
    }
    const token = await must<string>(env, 'GET', `${account}/cfd_tunnel/${tunnelId}/token`);
    forgetOnline(tunnelId);
    return { token, hostname };
}

// トンネルと DNS のレコードを消す。失敗してもほかの手順は続け、残ったものはログに出す
export async function deleteTunnel(env: Env, host: HostTunnel): Promise<void> {
    if (!configured(env) || (!host.tunnel_id && !host.tunnel_hostname)) {
        return;
    }
    const steps: [string, () => Promise<unknown>][] = [];
    if (host.tunnel_hostname) {
        const hostname = host.tunnel_hostname;
        steps.push([
            'dns',
            async () => {
                const records = await must<{ id: string }[]>(
                    env,
                    'GET',
                    `/zones/${env.CF_ZONE_ID}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
                );
                for (const r of records) {
                    await must(env, 'DELETE', `/zones/${env.CF_ZONE_ID}/dns_records/${r.id}`);
                }
            },
        ]);
    }
    if (host.tunnel_id) {
        const base = `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${host.tunnel_id}`;
        // つながっている cloudflared を切ってから消す（つながったままだと消せない）。
        // 切った直後にホストの cloudflared がつなぎ直すことがあるので、消せなければもう 1 回切ってからやり直す
        steps.push([
            'tunnel',
            async () => {
                for (let attempt = 0; ; attempt++) {
                    await must(env, 'DELETE', `${base}/connections`);
                    const res = await cf(env, 'DELETE', base);
                    if (res.success || attempt >= 1) {
                        if (!res.success) {
                            throw new Error((res.errors ?? []).map((e) => `${e.code} ${e.message}`).join(', '));
                        }
                        return;
                    }
                }
            },
        ]);
    }
    for (const [name, step] of steps) {
        try {
            await step();
        } catch (e) {
            // 残ったものを手で消せるように、ID と名前を残す
            console.warn(
                `failed to delete the ${name} of host ${host.id} (tunnel ${host.tunnel_id ?? '-'}, ${host.tunnel_hostname ?? '-'}): ${(e as Error).message}`,
            );
        }
    }
}

// 1 人が登録できるホストの数（#166）
export const MAX_HOSTS_PER_USER = 5;

// オンラインかどうかを覚えておく時間（#166。一覧を連打されても Cloudflare の API をその数だけ呼ばない）。
// 「つながっている」は 60 秒、「つながっていない・分からない」は 10 秒（PC を起動した直後に、長く選べないままに
// しないため）。isolate ごとの覚え方なので、PoP を散らせばそのぶん呼べる。全体の回数は WAF で守る（docs/deploy.md）
const ONLINE_TTL_MS = 60 * 1000;
const OFFLINE_TTL_MS = 10 * 1000;
const onlineCache = new Map<string, { value: boolean | null; until: number }>();

// トンネルのトークンを渡した（cloudflared がこれからつなぐ）ので、覚えていた状態を捨てる
export function forgetOnline(tunnelId: string) {
    onlineCache.delete(tunnelId);
}

// トンネルに cloudflared がつながっているか（#161 のホストの一覧）。healthy・degraded ならつながっている。
// API が使えない・失敗したときは null（分からない）
export async function tunnelOnline(env: Env, tunnelId: string): Promise<boolean | null> {
    if (!configured(env)) {
        return null;
    }
    const cached = onlineCache.get(tunnelId);
    if (cached && cached.until > Date.now()) {
        return cached.value;
    }
    const value = await fetchTunnelOnline(env, tunnelId);
    if (onlineCache.size > 1000) {
        onlineCache.clear();
    }
    onlineCache.set(tunnelId, { value, until: Date.now() + (value === true ? ONLINE_TTL_MS : OFFLINE_TTL_MS) });
    return value;
}

async function fetchTunnelOnline(env: Env, tunnelId: string): Promise<boolean | null> {
    try {
        // 一覧はホストの数だけ並べて聞くので、遅いときは 3 秒で諦めて null にする（一覧全体を待たせない）
        const res = await cf<{ status?: string }>(
            env,
            'GET',
            `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`,
            undefined,
            AbortSignal.timeout(3000),
        );
        if (!res.success || !res.result?.status) {
            return null;
        }
        return res.result.status === 'healthy' || res.result.status === 'degraded';
    } catch {
        return null;
    }
}

// ユーザーのホストのトンネルをすべて消す（退会のとき）。ホストは 1 人 MAX_HOSTS_PER_USER 台までなので、
// Cloudflare の API の呼び出し（1 台あたり最大 6 回）は Worker のサブリクエストの上限（50）に収まる
export async function deleteUserTunnels(env: Env, userId: string): Promise<void> {
    const rows = await env.DB.prepare('SELECT id, tunnel_id, tunnel_hostname FROM hosts WHERE user_id = ?')
        .bind(userId)
        .all<HostTunnel>();
    for (const host of rows.results) {
        await deleteTunnel(env, host);
    }
}
