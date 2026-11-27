import { useState } from 'react';

import { CopyIcon, DownloadIcon, Share2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { sessionMessages } from '@/features/session/i18n';
import {
    type ShareSource,
    type ShareWhat,
    canShareWhat,
    canUseShare,
    copyShareText,
    downloadShareText,
    shareContent,
    shareLabel,
} from '@/features/session/share';
import { useT } from '@/i18n/messages';

const ORDER: ShareWhat[] = ['summary', 'transcript', 'both'];

// 文字起こし・要約を OS の共有機能で他のアプリ（ChatGPT など）に渡す（#335）。
// 共有機能が使えない（LAN の http など）ときは、コピーと .md のダウンロードだけ出す
export function ShareButton({ source, initial }: { source: ShareSource; initial: ShareWhat }) {
    const t = useT(sessionMessages);
    const [open, setOpen] = useState(false);
    const [picked, setPicked] = useState<ShareWhat>(initial);
    const [instruction, setInstruction] = useState('');
    // 選んだものが今は渡せない（要約がまだないなど）ときは、渡せるものに寄せる
    const what = canShareWhat(source, picked) ? picked : (ORDER.find((w) => canShareWhat(source, w)) ?? picked);
    const ready = canShareWhat(source, what);
    const shareable = canUseShare();

    const share = async () => {
        try {
            if ((await shareContent(source, what, instruction)) === 'shared') setOpen(false);
        } catch {
            toast.error(t('shareButton.failed'));
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (o) setPicked(initial);
                setOpen(o);
            }}
        >
            <DialogTrigger asChild>
                <Button variant='outline' size='sm' title={t('shareButton.description')}>
                    <Share2Icon />
                    {t('shareButton.share')}
                </Button>
            </DialogTrigger>
            <DialogContent className='sm:max-w-md'>
                <DialogHeader>
                    <DialogTitle>{t('shareButton.share')}</DialogTitle>
                    <DialogDescription>
                        {shareable ? t('shareButton.description') : t('shareButton.descriptionNoShare')}
                    </DialogDescription>
                </DialogHeader>
                <fieldset className='flex flex-col gap-2'>
                    <legend className='sr-only'>{t('shareButton.what')}</legend>
                    {ORDER.map((w) => (
                        <label key={w} className='flex items-center gap-2 text-sm has-disabled:opacity-50'>
                            <input
                                type='radio'
                                name='share-what'
                                value={w}
                                checked={what === w}
                                disabled={!canShareWhat(source, w)}
                                onChange={() => setPicked(w)}
                            />
                            {shareLabel(w)}
                        </label>
                    ))}
                </fieldset>
                <label className='flex flex-col gap-1 text-sm'>
                    {t('shareButton.instruction')}
                    <textarea
                        className='min-h-20 rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
                        placeholder={t('shareButton.instructionPlaceholder')}
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                    />
                </label>
                <DialogFooter className='gap-2 sm:items-center'>
                    <Button
                        variant='outline'
                        disabled={!ready}
                        onClick={() =>
                            copyShareText(source, what, instruction).then(
                                () => toast.success(t('shareButton.copied')),
                                () => toast.error(t('shareButton.copyFailed')),
                            )
                        }
                    >
                        <CopyIcon />
                        {t('shareButton.copy')}
                    </Button>
                    <Button
                        variant='outline'
                        disabled={!ready}
                        onClick={() => downloadShareText(source, what, instruction)}
                    >
                        <DownloadIcon />
                        {t('shareButton.download')}
                    </Button>
                    {shareable && (
                        <Button disabled={!ready} onClick={share}>
                            <Share2Icon />
                            {t('shareButton.share')}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
