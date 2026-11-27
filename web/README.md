# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

## 表示言語（i18n）

画面の文は、画面ごとの辞書に置いて表示言語（`ja` / `en`）で引く（#487。spec/ui.md 8）。仕組みは自作の小さなもので、ライブラリは使わない。

- `src/i18n/language.ts`: 表示言語。端末ごとに localStorage の `rw.language` に覚える。初めはブラウザの言語（日本語なら `ja`、ほかは `en`）。`setLanguage` で切り替えると `<html lang>` も合わせる。`index.html` のスクリプトも同じ決め方で、描く前に `lang` を付ける
- `src/i18n/messages.ts`: `defineMessages`（辞書をまとめる）・`useT`（部品の中で引く）・`Translation`（`en` の辞書の型）
- `en` にないキーは `ja` の文を出す。訳していない画面は、`English` を選んでも日本語のまま
- テスト（vitest）は表示言語を `ja` にして動かす（`src/test/setup.ts`）。日本語の文で確かめてよい

### 辞書の置き場所

辞書は、文を使うファイルがあるフォルダの直下の `i18n/` に置く。フォルダは `src/` の一段目（`app`・`api`・`components`）と、`src/features/` の一段目（`recording`・`session`・`settings` など）を単位にする。`src/features/recording/audio/` のような下のフォルダの文も、`src/features/recording/i18n/` に入れる。

| 文を使うファイル                           | 辞書                               | 辞書の名前                          |
| ------------------------------------------ | ---------------------------------- | ----------------------------------- |
| `src/features/recording/**`                | `src/features/recording/i18n/`     | `recordingMessages`                 |
| `src/features/session/**`                  | `src/features/session/i18n/`       | `sessionMessages`                   |
| `src/features/settings/**`                 | `src/features/settings/i18n/`      | `settingsMessages`（#487 で作った） |
| `src/features/setup/**`                    | `src/features/setup/i18n/`         | `setupMessages`                     |
| `src/features/<名前>/**`                   | `src/features/<名前>/i18n/`        | `<名前>Messages`                    |
| `src/app/**`                               | `src/app/i18n/`                    | `appMessages`                       |
| `src/components/**`                        | `src/components/i18n/`             | `componentsMessages`                |
| `src/api/**`                               | `src/api/i18n/`                    | `apiMessages`                       |
| `src/lib/**`・`src/hooks/**`               | `src/lib/i18n/`・`src/hooks/i18n/` | `libMessages`・`hooksMessages`      |
| サーバーのエラーのコード（#494）から引く文 | `src/api/serverErrors/i18n/`       | `serverErrorMessages`               |

サーバーのエラーの文だけは例外で、コードから文を引く仕組みごと `src/api/serverErrors/` に置く（`src/api/` のほかの文と別の作業で進めるため）。キーはエラーのコードそのもの（`'lmstudio.paused'`）。

ほかのフォルダの辞書は使わない（同じ文でも、自分のフォルダの辞書に置く）。こうすると、画面ごとの作業が同時に進んでも、ほかの作業のファイルにさわらない。`src/i18n/` と `vitest.config.ts` は変えなくてよい。

1 つの `i18n/` には 3 つのファイルを置く（`src/features/settings/i18n/` が見本）。

```ts
// i18n/ja.ts: すべての文。`as const` を付ける（{n} の引数を型で確かめるため）
import type { Dictionary } from '@/i18n/messages';

export const ja = {
    'micButton.start': '録音を始める',
    'micButton.left': 'あと {n} 分',
} as const satisfies Dictionary;
```

```ts
// i18n/en.ts: 訳した文だけ。まだ訳していないキーは書かない（ja の文を出す）。ja にないキーは型で止まる
import type { ja } from '@/features/recording/i18n/ja';
import type { Translation } from '@/i18n/messages';

export const en: Translation<typeof ja> = {};
```

```ts
// i18n/index.ts
import { en } from '@/features/recording/i18n/en';
import { ja } from '@/features/recording/i18n/ja';
import { defineMessages } from '@/i18n/messages';

export const recordingMessages = defineMessages({ ja, en });
```

### キーの付け方

- `'<ファイル名>.<役割>'`。ファイル名は文を使うファイルの名前（拡張子なし）を lowerCamelCase にしたもの（`MicButton.tsx` → `micButton`、`micMessages.ts` → `micMessages`）。役割は英語の lowerCamelCase（`start`・`denied`・`tooltip`・`left`）
- 同じファイルの中で同じ文を何度も使うときは、1 つのキーにまとめてよい。ファイルをまたいで同じ文（「保存」「キャンセル」など）を使うときは `'common.<役割>'` にまとめる（同じフォルダの中だけ）
- `ja.ts` の中は、ファイルごとにまとめ、ファイル名の順（アルファベット順）に並べる
- 文は今の日本語をそのまま移す（1 文字も変えない。`。` の有無・空白・全角半角も）

### 使い方

```tsx
import { recordingMessages } from '@/features/recording/i18n';
import { useT } from '@/i18n/messages';

export function MicButton() {
    const t = useT(recordingMessages); // 表示言語を切り替えると描き直す
    return <span>{t('micButton.left', { n: 3 })}</span>;
}
```

- 部品の中では `useT(<辞書>)` の `t` を使う。キーと引数は型で確かめる（ないキー・引数の抜け・引数の名前の打ち間違いは `npx tsc -b` で止まる）
- React の外（ストア・トースト・`recordingMessages.ts` のような文を作る関数）では `<辞書>.t('キー')`。呼んだ時点の表示言語で引く
- ファイルの一番上の定数（`const LABEL = '…'`）に入れた文は、読み込んだときの言語で固まる。定数にはキーを入れておき、出すときに `t` で引く（ラベルの一覧なら `{ value: 'ja', labelKey: 'xxx.ja' }` のようにする）
- 引数は `{名前}` で書き、`t('キー', { 名前: 値 })` で埋める。英語で単数・複数を分けるなどで文の形が変わるときは、値を関数にしてよい（`(p: { n: number }) => \`${p.n} 件\``。`en` でも同じ引数の関数にする）
- 文の途中にリンクや太字などの部品が入るときは、部品の前後で別のキーに分け、組み立ては部品の中でする
- 言語の名前（`日本語`・`English`）のように、どの表示言語でも同じに出すものは辞書に入れない

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
    "$schema": "./node_modules/oxlint/configuration_schema.json",
    "plugins": ["react", "typescript", "oxc"],
    "options": {
        "typeAware": true
    },
    "rules": {
        "react/rules-of-hooks": "error",
        "react/only-export-components": ["warn", { "allowConstantExport": true }]
    }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
