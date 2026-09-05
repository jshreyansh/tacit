import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTacitBridgeServer } from "./mcp-server.ts";

async function main() {
  const server = createTacitBridgeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[tacit-bridge] fatal error:", err);
  process.exit(1);
});
