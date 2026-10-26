import { QueryClientProvider } from "@tanstack/react-query";
import "@xyflow/react/dist/style.css";
import { useState } from "react";
import { Toaster } from "sonner";
import "./App.css";
import { CanvasWorkspace } from "./features/workspace/CanvasWorkspace";
import { CreateSurface, resolveCurrentEntry } from "./features/create";
import { createQueryClient } from "./lib/queryClient";
import { WorkspaceErrorBoundary } from "./components/WorkspaceErrorBoundary";
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
  VideoClipNodeData,
} from "./features/workspace/workspaceModel";

function App() {
  const [queryClient] = useState(createQueryClient);
  /*
   * 同一个前端产物有两个入口：
   *   - studio（默认）：完整的无限画布工作台；
   *   - create：创作台。整页外壳（侧栏 + 记录流 + 底部浮坞 + 资产库抽屉）
   *     与即梦创作页一致，资产库接本项目自己的素材库。
   * 入口判定见 features/create/createEntry.ts：URL 的 ?view=create、
   * hash 的 #create、或 Tauri 窗口标签为 create 都会进入创作台。
   */
  const [entry] = useState(resolveCurrentEntry);
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceErrorBoundary>
        {entry === "create" ? <CreateSurface /> : <CanvasWorkspace />}
      </WorkspaceErrorBoundary>
      <Toaster
        className="app-toaster"
        closeButton
        position="bottom-right"
        richColors
        theme="dark"
        visibleToasts={4}
        duration={4000}
        toastOptions={{ closeButtonAriaLabel: "关闭通知", duration: 4000 }}
      />
    </QueryClientProvider>
  );
}

export default App;
