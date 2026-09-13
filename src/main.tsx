import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/noto-sans-sc";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
