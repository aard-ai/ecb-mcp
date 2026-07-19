import { parseEcbCsv } from "../csv-parser.js";
import type { EcbClient } from "../ecb-client.js";

export interface GetDataInput {
  flowRef: string;
  key?: string;
  startPeriod?: string;
  endPeriod?: string;
  lastNObservations?: number;
}

/**
 * Generic SDMX data query for any TNSO dataflow.
 *
 * The six hard-wired ECB tools build euro-area series keys that do not exist
 * on TNSO, so this tool exposes the raw SDMX-REST data path instead: the
 * caller supplies a full flow reference (`AGENCY,DATAFLOW,VERSION`, e.g.
 * `TNSO,DF_01DI_IND_AGING,1.0`) and a dot-separated dimension key (leave a
 * segment empty to wildcard it). The response is SDMX-CSV, parsed into
 * TIME_PERIOD / OBS_VALUE rows.
 *
 * Note on TNSO periods: TIME_PERIOD is returned in the Buddhist Era calendar
 * (subtract 543 for the Gregorian year, e.g. 2564 -> 2021). Values are passed
 * through verbatim.
 */
export async function handleGetData(
  client: EcbClient,
  input: GetDataInput,
): Promise<string> {
  const params: Record<string, string> = {};
  if (input.startPeriod) params.startPeriod = input.startPeriod;
  if (input.endPeriod) params.endPeriod = input.endPeriod;
  if (input.lastNObservations) {
    params.lastNObservations = String(input.lastNObservations);
  }

  const key = input.key && input.key.length > 0 ? input.key : "all";
  const csv = await client.fetchData(input.flowRef, key, params);
  const rows = parseEcbCsv(csv);

  if (rows.length === 0) {
    return `No observations returned for ${input.flowRef}/${key}.`;
  }

  const header = `${rows.length} observation${
    rows.length === 1 ? "" : "s"
  } for ${input.flowRef}/${key} (source: TNSO)`;

  const lines = rows.map((r) => {
    const period = r.TIME_PERIOD ?? "";
    const value = r.OBS_VALUE ?? "";
    return `${period}\t${value}`;
  });

  return `${header}\n\nTIME_PERIOD\tOBS_VALUE\n${lines.join("\n")}`;
}
