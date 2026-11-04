import { createContext } from "react";
import type { ListFeatureAssets } from "./CanvasFeatureAssetPicker";

export const CanvasReferenceLibraryContext = createContext<{
  readonly listAssets: ListFeatureAssets;
  readonly hasCloud: boolean;
} | null>(null);
