import { QueryClientProvider } from "@tanstack/react-query";
import "@xyflow/react/dist/style.css";
import { useState } from "react";
import { Toaster } from "sonner";
import "./App.css";
import { CanvasWorkspace } from "./features/workspace/CanvasWorkspace";
import { createQueryClient } from "./lib/queryClient";
import "./styles/studio.css";

export {
  ACTIVE_ASSET_PROVIDER_STORAGE_KEY,
  ASSET_LIBRARY_SOURCE_STORAGE_KEY,
} from "./features/workspace/workspaceModel";
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
      <CanvasWorkspace />
      <Toaster
        className="app-toaster"
        closeButton
        position="bottom-right"
        richColors
        theme="dark"
        visibleToasts={4}
        toastOptions={{ closeButtonAriaLabel: "关闭通知", duration: 4000 }}
      />
    </QueryClientProvider>
  );
}

export default App;
