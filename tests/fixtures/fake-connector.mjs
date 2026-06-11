// A stand-in external MCP server (think: GitHub / GCP / Railway connector)
// used by connector-e2e.test.ts to validate the plug-and-play surface.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-github", version: "1.0.0" });

server.registerTool(
  "repo_list",
  { description: "List repositories", inputSchema: {} },
  async () => ({
    content: [{ type: "text", text: JSON.stringify(["keyoku", "keyoku-engine"]) }],
  }),
);

server.registerTool(
  "issue_create",
  { description: "Create an issue", inputSchema: { title: z.string() } },
  async ({ title }) => ({
    content: [{ type: "text", text: `created issue #42: ${title}` }],
  }),
);

await server.connect(new StdioServerTransport());
