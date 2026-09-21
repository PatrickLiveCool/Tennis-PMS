import { lookup } from "node:dns/promises";
import { normalizeBaseUrl, publicAddress, resolvePublicEndpoint } from "../../apps/api/src/assistant-model.ts";

/** Local proxy fake-IP compatibility. Never connect to the synthetic address. */
export async function resolveLocalModelEndpoint(baseUrl: string) {
  if (process.env.NODE_ENV === "production") throw new Error("Local resolver cannot run in production");
  const url = new URL(normalizeBaseUrl(baseUrl) + "/chat/completions");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const system = await Promise.race([
    lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MODEL_DNS_UNAVAILABLE")), 5000); }),
  ]).finally(() => clearTimeout(timer));
  if (!system.some(({ address }) => /^198\.(18|19)\./.test(address))) return resolvePublicEndpoint(baseUrl);
  const dns = new URL("https://cloudflare-dns.com/dns-query");
  dns.searchParams.set("name", url.hostname); dns.searchParams.set("type", "A");
  const response = await fetch(dns, { headers: { Accept: "application/dns-json" }, redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("MODEL_DNS_UNAVAILABLE");
  const result = await response.json() as { Status: number; Answer?: { type: number; data: string }[] };
  const addresses = result.Answer?.filter((answer) => answer.type === 1).map((answer) => answer.data) ?? [];
  if (result.Status !== 0 || !addresses.length || addresses.some((address) => !publicAddress(address))) throw new Error("MODEL_DNS_NOT_PUBLIC");
  return { url, address: { address: addresses[0]!, family: 4 } };
}
