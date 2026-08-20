import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "katex/dist/katex.min.css";
import { mark } from "./lib/perf";

// First mark of the launch: the bundle has parsed and React is about to mount.
mark("bundle parsed");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
