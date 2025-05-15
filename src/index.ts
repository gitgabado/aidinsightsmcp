// Aid Insight MCP Server – TypeScript version
// ------------------------------------------------------------
// This file re‑implements the Python server in JS/TS using the
// official MCP SDK so it can be deployed as a remote Cloudflare
// Worker or any other edge runtime.
//
//   • Extend `McpAgent` to bundle our tools
//   • Use `McpServer` to expose them on `/mcp` (JSON) and
//     `/sse` (server‑sent events) just like the reference sample
//   • Leverages native `fetch` so it works both in Node and the
//     Cloudflare worker runtime
//   • Schema‑validated inputs via `zod`
// ------------------------------------------------------------
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config / constants
// ---------------------------------------------------------------------------
const IATI_API_BASE =
  "https://api.iatistandard.org/datastore/activity/select";
const IATI_TXN_API_BASE =
  "https://api.iatistandard.org/datastore/transaction/select";
const IATI_API_KEY =
  typeof process !== "undefined" && process.env?.IATI_API_KEY
    ? process.env.IATI_API_KEY
    : "adb3539e596441b986012013b3cb46ae"; // dev default – override in env

// ---------------------------------------------------------------------------
// Helper: HTTP GET (works in worker + node)
// ---------------------------------------------------------------------------
async function getJson(url: string, params: Record<string, any>) {
  const qs = new URLSearchParams(params as any).toString();
  const full = `${url}?${qs}`;
  const resp = await fetch(full, {
    headers: { "Ocp-Apim-Subscription-Key": IATI_API_KEY },
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

function solrPairList(lst: any[]): { code: string; count: number }[] {
  const out: { code: string; count: number }[] = [];
  for (let i = 0; i < lst.length; i += 2) {
    out.push({ code: String(lst[i]), count: Number(lst[i + 1]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// AidInsight MCP Agent
// ---------------------------------------------------------------------------
export class AidInsight extends McpAgent {
  server = new McpServer({ name: "Aid Insight", version: "2.0.0-ts" });

  async init() {
    // --------------------------------------------------------
    // get_iati_projects (facet‑based)
    // --------------------------------------------------------
    this.server.tool(
      "get_iati_projects",
      z.object({
        keyword: z.string(),
        country_code: z.string().optional(),
        sample_size: z.number().int().min(0).default(5),
        facet_limit: z.number().int().min(1).max(100).default(50),
      }),
      async ({ keyword, country_code, sample_size, facet_limit }) => {
        const qParts: string[] = [`title_narrative:*${keyword}*`];
        if (country_code) qParts.push(`recipient_country_code:${country_code}`);

        const data = await getJson(IATI_API_BASE, {
          q: qParts.join(" AND "),
          rows: sample_size,
          wt: "json",
          fl: [
            "iati_identifier",
            "title_narrative",
            "sector_code",
            "activity_status_code",
            "recipient_country_code",
          ].join(","),
          facet: "true",
          "facet.field": ["sector_code", "activity_status_code"],
          "facet.limit": facet_limit,
          "facet.mincount": 1,
        });

        const docs = data.response?.docs ?? [];
        const facets = data.facet_counts?.facet_fields ?? {};
        const summary = {
          total_found: data.response?.numFound ?? 0,
          top_sectors: solrPairList(facets.sector_code ?? []).slice(0, 10),
          activity_statuses: solrPairList(facets.activity_status_code ?? []),
        };

        return {
          content: [
            {
              type: "json",
              json: {
                status: "success",
                parameters: { keyword, country_code },
                summary,
                sample_projects: docs,
              },
            },
          ],
        } as const;
      }
    );

    // --------------------------------------------------------
    // search_transactions (facet + stats)
    // --------------------------------------------------------
    this.server.tool(
      "search_transactions",
      z.object({
        keyword: z.string().optional(),
        country_code: z.string().optional(),
        min_value: z.number().optional(),
        max_value: z.number().optional(),
        start_date: z.string().optional(), // YYYY‑MM‑DD
        end_date: z.string().optional(),
        sample_size: z.number().int().default(5),
        facet_limit: z.number().int().default(50),
      }),
      async (p) => {
        const qParts: string[] = [];
        if (p.keyword) qParts.push(`title_narrative:*${p.keyword}*`);
        if (p.country_code) qParts.push(`recipient_country_code:${p.country_code}`);
        if (p.min_value !== undefined || p.max_value !== undefined) {
          const min = p.min_value ?? "*";
          const max = p.max_value ?? "*";
          qParts.push(`transaction_value:[${min} TO ${max}]`);
        }
        if (p.start_date || p.end_date) {
          const start = p.start_date ? `${p.start_date}T00:00:00Z` : "*";
          const end = p.end_date ? `${p.end_date}T23:59:59Z` : "*";
          qParts.push(`transaction_date_iso_date:[${start} TO ${end}]`);
        }

        const data = await getJson(IATI_TXN_API_BASE, {
          q: qParts.length ? qParts.join(" AND ") : "*:*",
          rows: p.sample_size,
          wt: "json",
          fl: [
            "iati_identifier",
            "title_narrative",
            "transaction_type_code",
            "transaction_value",
            "default_currency",
            "transaction_date_iso_date",
          ].join(","),
          facet: "true",
          "facet.field": ["transaction_type_code", "default_currency"],
          "facet.limit": p.facet_limit,
          "facet.mincount": 1,
          stats: "true",
          "stats.field": "transaction_value",
        });

        const docs = data.response?.docs ?? [];
        const facets = data.facet_counts?.facet_fields ?? {};
        const stats = data.stats?.stats_fields?.transaction_value ?? {};

        const summary = {
          total_transactions: stats.count ?? 0,
          total_value: stats.sum ?? 0,
          average_value: stats.mean ?? 0,
          currency_breakdown: solrPairList(facets.default_currency ?? []),
          transaction_types: solrPairList(facets.transaction_type_code ?? []),
        };

        return {
          content: [
            {
              type: "json",
              json: {
                status: "success",
                parameters: p,
                summary,
                sample_transactions: docs,
              },
            },
          ],
        } as const;
      }
    );

    // --------------------------------------------------------
    // top_aid_recipients (JSON facet API)
    // --------------------------------------------------------
    this.server.tool(
      "top_aid_recipients",
      z.object({
        country_code: z.string().optional(),
        top_n: z.number().int().min(1).max(100).default(10),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
      }),
      async ({ country_code, top_n, start_date, end_date }) => {
        const fq: string[] = [];
        if (country_code) fq.push(`recipient_country_code:${country_code}`);
        if (start_date || end_date) {
          const start = start_date ? `${start_date}T00:00:00Z` : "*";
          const end = end_date ? `${end_date}T23:59:59Z` : "*";
          fq.push(`transaction_date_iso_date:[${start} TO ${end}]`);
        }

        const jsonFacet = JSON.stringify({
          recipients: {
            type: "terms",
            field: "participating_org_name",
            limit: top_n,
            facet: { total_value: "sum(transaction_value)" },
            sort: { total_value: "desc" },
          },
        });

        const data = await getJson(IATI_TXN_API_BASE, {
          q: "*:*",
          rows: 0,
          wt: "json",
          ...(fq.length ? { fq } : {}),
          "json.facet": jsonFacet,
        });

        const buckets =
          data.facets?.recipients?.buckets ?? ([] as any[]);
        const top = buckets.map((b: any) => ({
          organisation: b.val,
          transaction_count: b.count,
          total_value: b.total_value,
        }));

        return {
          content: [
            {
              type: "json",
              json: {
                status: "success",
                parameters: { country_code, top_n, start_date, end_date },
                top_recipients: top,
              },
            },
          ],
        } as const;
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Cloudflare Worker entry (or generic fetch‑style edge runtime)
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // @ts-ignore
      return AidInsight.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      // @ts-ignore
      return AidInsight.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
