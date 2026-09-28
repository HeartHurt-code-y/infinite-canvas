import { describe, expect, it } from "vitest";
import {
  perTaskVideoInputIssue,
  perTaskVideoProfile,
  perTaskVideoUrlConnection,
  perTaskVideoUrlIssue,
} from "./perTaskVideo";

describe("SP 2.5 per-task video input limits", () => {
  it("recognizes only the eight documented model ids", () => {
    const models = [
      ["sp2.5-720p-4-15s", 4, 15, 10, 0],
      ["sp2.5-720p-16-30s", 16, 30, 10, 0],
      ["sp2.5-720p-30s-ch1", 30, 30, 30, 0],
      ["sp2.5-720p-30s-ch2", 30, 30, 9, 0],
      ["sp2.5-720p-30s-ch3", 30, 30, 30, 0],
      ["sp2.5-720p-30s-ch4", 30, 30, 9, 0],
      ["sp2.5-720p-30s-ch5", 30, 30, 10, 10],
      ["sp2.5-720p-30s-ch6", 30, 30, 30, 10],
    ] as const;
    for (const [modelId, minimumDuration, maximumDuration, maxImages, maxAudios] of models) {
      expect(perTaskVideoProfile(modelId)).toEqual({
        modelId,
        minimumDuration,
        maximumDuration,
        maxImages,
        maxAudios,
      });
    }
    expect(perTaskVideoProfile("sp2.5-720p-30s-ch7")).toBeNull();
    expect(perTaskVideoProfile("SP2.5-720p-30s-ch3")).toBeNull();
    expect(perTaskVideoProfile("doubao-seedance-2-5-260628")).toBeNull();
  });

  it("rejects unsupported references before creating a paid task", () => {
    const imageOnly = perTaskVideoProfile("sp2.5-720p-30s-ch4")!;
    expect(perTaskVideoInputIssue(imageOnly, [{ kind: "video" }])).toContain("不支持参考视频");
    expect(perTaskVideoInputIssue(imageOnly, [{ kind: "audio" }])).toContain("不支持参考音频");
    expect(
      perTaskVideoInputIssue(
        imageOnly,
        Array.from({ length: 10 }, () => ({ kind: "image" })),
      ),
    ).toContain("最多支持 9 张参考图");
    expect(perTaskVideoInputIssue(imageOnly, [{ kind: "image", role: "first_frame" }])).toContain(
      "不支持首帧",
    );
    expect(
      perTaskVideoInputIssue(imageOnly, [{ kind: "image", role: "reference_image" }]),
    ).toBeNull();

    const withAudio = perTaskVideoProfile("sp2.5-720p-30s-ch6")!;
    expect(
      perTaskVideoInputIssue(
        withAudio,
        Array.from({ length: 10 }, () => ({ kind: "audio" })),
      ),
    ).toBeNull();
    expect(
      perTaskVideoInputIssue(
        withAudio,
        Array.from({ length: 11 }, () => ({ kind: "audio" })),
      ),
    ).toContain("最多支持 10 段参考音频");
  });

  it("keeps public image and audio URLs typed and preserves signed query strings", () => {
    const image = {
      id: "image-1",
      kind: "image" as const,
      url: "https://assets.example.test/photo.png?token=abc%2F123&expires=9",
    };
    const audio = {
      id: "audio-1",
      kind: "audio" as const,
      url: "https://assets.example.test/music.wav?token=def%2B456",
    };
    expect(perTaskVideoUrlIssue([image, audio])).toBeNull();
    expect(perTaskVideoUrlConnection(image)).toMatchObject({
      kind: "image",
      role: "reference_image",
      target: { kind: "url", mediaType: "image", url: image.url },
    });
    expect(perTaskVideoUrlConnection(audio)).toMatchObject({
      kind: "audio",
      role: "reference_audio",
      target: { kind: "url", mediaType: "audio", url: audio.url },
    });
    expect(
      perTaskVideoUrlIssue([{ ...image, url: "ftp://assets.example.test/photo.png" }]),
    ).toContain("http(s)");
    expect(
      perTaskVideoUrlIssue([{ ...audio, url: "https://name:pass@assets.example.test/a.wav" }]),
    ).toContain("http(s)");
    expect(perTaskVideoUrlIssue([image, { ...audio, id: image.id }])).toContain("标识重复");
    for (const url of [
      "http://localhost/photo.png",
      "http://asset.localhost/photo.png",
      "http://127.0.0.1/photo.png",
      "http://192.168.1.9/photo.png",
      "http://10.0.0.1/photo.png",
      "http://[::1]/photo.png",
      "http://[fd00::1]/photo.png",
    ]) {
      expect(perTaskVideoUrlIssue([{ ...image, url }])).toContain("公网");
    }
  });
});
