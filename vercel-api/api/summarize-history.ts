import { handleSummary } from "../lib/handlers.ts";

const summarizeHistoryApi = { fetch: handleSummary };

export default summarizeHistoryApi;
