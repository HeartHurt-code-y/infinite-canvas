import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/noto-sans-sc";
import App from "./App";
import { installExternalLinkGuard } from "./lib/externalLinks";

// 站外链接一律改走系统浏览器：主窗口是应用外壳，被外站原地顶掉后没有返回键。
installExternalLinkGuard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
