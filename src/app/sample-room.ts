import { createMockPorts } from "../core/adapters/mock.ts";
import { CoreError, throwIfAborted } from "../core/errors.ts";
import { createAnalysisRunner } from "../core/orchestrator.ts";
import { preprocessPhotos } from "../core/preprocess.ts";
import type { AnalysisStage, FinalReport, PreparedPhoto } from "../core/types.internal.ts";

const SAMPLES = [
  { name: "客厅", path: "samples/sample-07.jpg" },
  { name: "厨房", path: "samples/sample-08.jpg" },
] as const;
const PHOTO_ERRORS = new Set([
  "EMPTY_PHOTO", "PHOTO_TOO_LARGE", "UNSUPPORTED_FORMAT", "TYPE_MISMATCH",
  "INVALID_IMAGE", "IMAGE_TOO_LARGE", "ANIMATED_IMAGE", "ENCODE_FAILED",
  "OUTPUT_TOO_LARGE", "METADATA_RETAINED",
]);

export async function runSampleRoom(onStage: (stage: AnalysisStage) => void, signal: AbortSignal) {
  throwIfAborted(signal);
  const base = import.meta.env?.BASE_URL ?? "./";
  const assets = await Promise.all(SAMPLES.map(async sample => {
    try {
      const response = await fetch(base + sample.path, { signal, mode: "same-origin", redirect: "error" });
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      return { ...sample, file: new File([blob], sample.name + ".jpg", { type: "image/jpeg" }), issue: "" };
    } catch {
      throwIfAborted(signal);
      return { ...sample, file: null, issue: "素材加载失败，已跳过。" };
    }
  }));
  throwIfAborted(signal);

  const ready = new Map<File, { name: string; photo: PreparedPhoto }>();
  // Keep the core's one-to-one batch contract by filtering failed inputs before handing off.
  for (const asset of assets) {
    if (!asset.file) continue;
    try {
      const [photo] = await preprocessPhotos([asset.file], { signal });
      ready.set(asset.file, { name: asset.name, photo });
    } catch (error) {
      if (!(error instanceof CoreError) || !PHOTO_ERRORS.has(error.code)) throw error;
      asset.issue = `预处理失败，已跳过（${error.message}）。`;
    }
  }
  throwIfAborted(signal);
  let report: FinalReport | null = null;
  if (ready.size) {
    const analyze = createAnalysisRunner({ mock: createMockPorts() }, {
      preprocess: async files => files.map(file => ready.get(file)!.photo),
    });
    report = await analyze({
      mode: "mock",
      apiKey: "",
      provider: "gemini",
      photos: [...ready.keys()],
      location: { city: "演示城市", communityName: "样板间示例小区" },
    }, onStage, signal);
  }
  return {
    report,
    photos: [...ready.values()].map(({ name, photo }) => ({
      id: photo.id,
      name,
      dataUrl: `data:${photo.mimeType};base64,${photo.data}`,
      observations: report?.observations.filter(row => row.photoId === photo.id) ?? [],
    })),
    issues: assets.filter(asset => asset.issue).map(asset => `${asset.name}：${asset.issue}`),
  };
}
