import { describe, expect, it } from "vitest";
import type { StagingJobRecord, StagingStatus } from "../../lib/backend";
import {
  UPLOAD_ABANDONED_MS,
  mergeStagingJobsIntoUploads,
  shouldAutoDismissUpload,
  type AssetUploadEntry,
  textResultFromSource,
} from "./workspaceModel";

function uploadEntry(overrides: Partial<AssetUploadEntry> = {}): AssetUploadEntry {
  return {
    jobId: "job-1",
    name: "素材.png",
    kind: "image",
    status: "importing",
    bytesUploaded: 2048,
    bytesTotal: 2048,
    error: null,
    lastAdvancedAt: 1_000,
    stalled: false,
    destination: "cloud",
    adjustment: null,
    ...overrides,
  };
}

function stagingJob(overrides: Partial<StagingJobRecord> = {}): StagingJobRecord {
  return {
    id: "job-1",
    localPath: "C:\\media\\素材.png",
    purpose: "asset_import",
    mediaType: "image",
    objectKey: "staging/素材.png",
    status: "importing",
    bytesTotal: 2048,
    bytesUploaded: 2048,
    assetId: null,
    importTarget: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("mergeStagingJobsIntoUploads", () => {
  it("后端记录长时间无任何推进时落地为已中断并带上原因（僵尸在途行）", () => {
    // 真实场景：导入阶段后端进程退出，记录永远停在 importing，
    // 前端此前会一直转圈，而且非终态行不给关闭按钮。
    const entry = uploadEntry({ status: "importing", lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "importing" })],
      120_000,
    );
    expect(merged).not.toBeNull();
    const row = merged![0]!;
    expect(row.status).toBe("interrupted");
    expect(row.stalled).toBe(false);
    expect(row.error).toMatchObject({ kind: "abandoned", lastBackendStatus: "importing" });
    expect(String((row.error as { message: string }).message)).toContain("进程已经不在");
  });

  it("尚未超时的在途行照常刷新，不误判为中断", () => {
    const entry = uploadEntry({ status: "importing", lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "importing" })],
      119_999,
    );
    // importing 不是实时跟踪阶段且数据未变：整批无变化，返回 null 让调用方跳过重渲染。
    expect(merged).toBeNull();
  });

  it("字节仍在推进时不吃僵尸判定，并按推进刷新 lastAdvancedAt", () => {
    const entry = uploadEntry({ status: "uploading", bytesUploaded: 1024, lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "uploading", bytesUploaded: 4096 })],
      500_000,
    );
    expect(merged![0]).toMatchObject({ status: "uploading", bytesUploaded: 4096 });
    expect(merged![0]!.lastAdvancedAt).toBe(500_000);
    expect(merged![0]!.error).toBeNull();
  });

  it("后端已到终态时照实写入，不被僵尸判定改写", () => {
    const entry = uploadEntry({ status: "uploading", lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "failed", error: { kind: "transport", message: "连接中断" } })],
      500_000,
    );
    expect(merged![0]).toMatchObject({ status: "failed" });
    expect(merged![0]!.error).toEqual({ kind: "transport", message: "连接中断" });
  });

  it("占位行在后端还没有任务记录时只推进停滞提示", () => {
    const entry = uploadEntry({ status: "uploading", lastAdvancedAt: 0, stalled: false });
    const merged = mergeStagingJobsIntoUploads([entry], [null], 20_000);
    expect(merged![0]!.stalled).toBe(true);
    expect(merged![0]!.status).toBe("uploading");
  });

  it("已经是终态的行不再参与合并", () => {
    const entry = uploadEntry({ status: "interrupted", lastAdvancedAt: 0 });
    expect(mergeStagingJobsIntoUploads([entry], [null], 900_000)).toBeNull();
  });

  it("哨兵时间戳（epoch）不被当成僵尸，避免刚提交的上传立刻变成已中断", () => {
    // 后端记录缺 updated_at 时前端回填 0/1；若只看差值，任何"当前时间"都会超出窗口，
    // 一条正常的上传会被立刻判成已中断。
    const now = 1_800_000_000_000;
    const fresh = uploadEntry({ status: "uploading", lastAdvancedAt: 1, bytesUploaded: 0 });
    const freshMerged = mergeStagingJobsIntoUploads(
      [fresh],
      [stagingJob({ status: "uploading" })],
      now,
    );
    // uploading 是实时跟踪阶段：合并会刷新行的展示，但绝不能把状态改写成 interrupted。
    expect(freshMerged![0]!.status).toBe("uploading");
    expect(freshMerged![0]!.error).toBeNull();

    // 同一时刻，真实只停滞了两分钟的上传才该落地为已中断。
    const idle = uploadEntry({
      status: "uploading",
      lastAdvancedAt: now - UPLOAD_ABANDONED_MS - 1,
      bytesUploaded: 0,
    });
    const merged = mergeStagingJobsIntoUploads(
      [idle],
      [stagingJob({ status: "uploading", bytesUploaded: 0 })],
      now,
    );
    expect(merged![0]!.status).toBe("interrupted");
  });
});

describe("shouldAutoDismissUpload", () => {
  it("只有成功收尾的上传自动收起", () => {
    // 成功：素材库已给出素材身份。
    expect(shouldAutoDismissUpload("active")).toBe(true);
    expect(shouldAutoDismissUpload("cleaned")).toBe(true);
  });

  it("失败与中断永不自动收起：用户要看原因并重试", () => {
    expect(shouldAutoDismissUpload("failed")).toBe(false);
    expect(shouldAutoDismissUpload("interrupted")).toBe(false);
  });

  it("未完成的阶段都不算成功", () => {
    for (const status of [
      "validating",
      "authorizing",
      "uploading",
      "staged",
      "importing",
      "cleaning",
    ] satisfies StagingStatus[]) {
      expect(shouldAutoDismissUpload(status)).toBe(false);
    }
  });
});

describe("textResultFromSource", () => {
  it("extracts Context-IR 扩写正文 from source { kind: 'text', text }", () => {
    expect(textResultFromSource({ kind: "text", text: "  扩写后的完整提示词  " })).toBe(
      "扩写后的完整提示词",
    );
  });

  it("returns null for media sources or empty text", () => {
    expect(textResultFromSource({ kind: "url", url: "https://x" })).toBeNull();
    expect(textResultFromSource({ kind: "text", text: "   " })).toBeNull();
    expect(textResultFromSource(null)).toBeNull();
    expect(textResultFromSource(undefined)).toBeNull();
    expect(textResultFromSource("plain string")).toBeNull();
  });
});
