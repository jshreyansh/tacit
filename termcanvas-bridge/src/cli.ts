import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTermcanvasBridgeServer } from "./mcp-server.ts";

async function main() {
  const server = createTermcanvasBridgeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[termcanvas-bridge] fatal error:", err);
  process.exit(1);
});
