import { CpuIcon } from 'lucide-react';

import { Note, Step } from '@/features/setup/steps/StepParts';

export function GpuStep() {
    return (
        <Step
            title='GPU'
            purpose='文字起こしを速くするためのもの'
            icon={<CpuIcon className='size-4 shrink-0 text-muted-foreground' />}
        >
            <Note>
                GPU が見つからないため、文字起こしは CPU で動きます。GPU
                より数倍以上遅くなり、文字が出るまで時間がかかります。モデルを small
                などの小さいものにすると速くなります
            </Note>
        </Step>
    );
}
