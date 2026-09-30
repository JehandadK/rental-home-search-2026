import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createRuntimeWebDataClient } from "./data/httpClient";
import { WebDataBoundary } from "./data/WebDataBoundary";
import "./styles/global.css";

// Published by `npm run data:web` into public/data/.
const client = createRuntimeWebDataClient(`${import.meta.env.BASE_URL}data/`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WebDataBoundary client={client}>{(data) => <App data={data} />}</WebDataBoundary>
  </StrictMode>,
);
