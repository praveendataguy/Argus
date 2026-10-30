import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";

export interface PasskeyStatus {
  enrolled: { id: string; label: string; createdAt: string }[];
  stepUpAbove: number;
}

export const webauthnSupported = browserSupportsWebAuthn;

export async function enrolPasskey(label: string) {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/passkey/register/options", {});
  const response = await startRegistration({ optionsJSON });
  return api<PasskeyStatus>("/passkey/register/verify", { response, label });
}

/** Approves; if the server demands step-up, signs the approval-bound challenge with a passkey and retries. */
export async function approve(id: string) {
  const res = await fetch(`/api/approvals/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && json.stepUp) {
    const assertion = await startAuthentication({ optionsJSON: json.options });
    return api(`/approvals/${id}/approve`, { assertion });
  }
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

/** RFC 6962 inclusion proof, recomputed in the browser with WebCrypto. */
export async function verifyInclusion(proof: { entryHash: string; path: { side: "L" | "R"; hash: string }[]; rootHash: string }) {
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const bytes = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
  const sha = async (...parts: Uint8Array[]) => {
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (buf.set(p, o), (o += p.length));
    return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  };
  let h = await sha(new Uint8Array([0]), bytes(proof.entryHash));
  const steps: string[] = [];
  for (const s of proof.path) {
    h = s.side === "L" ? await sha(new Uint8Array([1]), bytes(s.hash), h) : await sha(new Uint8Array([1]), h, bytes(s.hash));
    steps.push(hex(h.buffer as ArrayBuffer));
  }
  return { ok: steps.at(-1) === proof.rootHash || (proof.path.length === 0 && hex(h.buffer as ArrayBuffer) === proof.rootHash), steps };
}
