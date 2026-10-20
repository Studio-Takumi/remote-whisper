// turndown-plugin-gfm には型がないので、使う分だけ書く
declare module 'turndown-plugin-gfm' {
    import type TurndownService from 'turndown';

    export const tables: TurndownService.Plugin;
}
