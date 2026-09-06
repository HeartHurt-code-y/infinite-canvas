import type { PickedPromptMaterial } from "../lib/backend";

export const workflowReferenceFixtures: readonly PickedPromptMaterial[] = [
  {
    localPath: "C:\\reference\\visual.png",
    displayName: "视觉参考.png",
    kind: "image",
    mimeType: "image/png",
    byteSize: 100,
  },
  {
    localPath: "C:\\reference\\voice.wav",
    displayName: "声音参考.wav",
    kind: "audio",
    mimeType: "audio/wav",
    byteSize: 100,
  },
  {
    localPath: "C:\\reference\\motion.mp4",
    displayName: "动作参考.mp4",
    kind: "video",
    mimeType: "video/mp4",
    byteSize: 100,
  },
  {
    localPath: "C:\\reference\\background.pdf",
    displayName: "背景资料.pdf",
    kind: "document",
    mimeType: "application/pdf",
    byteSize: 100,
  },
];

export const workflowReferenceInputs = workflowReferenceFixtures.map(
  ({ localPath, displayName, kind, mimeType }) => ({ localPath, displayName, kind, mimeType }),
);
