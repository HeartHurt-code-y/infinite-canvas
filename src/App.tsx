import { QueryClientProvider } from "@tanstack/react-query";
import "@xyflow/react/dist/style.css";
import { useState } from "react";
import { Toaster } from "sonner";
import "./App.css";
import { CanvasStoreProvider } from "./features/canvas/canvasStore";
import { WorkspaceApp } from "./features/workspace/WorkspaceApp";
import { DEFAULT_ZOOM } from "./features/workspace/workspaceModel";
import { createQueryClient } from "./lib/queryClient";

export { ACTIVE_ASSET_PROVIDER_STORAGE_KEY } from "./features/workspace/workspaceModel";
export type {
  AssetEdgeData,
  AssetNodeData,
  GenNodeData,
  OutputNodeData,
  ResultNodeData,
  ScreenplayNodeData,
  StoryboardNodeData,
  VideoComposerNodeData,
  VideoDownloaderNodeData,
  ViralRemixNodeData,
} from "./features/workspace/workspaceModel";

function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <CanvasStoreProvider initialZoom={DEFAULT_ZOOM}>
        <WorkspaceApp />
      </CanvasStoreProvider>
      <Toaster
        className="app-toaster"
        closeButton
        position="bottom-right"
        richColors
        theme="light"
        visibleToasts={4}
        toastOptions={{ closeButtonAriaLabel: "关闭通知", duration: 4000 }}
      />
    </QueryClientProvider>
  );
}

export default App;
