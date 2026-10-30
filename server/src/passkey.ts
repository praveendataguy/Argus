import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, sha256 } from "./credentials.js";
import { audit } from "./observability.js";
import type { Approval } from "./store.js";

/**
 * Passkey step-up for money movement. Once an operator enrols a passkey,
 * approving anything above STEP_UP_ABOVE needs a fresh WebAuthn assertion.
 * The challenge is derived from the exact approval (what you see is what you
 * sign), so a stolen session cookie or a tampered request can't reuse it.
 */

export const STEP_UP_ABOVE = Number(process.env.PASSKEY_STEP_UP_ABOVE ?? 100);
const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/passkeys.json");
const RP_NAME = "Argus";
const OPERATOR = { id: "argus-operator", name: "operator@nimbus-audio.example" };

interface StoredCredential {
  id: string;
  publicKey: string; // base64url
  counter: number;
  transports?: WebAuthnCredential["transports"];
  label: string;
  createdAt: string;
  rpID: string;
}

let creds: StoredCredential[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : [];
const save = () => {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(creds, null, 1));
};

/** Pending challenges: registration by rpID, step-up by approval id. Single use, 5 minute TTL. */
const challenges = new Map<string, { challenge: string; expires: number }>();
const take = (key: string) => {
  const c = challenges.get(key);
  challenges.delete(key);
  return c && c.expires > Date.now() ? c.challenge : undefined;
};
const put = (key: string, challenge: string) => challenges.set(key, { challenge, expires: Date.now() + 5 * 60_000 });

export const passkeyStatus = (rpID: string) => ({
  enrolled: creds.filter((c) => c.rpID === rpID).map((c) => ({ id: c.id.slice(0, 12), label: c.label, createdAt: c.createdAt })),
  stepUpAbove: STEP_UP_ABOVE,
});

export const needsStepUp = (a: Approval, rpID: string) => a.amount > STEP_UP_ABOVE && creds.some((c) => c.rpID === rpID);

export async function registrationOptions(rpID: string) {
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: OPERATOR.name,
    userID: new TextEncoder().encode(OPERATOR.id),
    attestationType: "none",
    excludeCredentials: creds.filter((c) => c.rpID === rpID).map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  put(`reg:${rpID}`, opts.challenge);
  return opts;
}

export async function verifyRegistration(rpID: string, origin: string, response: RegistrationResponseJSON, label = "Passkey") {
  const expectedChallenge = take(`reg:${rpID}`);
  if (!expectedChallenge) throw new Error("Registration challenge expired; try again");
  const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  if (!v.verified || !v.registrationInfo) throw new Error("Passkey registration could not be verified");
  const { credential } = v.registrationInfo;
  creds.push({ id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter, transports: credential.transports, label, createdAt: new Date().toISOString(), rpID });
  save();
  audit.append("security.passkey", "operator", `Enrolled passkey ${credential.id.slice(0, 12)} (${label}) for ${rpID}`);
  return passkeyStatus(rpID);
}

/** Binds the challenge to the approval's contents: id, kind, amount and payload. */
const approvalDigest = (a: Approval) => sha256(canonical({ id: a.id, kind: a.kind, amount: a.amount, currency: a.currency, payload: a.payload }));

export async function stepUpOptions(a: Approval, rpID: string) {
  const nonce = crypto.randomUUID();
  const challenge = Buffer.from(sha256(`${approvalDigest(a)}:${nonce}`), "hex").toString("base64url");
  const opts = await generateAuthenticationOptions({
    rpID,
    challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
    allowCredentials: creds.filter((c) => c.rpID === rpID).map((c) => ({ id: c.id, transports: c.transports })),
    userVerification: "required",
  });
  put(`step:${a.id}`, opts.challenge);
  return { ...opts, binding: { approvalId: a.id, digest: approvalDigest(a).slice(0, 16), amount: a.amount, title: a.title } };
}

export async function verifyStepUp(a: Approval, rpID: string, origin: string, response: AuthenticationResponseJSON) {
  const expectedChallenge = take(`step:${a.id}`);
  if (!expectedChallenge) throw new Error("No step-up challenge for this approval (expired or already used)");
  const c = creds.find((x) => x.id === response.id && x.rpID === rpID);
  if (!c) throw new Error("Unknown passkey");
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: { id: c.id, publicKey: new Uint8Array(Buffer.from(c.publicKey, "base64url")), counter: c.counter, transports: c.transports },
  });
  if (!v.verified) throw new Error("Passkey assertion failed");
  c.counter = v.authenticationInfo.newCounter;
  save();
  audit.append("security.step-up", "operator", `Passkey ${c.id.slice(0, 12)} signed approval ${a.id} ($${a.amount.toFixed(2)})`, {
    data: { digest: approvalDigest(a), userVerified: v.authenticationInfo.userVerified, counter: c.counter },
  });
  return c.id.slice(0, 12);
}

export function removePasskeys(rpID: string) {
  creds = creds.filter((c) => c.rpID !== rpID);
  save();
  audit.append("security.passkey", "operator", `Removed all passkeys for ${rpID}`);
}
