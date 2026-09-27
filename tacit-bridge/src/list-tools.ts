import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTacitBridgeServer } from "./mcp-server.ts";

/**
 * The bridge's tools exactly as an agent receives them: what `tools/list`
 * returns after the MCP SDK has turned each zod shape into JSON Schema.
 *
 * Reading the zod definitions instead would test our intent, not our output.
 * The conversion belongs to the SDK and zod, so an update to either can change
 * what agents receive without anyone touching a tool; this sees that change.
 *
 * In-process over the SDK's in-memory transport: no Tacit app, port file or
 * renderer needed. Not imported by cli.ts, so it adds nothing to the shipped
 * bridge. It lives in this package rather than in the root tests because the
 * SDK is installed only here.
 */

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export async function listToolsOf(server: McpServer): Promise<ListedTool[]> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tacit-tool-listing", version: "0" });
  await server.connect(serverSide);
  try {
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  } finally {
    await client.close();
    await server.close();
  }
}

/** Every tool the bridge serves to agents. */
export function listBridgeTools(): Promise<ListedTool[]> {
  return listToolsOf(createTacitBridgeServer());
}

// Re-exported so a test can build a scratch server with the same SDK the
// bridge uses, without resolving the SDK from outside this package.
export { McpServer };
