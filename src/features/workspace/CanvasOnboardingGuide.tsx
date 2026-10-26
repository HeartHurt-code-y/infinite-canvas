/*
 * 画布新手引导（对齐原站 liblib 的 4 步引导）。
 *
 * 原文案取自原站 i18n 字典（2026-10-22 下载的 8655 条）：
 *   onboardingStep1Title 第1/4步 / onboardingStep1Desc 双击或右键创建新节点
 *   onboardingStep2Title 第2/4步 / onboardingStep2Desc 图片上方工具栏有高清、抠图、九宫格等功能
 *   onboardingStep3Title 第3/4步 / onboardingStep3Desc 拖拽一个或多个节点 + 进行连接
 *   onboardingStep4Title 第4/4步 / onboardingStep4Desc 把多个作品打组，打组后可排序和整组执行
 *   guideDefaultSkipLabel 跳过 / guideDefaultPreviousLabel 上一步
 *   guideDefaultNextLabel 下一步 / guideDefaultDoneLabel 知道了
 *
 * 原站的引导是**首次进入画布**时弹的一次性浮层：底部居中一张卡片，
 * 标题行是「第 N/4 步」，正文一句话，底部是进度条 + 跳过 / 上一步 / 下一步（末步是「知道了」）。
 * 本项目按同一结构实现：看过一次就记下来（localStorage），不再打扰。
 */
import { useCallback, useState } from "react";

import { writeOnboardingSeen } from "./canvasOnboarding";
import "./CanvasOnboardingGuide.css";

/** 4 步引导的文案（照抄原站 i18n）。 */

interface OnboardingStep {
  readonly title: string;
  readonly description: string;
}

const STEPS: readonly OnboardingStep[] = [
  { title: "第1/4步", description: "双击或右键创建新节点" },
  { title: "第2/4步", description: "图片上方工具栏有高清、抠图、九宫格等功能" },
  { title: "第3/4步", description: "拖拽一个或多个节点 + 进行连接" },
  { title: "第4/4步", description: "把多个作品打组，打组后可排序和整组执行" },
];

export interface CanvasOnboardingGuideProps {
  /** 画布是否就绪（未就绪时不弹引导）。 */
  readonly ready: boolean;
  /** 是否展示引导。由调用方持有，好让浮坞的「教程」格能再次打开它。 */
  readonly open: boolean;
  /** 关闭引导（跳过 / 知道了）。 */
  readonly onClose: () => void;
}

/** 读「是否已经看过引导」。隐私模式下读不到就当成没看过。 */
export function CanvasOnboardingGuide({ ready, open, onClose }: CanvasOnboardingGuideProps) {
  const [stepIndex, setStepIndex] = useState(0);

  const finish = useCallback(() => {
    writeOnboardingSeen();
    onClose();
  }, [onClose]);

  if (!ready || !open) return null;
  const step = STEPS[stepIndex]!;
  const isLast = stepIndex === STEPS.length - 1;

  return (
    <div className="canvas-onboarding" role="dialog" aria-modal="false" aria-label="画布新手引导">
      <div className="canvas-onboarding__card">
        <p className="canvas-onboarding__title">{step.title}</p>
        <p className="canvas-onboarding__description">{step.description}</p>
        <div className="canvas-onboarding__progress" aria-hidden="true">
          {STEPS.map((item, index) => (
            <span
              key={item.title}
              className={`canvas-onboarding__segment${index <= stepIndex ? " is-done" : ""}`}
            />
          ))}
        </div>
        <div className="canvas-onboarding__actions">
          <button type="button" className="canvas-onboarding__skip" onClick={finish}>
            跳过
          </button>
          <div className="canvas-onboarding__steps">
            <button
              type="button"
              className="canvas-onboarding__secondary"
              disabled={stepIndex === 0}
              onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
            >
              上一步
            </button>
            <button
              type="button"
              className="canvas-onboarding__primary"
              onClick={() => {
                if (isLast) finish();
                else setStepIndex((index) => Math.min(STEPS.length - 1, index + 1));
              }}
            >
              {isLast ? "知道了" : "下一步"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
