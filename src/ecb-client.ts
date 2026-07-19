import { logger } from "./logger.js";
import type { EcbClientConfig } from "./types.js";

// Retargeted to the OECD SDMX-REST v1 endpoint. OECD hosts every dataflow under
// a sub-agency (e.g. OECD.SDD.TPS); the bare "OECD" agency has no flows.
const ECB_BASE_URL = "https://sdmx.oecd.org/public/rest";

export function createClientConfig(): EcbClientConfig {
  return {
    baseUrl: (process.env.ECB_API_URL || ECB_BASE_URL).replace(/\/+$/, ""),
    // OECD structure/discovery payloads are large (dataflow/all is ~8.8 MB and
    // an individual DSD with embedded codelists can top 1 MB), so the original
    // 10s ECB timeout is too tight for the metadata tools.
    timeoutMs: 45_000,
    maxRetries: 3,
  };
}

export class EcbApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EcbApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tracks last request time to enforce minimum delay between calls. */
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1000;

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  config: EcbClientConfig,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      // Rate limiting: wait at least 1s between requests
      const now = Date.now();
      const elapsed = now - lastRequestTime;
      if (elapsed < MIN_REQUEST_INTERVAL_MS && lastRequestTime > 0) {
        await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
      }
      lastRequestTime = Date.now();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.status >= 500 && attempt < config.maxRetries) {
        const delay = 2 ** attempt * 1000;
        logger.warn(
          `ECB API error (${response.status}), retrying in ${delay}ms`,
          { attempt: attempt + 1, url },
        );
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < config.maxRetries) {
        const delay = 2 ** attempt * 1000;
        const reason =
          lastError.name === "AbortError" ? "Timeout" : "Network error";
        logger.warn(`${reason}, retrying in ${delay}ms`, {
          attempt: attempt + 1,
          error: lastError.message,
        });
        await sleep(delay);
      } else if (lastError.name === "AbortError") {
        throw new EcbApiError(
          `Request timed out after ${config.timeoutMs / 1000} seconds. ECB API may be slow.`,
        );
      }
    }
  }

  throw new EcbApiError(
    `Cannot reach ECB API. Check your internet connection. (${lastError?.message})`,
  );
}

function handleDataResponse(response: Response): Promise<string> {
  if (response.status === 400) {
    throw new EcbApiError(
      "Invalid query. Check your parameters — the SDMX series key may be malformed.",
    );
  }

  if (response.status === 404) {
    throw new EcbApiError(
      "No data found for this query. The combination of parameters may not have data for the requested period.",
    );
  }

  if (!response.ok) {
    throw new EcbApiError(`ECB API error (${response.status})`);
  }

  return response.text();
}

function handleMetadataResponse(response: Response): Promise<string> {
  if (response.status === 400) {
    throw new EcbApiError("Invalid metadata query.");
  }

  if (response.status === 404) {
    throw new EcbApiError(
      "Dataset not found. Use search_datasets to find available dataset IDs.",
    );
  }

  if (response.status === 406) {
    throw new EcbApiError(
      "ECB metadata endpoint returned 406. This is an internal error.",
    );
  }

  if (!response.ok) {
    throw new EcbApiError(`ECB API error (${response.status})`);
  }

  return response.text();
}

export class EcbClient {
  private config: EcbClientConfig;

  constructor(config: EcbClientConfig) {
    this.config = config;
  }

  /**
   * Fetch data from an OECD SDMX dataflow.
   * Returns raw SDMX-CSV string.
   *
   * OECD's SDMX-REST v1 data path requires the full flow reference
   * `{agency},{dataflow},{version}` — the ECB-style short `data/{flow}/{key}`
   * form 404s here. Agency is a sub-agency id (e.g. "OECD.SDD.TPS"); version is
   * optional and, when omitted, SDMX resolves to the latest version.
   *
   * The ECB-portal-only `format=csvdata` query param is dropped; OECD returns
   * SDMX-CSV purely off the `Accept: text/csv` header (verified 200).
   *
   * @param agency - owning (sub-)agency id, e.g. "OECD.SDD.TPS"
   * @param dataflow - dataflow id, e.g. "DSD_CPI_COU_WEIGHTS@DF_CPI_CTRY_WEIGHTS"
   * @param version - dataflow version, e.g. "1.0" (empty string = latest)
   * @param key - SDMX series key, e.g. "AUS..." (dot per unfilled dimension)
   * @param params - optional query params (startPeriod, endPeriod, lastNObservations)
   */
  async fetchData(
    agency: string,
    dataflow: string,
    version: string,
    key: string,
    params?: Record<string, string>,
  ): Promise<string> {
    const flowRef = version
      ? `${agency},${dataflow},${version}`
      : `${agency},${dataflow}`;
    const query = new URLSearchParams({ ...params }).toString();
    const url = `${this.config.baseUrl}/data/${flowRef}/${key}${
      query ? `?${query}` : ""
    }`;

    logger.debug("Fetching OECD data", { agency, dataflow, version, key, url });

    const response = await fetchWithRetry(
      url,
      { Accept: "text/csv" },
      this.config,
    );

    return handleDataResponse(response);
  }

  /**
   * Fetch metadata (XML) from the OECD SDMX API.
   * Returns raw XML string.
   *
   * @param path - e.g. "dataflow/all" or "dataflow/OECD.SDD.TPS/{id}/{version}?references=all"
   */
  async fetchMetadata(path: string): Promise<string> {
    const url = `${this.config.baseUrl}/${path}`;

    logger.debug("Fetching ECB metadata", { path, url });

    const response = await fetchWithRetry(
      url,
      { Accept: "application/xml" },
      this.config,
    );

    return handleMetadataResponse(response);
  }
}

/**
 * Reset the rate limiter — only used in tests.
 * @internal
 */
export function _resetRateLimiter(): void {
  lastRequestTime = 0;
}
