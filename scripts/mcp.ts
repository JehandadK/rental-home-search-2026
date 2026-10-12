/**
 * The recommendations API as an MCP server on stdio, for agents.
 *
 *   npm run --silent mcp                 (or: npx tsx scripts/mcp.ts)
 *   npx tsx scripts/mcp.ts --data public/data
 *
 * stdout carries the protocol, so every log line goes to stderr. The server
 * answers at once and loads the published data in the background; tools say
 * "still loading" until it is ready.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../src/api/mcp/server";
import { createApiService } from "../src/api/service";
import { fileSnapshotSource } from "../src/api/snapshot";
import { WEB_PUBLISH_DIR } from "../src/node/dataPaths";

const inline = process.argv.find((arg) => arg.startsWith("--data="));
const dataFlag = process.argv.indexOf("--data");
const dataDir = inline?.slice("--data=".length) ?? (dataFlag >= 0 ? process.argv[dataFlag + 1] : undefined) ?? process.env.API_DATA ?? WEB_PUBLISH_DIR;
const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

const source = fileSnapshotSource({ dir: dataDir, log });
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
