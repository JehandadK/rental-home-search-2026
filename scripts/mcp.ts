/**
 * The recommendations API as an MCP server on stdio, for agents.
 *
 *   npm run --silent mcp                 (or: npx tsx scripts/mcp.ts)
 *   npx tsx scripts/mcp.ts --data public/data
 *   npx tsx scripts/mcp.ts --data https://example.com/rentals/data/
 *
 * stdout carries the protocol, so every log line goes to stderr. The server
 * answers at once and loads the published data in the background; tools say
 * "still loading" until it is ready.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseApiConfig } from "../src/api/config";
import { createMcpServer } from "../src/api/mcp/server";
import { createApiService } from "../src/api/service";
import { publishedSnapshotSource } from "../src/api/snapshot";
import { WEB_PUBLISH_DIR } from "../src/node/dataPaths";

// Only the data setting applies on stdio; host, port and tokens are for the HTTP server.
const parsed = parseApiConfig(process.argv.slice(2).filter((arg, i, argv) => arg.startsWith("--data") || (argv[i - 1] === "--data" && !arg.startsWith("--"))),
  { API_DATA: process.env.API_DATA }, WEB_PUBLISH_DIR);
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}
const { dataDir } = parsed.config;
const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

const source = publishedSnapshotSource({ from: dataDir, log });
const server = createMcpServer(createApiService(source), { log });
await server.connect(new StdioServerTransport());
log(`recommendations MCP server on stdio — loading data from ${dataDir}`);

const stop = async () => {
  source.close();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.stdin.on("end", () => void stop());
