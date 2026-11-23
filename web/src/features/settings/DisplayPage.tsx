import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PushToggle } from '@/features/settings/PushToggle';
import { Row, Section } from '@/features/settings/SettingsParts';
import { ShortcutInput } from '@/features/settings/ShortcutInput';
import { ThemeRow } from '@/features/settings/ThemeToggle';
import type { Settings } from '@/features/settings/settings';
import type { UpdateSection } from '@/features/settings/settingsDraft';
import { DEFAULT_MIC_SHORTCUT } from '@/features/settings/shortcut';

// 設定の「表示・その他」ページ
export function DisplayPage({
    draft,
    update,
    onChangeAllowedHosts,
}: {
    draft: Settings;
    update: UpdateSection;
    onChangeAllowedHosts: (allowedHosts: string[]) => void;
}) {
    return (
        <>
            <Section>
                <Row id='session-meta' label='サイドバーの録音日時と長さ'>
                    <Switch
                        id='session-meta'
                        checked={draft.display.sessionMeta}
                        onCheckedChange={(sessionMeta) => update('display', { sessionMeta })}
                    />
                </Row>
                <Row id='show-picked-terms' label='用語リスト（文字起こし抽出）の表示'>
                    <Switch
                        id='show-picked-terms'
                        checked={draft.display.showPickedTerms ?? false}
                        onCheckedChange={(showPickedTerms) => update('display', { showPickedTerms })}
                    />
                </Row>
                <Row id='show-speakers' label='話者の表示'>
                    <Switch
                        id='show-speakers'
                        checked={draft.display.showSpeakers ?? false}
                        onCheckedChange={(showSpeakers) => update('display', { showSpeakers })}
                    />
                </Row>
                <Row id='mic-shortcut' label='マイクボタンのショートカット'>
                    <ShortcutInput
                        id='mic-shortcut'
                        value={draft.display.micShortcut ?? DEFAULT_MIC_SHORTCUT}
                        onChange={(micShortcut) => update('display', { micShortcut })}
                    />
                </Row>
            </Section>
            {(draft.network || draft.updates) && (
                <Section title='接続'>
                    {/* 8000 番を開ける名前（#249）。古いサーバー（network がない）では出さない */}
                    {draft.network && (
                        <Row
                            id='allowed-hosts'
                            label='許可するホスト名'
                            description='IP アドレス・localhost・Tailscale の名前・この PC の名前のほかに開く名前です。カンマで区切ります'
                        >
                            <Input
                                id='allowed-hosts'
                                className='w-56'
                                placeholder='pc.example.com'
                                value={draft.network.allowedHosts.join(', ')}
                                onChange={(e) => onChangeAllowedHosts(e.target.value.split(','))}
                            />
                        </Row>
                    )}
                    {/* アップデートの確認（#472）。古いサーバー（updates がない）では出さない */}
                    {draft.updates && (
                        <Row
                            id='update-check'
                            label='アップデートの確認'
                            description='ホストの版と ID（クラウド版に登録していればホスト ID、していなければランダムな ID）を送って、新しい版を確かめます'
                        >
                            <Switch
                                id='update-check'
                                checked={draft.updates.check}
                                onCheckedChange={(check) => update('updates', { check })}
                            />
                        </Row>
                    )}
                </Section>
            )}
            {/* 端末ごとの設定（テーマ・通知。#239・#245）。全体設定の保存とは別に、切り替えたときに効く */}
            <Section title='この端末' description='保存を押さなくても、切り替えた時点で効きます'>
                <ThemeRow />
                <PushToggle />
            </Section>
        </>
    );
}
