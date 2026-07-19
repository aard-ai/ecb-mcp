import { parseEcbCsv } from "../csv-parser.js";
import type { EcbClient } from "../ecb-client.js";

export interface GetDataInput {
  dataflow: string;
  key?: string;
  startPeriod?: string;
  endPeriod?: string;
  lastNObservations?: number;
}

/**
 * Generic raw SDMX data query against the configured endpoint (ABS).
 *
 * Unlike the euro-area-specific tools (get_exchange_rates, get_inflation, …)
 * this tool builds no series key of its own: the caller supplies the dataflow
 * reference and a fully positional SDMX series key, so it works for ANY ABS
 * dataflow. The dataflow may be a bare id ("CPI") or a full agency,flow,version
 * reference ("ABS,ABS_ANNUAL_ERP_LGA2016,1.0.0"); the key is dot-separated with
 * one segment per DSD dimension (leave a segment empty to wildcard it).
 */
export async function handleGetData(
  client: EcbClient,
  input: GetDataInput,
): Promise<string> {
  const dataflow = input.dataflow.trim();
  const key = (input.key ?? "").trim();

  const params: Record<string, string> = {};
  if (input.startPeriod) params.startPeriod = input.startPeriod;
  if (input.endPeriod) params.endPeriod = input.endPeriod;
  if (input.lastNObservations)
    params.lastNObservations = String(input.lastNObservations);

  const csv = await client.fetchData(dataflow, key, params);
  const rows = parseEcbCsv(csv);

  if (rows.length === 0) {
    return `No observations returned for ${dataflow} / ${key || "(all)"} with the requested parameters.`;
  }

  const header = `${dataflow} / ${key || "(all)"} — ${rows.length} observation${
    rows.length === 1 ? "" : "s"
  } (source: ABS)`;

  const lines = rows.map((row) => {
    const period = row.TIME_PERIOD ?? "";
    const value = row.OBS_VALUE ?? "";
    return `${period},${value}`;
  });

  return `${header}\nTIME_PERIOD,OBS_VALUE\n${lines.join("\n")}`;
}
