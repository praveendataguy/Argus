import { useEffect, useState } from "react";
import { ago, api, usd } from "../api";
import { enrolPasskey, verifyInclusion, webauthnSupported, type PasskeyStatus } from "../security";
import type { AppState } from "../types";

interface Jwk {
  kid: string;
  kty: string;
  crv: string;
  x: string;
  "x-role": string;
}

interface Verified {
  valid: boolean;
  kid?: string;
  role?: string;
  claims?: Record<string, unknown>;
  reason?: string;
}

interface Checkpoint {
  treeSize: number;
  rootHash: string;
  at: string;
  token: string;
}

interface Proof {
  seq: number;
  entryHash: string;
  treeSize: number;
  path: { side: "L" | "R"; hash: string }[];
  rootHash: string;
  checkpoint: Checkpoint;
}

const short = (s: string, n = 10) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);

export function TrustCenter({ state }: { state: AppState }) {
  const [passkeys, setPasskeys] = useState<PasskeyStatus | null>(null);
  const [keys, setKeys] = useState<Jwk[]>([]);
  const [samples, setSamples] = useState<{ label: string; token: string }[]>([]);
  const [token, setToken] = useState("");
  const [verified, setVerified] = useState<Verified | null>(null);
  const [cp, setCp] = useState<Checkpoint | null>(null);
  const [seq, setSeq] = useState("1");
  const [proof, setProof] = useState<(Proof & { ok: boolean; sig: Verified }) | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api<PasskeyStatus>("/passkey").then(setPasskeys);
    fetch("/.well-known/jwks.json").then((r) => r.json()).then((j) => setKeys(j.keys));
  }, []);

  useEffect(() => {
    api<{ mandates: { name: string; token: string }[]; payments: { id: string; receipt?: string }[] }>("/firewall").then((fw) => {
      const receipt = fw.payments.find((p) => p.receipt);
      setSamples([
        ...fw.mandates.map((m) => ({ label: `Mandate: ${m.name}`, token: m.token })),
        ...(receipt?.receipt ? [{ label: `Receipt ${receipt.id}`, token: receipt.receipt }] : []),
      ]);
    });
    api<{ audit: { checkpoint: Checkpoint | null; seq: number } }>("/observability").then((o) => setCp(o.audit.checkpoint));
  }, [state.approvals.length]);

  const enrol = async () => {
    setMsg(null);
    try {
      setPasskeys(await enrolPasskey(`Operator passkey ${(passkeys?.enrolled.length ?? 0) + 1}`));
      setMsg("Passkey enrolled. High-value approvals now need it.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const verify = async (t = token) => setVerified(await api<Verified>("/credentials/verify", { token: t }));

  const tamper = () => {
    // Flip a limit inside the payload but keep the original signature.
    const [h, p, s] = token.split(".");
    if (!s) return;
    const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    for (const k of ["perTxLimit", "amount", "treeSize"]) if (typeof claims[k] === "number") claims[k] = claims[k] * 10;
    const forged = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const t = `${h}.${forged}.${s}`;
    setToken(t);
    verify(t);
  };

  const prove = async () => {
    const p = await api<Proof>(`/audit/proof/${Number(seq)}`);
    const [{ ok }, sig] = await Promise.all([verifyInclusion(p), api<Verified>("/credentials/verify", { token: p.checkpoint.token })]);
    setProof({ ...p, ok: ok && sig.valid && sig.claims?.rootHash === p.rootHash, sig });
    setCp(p.checkpoint);
  };

  return (
    <div className="trust">
      <section className="wg-head">
        <div>
          <h2>Trust center</h2>
          <p className="muted">
            Every claim Argus makes can be checked by someone who doesn't trust Argus: mandates and receipts are Ed25519-signed, the audit log is a
            Merkle tree with signed checkpoints, and money moves above {usd(passkeys?.stepUpAbove ?? 100)} need a passkey signature from a human.
          </p>
        </div>
      </section>

      <div className="fw-grid">
        <section className="panel">
          <h2>🔑 Passkey step-up</h2>
          <p className="small muted">
            Approvals above {usd(passkeys?.stepUpAbove ?? 100)} require a WebAuthn assertion. The challenge is the hash of the exact approval (id, amount,
            payee), so a hijacked session or edited request can't reuse it.
          </p>
          {passkeys?.enrolled.length ? (
            <ul className="checks">
              {passkeys.enrolled.map((k) => (
                <li key={k.id} className="ok"><span>✓</span> <b>{k.label}</b> <span className="muted mono">{k.id}… · {ago(k.createdAt)}</span></li>
              ))}
            </ul>
          ) : (
            <p className="small">No passkey enrolled, so approvals use one click. Enrol one to turn on step-up.</p>
          )}
          <div className="row-gap">
            <button className="primary" disabled={!webauthnSupported()} onClick={enrol}>＋ Enrol a passkey</button>
            {Boolean(passkeys?.enrolled.length) && (
              <button onClick={() => fetch("/api/passkey", { method: "DELETE" }).then((r) => r.json()).then(setPasskeys)}>Remove all</button>
            )}
          </div>
          {msg && <p className="small">{msg}</p>}

          <h3>Signing keys (JWKS)</h3>
          {keys.map((k) => (
            <div key={k.kid} className="keyrow">
              <span className="tag">{k["x-role"]}</span>
              <span className="mono small">{k.kid}</span>
              <span className="mono small muted">{k.crv} · {short(k.x, 8)}</span>
            </div>
          ))}
          <p className="small muted">Published at <a className="mono" href="/.well-known/jwks.json" target="_blank" rel="noreferrer">/.well-known/jwks.json</a>, so anyone can verify offline.</p>

          <h3>Credential inspector</h3>
          <div className="row-gap wrap">
            {samples.map((s) => (
              <button key={s.label} className="small-btn" onClick={() => (setToken(s.token), verify(s.token))}>{s.label}</button>
            ))}
            {cp && <button className="small-btn" onClick={() => (setToken(cp.token), verify(cp.token))}>Audit checkpoint</button>}
          </div>
          <textarea className="mono small tokenbox" rows={3} value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste any Argus token (compact JWS)…" />
          <div className="row-gap">
            <button disabled={!token} onClick={() => verify()}>Verify signature</button>
            <button disabled={!token} onClick={tamper} title="Raise a limit in the payload but keep the signature">🧨 Tamper with it</button>
          </div>
          {verified && (
            <div className={`answer ${verified.valid ? "verdict-benign" : "verdict-fraud"}`}>
              {verified.valid ? `✅ Valid ${verified.role} signature (${verified.kid})` : `🚨 Rejected: ${verified.reason}`}
              {verified.claims && <pre className="code">{JSON.stringify(verified.claims, null, 2)}</pre>}
            </div>
          )}
        </section>

        <section className="panel">
          <h2>🌳 Transparency log</h2>
          <p className="small muted">
            The audit log is also an RFC 6962 Merkle tree. Argus signs a checkpoint (tree size + root) every 100 entries. With one checkpoint you can
            prove any single entry is in the log using about log₂(n) hashes, recomputed here in your browser.
          </p>
          {cp ? (
            <div className="cp">
              <div><span className="muted small">Tree size</span> <b>{cp.treeSize}</b></div>
              <div><span className="muted small">Root</span> <span className="mono small">{short(cp.rootHash, 16)}</span></div>
              <div className="muted small">signed {ago(cp.at)}</div>
            </div>
          ) : (
            <p className="small">No checkpoint yet.</p>
          )}
          <button onClick={async () => setCp(await api<Checkpoint>("/audit/checkpoint", {}))}>✍️ Sign a checkpoint now</button>

          <h3>Prove an entry is in the log</h3>
          <div className="row-gap">
            <input type="number" min={1} value={seq} onChange={(e) => setSeq(e.target.value)} style={{ width: 110 }} />
            <button className="primary" onClick={prove}>Get inclusion proof</button>
          </div>
          {proof && (
            <div className={`answer ${proof.ok ? "verdict-benign" : "verdict-fraud"}`}>
              {proof.ok
                ? `✅ Entry #${proof.seq} is in the signed log of ${proof.treeSize} entries. ${proof.path.length} hashes recomputed in your browser match the root, and the root's signature checks out.`
                : `🚨 Proof failed${proof.sig.valid ? "" : `: ${proof.sig.reason}`}`}
              <ol className="proofpath">
                <li className="mono small">leaf = H(0x00 ‖ {short(proof.entryHash, 8)})</li>
                {proof.path.map((s, i) => (
                  <li key={i} className="mono small">
                    {s.side === "L" ? `H(0x01 ‖ ${short(s.hash, 6)} ‖ ·)` : `H(0x01 ‖ · ‖ ${short(s.hash, 6)})`}
                  </li>
                ))}
                <li className="mono small">= root {short(proof.rootHash, 8)}</li>
              </ol>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
