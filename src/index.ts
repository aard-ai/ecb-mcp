import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EcbClient, createClientConfig } from "./ecb-client.js";
import { logger } from "./logger.js";
import { MetadataService } from "./metadata.js";
import { handleExplainDataset } from "./tools/explain.js";
import { handleGetData } from "./tools/get-data.js";
import { handleSearchDatasets } from "./tools/search.js";

const config = createClientConfig();
const client = new EcbClient(config);
const metadata = new MetadataService(client);

const server = new McpServer({
  name: "ecb-mcp",
  version: "0.1.0",
});

server.tool(
  "get_data",
  `Fetch observations from any OECD SDMX dataflow.

OECD's SDMX-REST v1 data path requires the full flow reference
"{agency},{dataflow},{version}" — the agency is always a sub-agency such as
"OECD.SDD.TPS" (the bare "OECD" agency has no flows). Use search_datasets to
find dataflow ids (and their agency) and explain_dataset to learn the dimension
order before building a series key.

Examples of questions this tool answers:
- "What is the OECD CPI country weight for Australia?"
- "Get the latest observation for a given OECD dataflow and key"`,
  {
    agency: z
      .string()
      .describe(
        'Owning sub-agency id, e.g. "OECD.SDD.TPS". Find it via search_datasets.',
      ),
    dataflow: z
      .string()
      .describe(
        'Dataflow id, e.g. "DSD_CPI_COU_WEIGHTS@DF_CPI_CTRY_WEIGHTS" (OECD ids use the DSD@DF form).',
      ),
    version: z
      .string()
      .optional()
      .describe('Dataflow version, e.g. "1.0". Omit for the latest version.'),
    key: z
      .string()
      .optional()
      .describe(
        'SDMX series key: one segment per dimension in DSD order, joined by ".", empty segment = all values (e.g. "AUS..."). Omit or "all" for everything.',
      ),
    startPeriod: z
      .string()
      .optional()
      .describe("Start period (YYYY, YYYY-MM, or YYYY-MM-DD)"),
    endPeriod: z
      .string()
      .optional()
      .describe("End period (YYYY, YYYY-MM, or YYYY-MM-DD)"),
    lastNObservations: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Return only the last N observations"),
  },
  async (input) => {
    const text = await handleGetData(client, input);
    return { content: [{ type: "text" as const, text }] };
  },
);

server.tool(
  "search_datasets",
  `Search OECD's statistical dataflows by keyword.

Returns matching dataflow ids, names, and their owning sub-agency. Use this to
discover what data OECD publishes, then use explain_dataset to learn a flow's
structure or get_data to pull observations.

Examples of questions this tool answers:
- "What OECD datasets are available about prices?"
- "Does OECD publish data about labour force?"`,
  {
    query: z
      .string()
      .describe(
        'Search keyword (e.g. "prices", "labour", "trade", "education", "health")',
      ),
  },
  async (input) => {
    const text = await handleSearchDatasets(metadata, input);
    return { content: [{ type: "text" as const, text }] };
  },
);

server.tool(
  "explain_dataset",
  `Explain the structure of any OECD dataflow — dimensions, valid values, and an example key.

Use this after search_datasets to understand what a dataflow contains and how to
query it. Returns the dataflow's dimensions (in order), their valid codes, and an
example series key you can pass to get_data.

Examples of questions this tool answers:
- "What dimensions does the CPI country-weights dataflow have?"
- "What are the valid REF_AREA codes for this dataset?"`,
  {
    dataset_id: z
      .string()
      .describe(
        'Dataflow id (e.g. "DSD_CPI_COU_WEIGHTS@DF_CPI_CTRY_WEIGHTS"). Use search_datasets to find ids.',
      ),
  },
  async (input) => {
    const text = await handleExplainDataset(metadata, input);
    return { content: [{ type: "text" as const, text }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("ecb-mcp server started");
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
