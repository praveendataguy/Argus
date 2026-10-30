import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/**
 * Verifiable credentials for agent payments, in the spirit of the Agent
 * Payments Protocol (AP2): the account owner signs each agent's spending
 * mandate, and Argus signs a receipt for every settled payment. Both are
 * compact JWS tokens (EdDSA / Ed25519) that anyone can verify against the
 * public keys published at /.well-known/jwks.json.
 */

interface Signer {
  kid: string;
  role: "owner" | "argus";
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function loadSigner(role: Signer["role"], envVar: string): Signer {
  const pem = process.env[envVar]?.replace(/\\n/g, "\n");
  const privateKey = pem ? createPrivateKey(pem) : generateKeyPairSync("ed25519").privateKey;
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({ format: "jwk" }).x!;
  return { kid: `${role}-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`, role, privateKey, publicKey };
}

// Without keys in the environment, fresh keys are generated per boot (fine for a demo).
const signers = {
  owner: loadSigner("owner", "OWNER_SIGNING_KEY"),
  argus: loadSigner("argus", "ARGUS_SIGNING_KEY"),
};

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Stable JSON so the same claims always produce the same bytes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function signToken(as: Signer["role"], claims: Record<string, unknown>): string {
  const s = signers[as];
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: s.kid }));
  const payload = b64url(canonical(claims));
  const sig = sign(null, Buffer.from(`${header}.${payload}`), s.privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

export interface Verified {
  valid: boolean;
  kid?: string;
  role?: Signer["role"];
  claims?: Record<string, unknown>;
  reason?: string;
}

export function verifyToken(token: string, expectRole?: Signer["role"]): Verified {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return { valid: false, reason: "Not a compact JWS token" };
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const signer = Object.values(signers).find((s) => s.kid === header.kid);
    if (!signer) return { valid: false, claims, reason: `Unknown signing key ${header.kid}` };
    if (expectRole && signer.role !== expectRole) return { valid: false, claims, kid: signer.kid, reason: `Signed by ${signer.role}, expected ${expectRole}` };
    const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), signer.publicKey, Buffer.from(parts[2], "base64url"));
    if (!ok) return { valid: false, claims, kid: signer.kid, role: signer.role, reason: "Signature does not match the contents" };
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return { valid: false, claims, kid: signer.kid, role: signer.role, reason: "Expired" };
    return { valid: true, claims, kid: signer.kid, role: signer.role };
  } catch {
    return { valid: false, reason: "Malformed token" };
  }
}

export const jwks = () => ({
  keys: Object.values(signers).map((s) => ({ ...s.publicKey.export({ format: "jwk" }), kid: s.kid, use: "sig", alg: "EdDSA", "x-role": s.role })),
});

export const keyIds = () => ({ owner: signers.owner.kid, argus: signers.argus.kid });

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
