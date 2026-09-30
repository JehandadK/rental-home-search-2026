import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createBundledWebDataClient } from "./data/bundledClient";
import { WebDataBoundary } from "./data/WebDataBoundary";
import "./styles/global.css";

const client = createBundledWebDataClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WebDataBoundary client={client}>{(data) => <App data={data} />}</WebDataBoundary>
  </StrictMode>,
);
