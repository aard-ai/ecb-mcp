import { parseEcbCsv } from "../csv-parser.js";
import type { EcbClient } from "../ecb-client.js";

export interface GetDataInput {
  agency: string;
  dataflow: string;
  version?: string;
  key?: string;
  startPeriod?: string;
  endPeriod?: string;
  lastNObservations?: number;
}

/**
 * Generic OECD SDMX data query.
 *
 * Replaces the six euro-area-hardwired ECB data tools (whose series keys are
 * meaningless outside the ECB Data Portal) with a single raw-query tool that
 * builds the OECD full flow reference `{agency},{dataflow},{version}` and an
 * arbitrary dimension key. Returns the observations as `TIME_PERIOD,OBS_VALUE`.
 */
export async function handleGetData(
  client: EcbClient,
  input: GetDataInput,
): Promise<string> {
  const agency = input.agency.trim();
  const dataflow = input.dataflow.trim();
  const version = (input.version ?? "").trim();
  // Empty key = "all values of all dimensions"; SDMX also accepts a
  // dot-delimited key with a dot per unfilled dimension (e.g. "AUS...").
  const key = (input.key ?? "all").trim();

  const params: Record<string, string> = {};
  if (input.startPeriod) params.startPeriod = input.startPeriod;
  if (input.endPeriod) params.endPeriod = input.endPeriod;
  if (input.lastNObservations)
    params.lastNObservations = String(input.lastNObservations);

  const csv = await client.fetchData(agency, dataflow, version, key, params);
  const rows = parseEcbCsv(csv);

  const flowRef = version
    ? `${agency},${dataflow},${version}`
    : `${agency},${dataflow}`;

  if (rows.length === 0) {
    return `No observations for ${flowRef} / ${key} with the requested parameters.`;
  }

  const header = `OECD SDMX data — ${flowRef} / ${key} (source: OECD)`;
  const lines = ["TIME_PERIOD,OBS_VALUE"];
  for (const row of rows) {
    lines.push(`${row.TIME_PERIOD ?? ""},${row.OBS_VALUE ?? ""}`);
  }

  return `${header}\n${lines.join("\n")}`;
}
