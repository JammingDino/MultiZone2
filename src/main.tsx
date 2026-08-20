import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import "./styles.css";
import "katex/dist/katex.min.css";
import { mark } from "./lib/perf";

// First mark of the launch: the bundle has parsed and React is about to mount.
mark("bundle parsed");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* The last resort. A throw that reaches here used to leave a blank
        window with nothing to go on; now it leaves the error and a retry. */}
    <ErrorBoundary label="MultiZone">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
