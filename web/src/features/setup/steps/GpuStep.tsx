import { CpuIcon } from 'lucide-react';

import { RELEASES_URL } from '@/features/setup/setup';
import { LinkButton, Note, Step } from '@/features/setup/steps/StepParts';

// wrongEdition: NVIDIA の GPU があるのに、Windows（OpenVINO）版で動いている（#408）
export function GpuStep({ wrongEdition = false }: { wrongEdition?: boolean }) {
    return (
        <Step
            title='GPU'
            purpose='文字起こしを速くするためのもの'
            icon={<CpuIcon className='size-4 shrink-0 text-muted-foreground' />}
        >
            {wrongEdition ? (
                <>
                    <Note>
                        NVIDIA の GPU が見つかりましたが、この Remote Whisper は Windows（OpenVINO）版のため、GPU
                        を使わずに CPU で動きます。Windows（CUDA）版を入れ直すと、GPU
                        で速く動きます（録音と文字起こしの記録はそのまま残ります）
                    </Note>
                    <div>
                        <LinkButton href={RELEASES_URL}>Windows（CUDA）版を入手</LinkButton>
                    </div>
                </>
            ) : (
                <Note>
                    GPU が見つからないため、文字起こしは CPU で動きます。GPU
                    より数倍以上遅くなり、文字が出るまで時間がかかります。モデルを small
                    などの小さいものにすると速くなります
                </Note>
            )}
        </Step>
    );
}
