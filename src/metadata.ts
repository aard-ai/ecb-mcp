import { XMLParser } from "fast-xml-parser";
import type { EcbClient } from "./ecb-client.js";
import { logger } from "./logger.js";
import type {
  CodelistValue,
  DataflowInfo,
  DimensionInfo,
  StructureInfo,
  StructureRef,
} from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

export class MetadataService {
  private client: EcbClient;
  private dataflowCache: DataflowInfo[] | null = null;
  private structureCache: Map<string, StructureInfo> = new Map();

  constructor(client: EcbClient) {
    this.client = client;
  }

  /**
   * Get the list of all OECD dataflows.
   * Cached in memory for the session. Failed fetches are NOT cached.
   *
   * OECD registers flows under sub-agencies (OECD.SDD.TPS, OECD.CFE.EDS, …),
   * not a single "OECD" agency, so `dataflow/OECD` 404s. `dataflow/all`
   * aggregates every hosted agency's flows.
   */
  async getDataflowList(): Promise<DataflowInfo[]> {
    if (this.dataflowCache) {
      return this.dataflowCache;
    }

    const xml = await this.client.fetchMetadata("dataflow/all");
    const parsed = parser.parse(xml);

    const dataflows = extractDataflows(parsed);
    this.dataflowCache = dataflows;

    logger.debug(`Parsed ${dataflows.length} dataflows from ECB metadata`);
    return dataflows;
  }

  /**
   * Search dataflows by keyword (case-insensitive).
   * Matches against dataflow ID and name.
   */
  async searchDataflows(query: string): Promise<DataflowInfo[]> {
    const flows = await this.getDataflowList();
    const q = query.toLowerCase();

    return flows.filter(
      (f) =>
        f.id.toLowerCase().includes(q) ||
        f.name.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q),
    );
  }

  /**
   * Get the structure definition for a specific dataflow.
   * Returns dimensions with their codelists.
   * Cached per dataflow ID. Failed fetches are NOT cached.
   */
  async getStructure(dataflowId: string): Promise<StructureInfo> {
    const cached = this.structureCache.get(dataflowId);
    if (cached) {
      return cached;
    }

    // First, find the dataflow (and its owning sub-agency) in the live list.
    const flows = await this.getDataflowList();
    const flow = flows.find(
      (f) => f.id.toUpperCase() === dataflowId.toUpperCase(),
    );
    if (!flow) {
      throw new Error(
        `Dataset "${dataflowId}" not found. Use search_datasets to find available dataset IDs.`,
      );
    }

    // Fetch the dataflow with all referenced structures (DSD + codelists),
    // scoped to the flow's own sub-agency and version. OECD DSD ids do not
    // follow the ECB `ECB_{ID}1` convention, so the real ref is read from the
    // parsed dataflow rather than reconstructed by naming rule.
    const versionSeg = flow.version ? `/${flow.version}` : "";
    const xml = await this.client.fetchMetadata(
      `dataflow/${flow.agency}/${flow.id}${versionSeg}?references=all`,
    );
    const parsed = parser.parse(xml);

    const structure = extractStructure(parsed, dataflowId, flow.name);
    this.structureCache.set(dataflowId, structure);

    logger.debug(
      `Parsed structure for ${dataflowId}: ${structure.dimensions.length} dimensions`,
    );
    return structure;
  }
}

function extractDataflows(parsed: Record<string, unknown>): DataflowInfo[] {
  const structures = navigatePath(parsed, [
    "Structure",
    "Structures",
    "Dataflows",
    "Dataflow",
  ]);

  if (!structures) return [];

  const flows = Array.isArray(structures) ? structures : [structures];

  return flows.map((flow: Record<string, unknown>) => {
    const id = (flow["@_id"] as string) || "";
    const agency = (flow["@_agencyID"] as string) || "";
    const version = (flow["@_version"] as string) || "";
    const name = extractName(flow.Name) || id;
    const structureRef = extractRef(flow.Structure);

    return { id, name, description: name, agency, version, structureRef };
  });
}

/**
 * Read an SDMX `<Structure><Ref .../></Structure>` reference, if present.
 */
function extractRef(structureNode: unknown): StructureRef | undefined {
  const ref = navigatePath(structureNode as Record<string, unknown>, [
    "Ref",
  ]) as Record<string, unknown> | null;
  if (!ref) return undefined;
  return {
    agency: (ref["@_agencyID"] as string) || "",
    id: (ref["@_id"] as string) || "",
    version: (ref["@_version"] as string) || "",
  };
}

function extractStructure(
  parsed: Record<string, unknown>,
  dataflowId: string,
  name: string,
): StructureInfo {
  // Build codelist lookup: codelistId → CodelistValue[]
  const codelistMap = new Map<string, CodelistValue[]>();
  const codelists = navigatePath(parsed, [
    "Structure",
    "Structures",
    "Codelists",
    "Codelist",
  ]);
  if (codelists) {
    const clArray = Array.isArray(codelists) ? codelists : [codelists];
    for (const cl of clArray) {
      const clId = (cl["@_id"] as string) || "";
      const codes = cl.Code;
      if (!codes) continue;
      const codeArray = Array.isArray(codes) ? codes : [codes];
      const values: CodelistValue[] = codeArray.map(
        (c: Record<string, unknown>) => ({
          id: (c["@_id"] as string) || "",
          name: extractName(c.Name),
        }),
      );
      codelistMap.set(clId, values);
    }
  }

  // Find the data structure and its dimensions
  const dataStructures = navigatePath(parsed, [
    "Structure",
    "Structures",
    "DataStructures",
    "DataStructure",
  ]);
  if (!dataStructures) {
    return { dataflowId, name, description: name, dimensions: [] };
  }

  const dsArray = Array.isArray(dataStructures)
    ? dataStructures
    : [dataStructures];
  const ds = dsArray[0] as Record<string, unknown>;

  const dimList = navigatePath(ds, [
    "DataStructureComponents",
    "DimensionList",
    "Dimension",
  ]);
  if (!dimList) {
    return { dataflowId, name, description: name, dimensions: [] };
  }

  const dimArray = Array.isArray(dimList) ? dimList : [dimList];
  const dimensions: DimensionInfo[] = dimArray.map(
    (dim: Record<string, unknown>) => {
      const dimId = (dim["@_id"] as string) || "";
      const position = Number.parseInt(
        (dim["@_position"] as string) || "0",
        10,
      );

      // Find the codelist reference
      const enumRef = navigatePath(dim, [
        "LocalRepresentation",
        "Enumeration",
        "Ref",
      ]) as Record<string, unknown> | null;
      const codelistId = enumRef ? (enumRef["@_id"] as string) || "" : "";
      const values = codelistMap.get(codelistId) || [];

      return { id: dimId, name: dimId, position, values };
    },
  );

  dimensions.sort((a, b) => a.position - b.position);

  return { dataflowId, name, description: name, dimensions };
}

function extractName(nameNode: unknown): string {
  if (typeof nameNode === "string") return nameNode;

  // OECD (and TNSO) serve multi-lingual names as an array of
  // { "@_xml:lang": "en"|"fr"|…, "#text": "…" }. Prefer the English label,
  // else fall back to the first entry.
  if (Array.isArray(nameNode)) {
    const en = nameNode.find(
      (n) =>
        typeof n === "object" &&
        n !== null &&
        (n as Record<string, unknown>)["@_xml:lang"] === "en",
    );
    const chosen = (en ?? nameNode[0]) as Record<string, unknown> | undefined;
    return chosen ? (chosen["#text"] as string) || "" : "";
  }

  if (typeof nameNode === "object" && nameNode !== null) {
    return ((nameNode as Record<string, unknown>)["#text"] as string) || "";
  }
  return "";
}

function navigatePath(
  obj: unknown,
  path: string[],
): Record<string, unknown> | Record<string, unknown>[] | null {
  let current: unknown = obj;
  for (const key of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    )
      return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current as Record<string, unknown> | Record<string, unknown>[] | null;
}
