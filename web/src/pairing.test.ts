import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { PairChecks, settled } from '@/components/PairPage';
import { type PairRequest, pairingCode } from '@/pairing';

const base: PairRequest = { code: 'ABCD-EFGH', hostName: 'PC', status: 'pending', answeredByMe: null, expiresAt: 0 };

describe('pairing', () => {
    it('/pair?code= のときだけコードを取り出す', () => {
        expect(pairingCode({ pathname: '/pair', search: '?code=ABCD-EFGH' })).toBe('ABCD-EFGH');
        expect(pairingCode({ pathname: '/pair', search: '' })).toBeNull();
        expect(pairingCode({ pathname: '/s/abc', search: '?code=ABCD-EFGH' })).toBeNull();
    });

    it('申請の状態に合わせて出し分ける（ほかの人が承認したものは知らせる）', () => {
        expect(settled(base)).toBeNull();
        expect(settled({ ...base, status: 'approved', answeredByMe: true })?.kind).toBe('done');
        expect(settled({ ...base, status: 'approved', answeredByMe: false })?.kind).toBe('error');
        expect(settled({ ...base, status: 'rejected', answeredByMe: true })?.kind).toBe('done');
    });

    it('接続元の国が違うときだけ強く知らせる。送られてきたコードの注意はいつも出す（#251）', () => {
        const render = (request: PairRequest) => {
            const container = document.createElement('div');
            container.innerHTML = renderToStaticMarkup(createElement(PairChecks, { request }));
            return container;
        };
        const warned = render({ ...base, countryMismatch: true });
        const warning = warned.querySelector('[data-pair-warning="country"]');
        expect(warning?.getAttribute('role')).toBe('alert');
        expect(warning?.textContent).toContain('この PC が手元にないなら承認しないでください');
        for (const request of [base, { ...base, countryMismatch: false }]) {
            const container = render(request);
            expect(container.querySelector('[data-pair-warning]')).toBeNull();
            expect(container.textContent).toContain('人から送られてきたコードは承認しないでください');
        }
        expect(warned.textContent).toContain('人から送られてきたコードは承認しないでください');
    });
});
