import { useEffect, useRef, useState } from "react";
import type { AgentEvent, AppConfig, AppState } from "./types";

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

/** Loads state once, then keeps it live from the server's event stream. */
export function useSentinel() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const refetch = useRef<number | undefined>(undefined);

  useEffect(() => {
    api<AppConfig>("/config").then(setConfig);
    const load = () => api<AppState>("/state").then(setState);
    load();

    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("agent", (msg) => {
      const event = JSON.parse((msg as MessageEvent).data) as AgentEvent;
      setState((s) => (s ? { ...s, events: [...s.events.slice(-299), event] } : s));
    });
    es.addEventListener("changed", () => {
      window.clearTimeout(refetch.current);
      refetch.current = window.setTimeout(load, 150);
    });
    return () => es.close();
  }, []);

  return { config, state, connected, setConfig };
}

export const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
export const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
