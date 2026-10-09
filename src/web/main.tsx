import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// First, so every component stylesheet comes after the base styles and wins ties.
import "./styles/global.css";
import { App } from "./App";
import { createRuntimeWebDataClient } from "./data/httpClient";
import { WebDataBoundary } from "./data/WebDataBoundary";

// Published by `npm run data:web` into public/data/.
const client = createRuntimeWebDataClient(`${import.meta.env.BASE_URL}data/`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WebDataBoundary client={client}>{(data) => <App data={data} />}</WebDataBoundary>
  </StrictMode>,
);
