import type { PickedPromptMaterial, PromptReferenceInput } from "../lib/backend";

export const workflowConnectedReferenceFixtures: readonly PromptReferenceInput[] = [
  {
    displayName: "云端参考图",
    target: {
      kind: "asset",
      providerConnectionId: "source-provider",
      assetId: "cloud-image",
      canvasNodeKey: "asset-instance-1",
      mediaType: "image",
    },
  },
  {
    displayName: "本地素材库声音",
    target: {
      kind: "local_asset",
      stagingJobId: "staged-audio",
      canvasNodeKey: "asset-instance-2",
      mediaType: "audio",
    },
  },
];

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
