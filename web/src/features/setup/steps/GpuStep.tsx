import { CpuIcon } from 'lucide-react';

import { setupMessages } from '@/features/setup/i18n';
import { RELEASES_URL } from '@/features/setup/setup';
import { LinkButton, Note, Step } from '@/features/setup/steps/StepParts';
import { useT } from '@/i18n/messages';

// wrongEdition: NVIDIA の GPU があるのに、Windows（OpenVINO）版で動いている（#408）
export function GpuStep({ wrongEdition = false }: { wrongEdition?: boolean }) {
    const t = useT(setupMessages);
    return (
        <Step
            title='GPU'
            purpose={t('gpuStep.purpose')}
            icon={<CpuIcon className='size-4 shrink-0 text-muted-foreground' />}
        >
            {wrongEdition ? (
                <>
                    <Note>{t('gpuStep.wrongBuild')}</Note>
                    <div>
                        <LinkButton href={RELEASES_URL}>{t('gpuStep.getCudaBuild')}</LinkButton>
                    </div>
                </>
            ) : (
                <Note>{t('gpuStep.notFound')}</Note>
            )}
        </Step>
    );
}
