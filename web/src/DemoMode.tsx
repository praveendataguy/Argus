import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";

/**
 * Cinematic demo director: one click runs a narrated, end-to-end tour of
 * Argus. It switches tabs, fires a global attack storm, starts the war game,
 * hijacks an AI shopper, convenes the tribunal and verifies the audit chain,
 * while captions and the browser's own voice explain what is happening.
 * Everything it triggers is real and goes through the normal APIs.
 *
 * Keys: → or N skips ahead, M mutes, Esc stops.
 */

interface Step {
  title: string;
  tab: string;
  focus?: string;
  say: string | (() => Promise<string>);
  run?: () => Promise<unknown>;
  min: number; // seconds on screen, at least
}

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

const STEPS: Step[] = [
  {
    title: "Meet Argus",
    tab: "Command Center",
    focus: ".hero",
    say: "This is Argus, an autonomous AI back office guarding a PayPal merchant. A team of AI agents watches every payment, and a human holds the leash.",
    min: 7,
  },
  {
    title: "Global attack storm",
    tab: "Command Center",
    focus: ".globe-panel",
    run: () => quiet(api("/simulate/storm", { size: 14 })),
    say: "Let's attack it. I'm launching a global storm: honest buyers from around the world, mixed with fraud from Russia, Nigeria, Vietnam and China. Watch the payments fly across the threat globe.",
    min: 12,
  },
  {
    title: "Interception",
    tab: "Command Center",
    focus: ".globe-panel",
    say: "Risk Watch scores every capture as it lands. Red arcs are attacks crossing borders to freight forwarders and reshippers. When Argus holds one, a shield marks the interception, before anything ships.",
    min: 11,
  },
  {
    title: "Agents on a leash",
    tab: "Command Center",
    focus: ".feed-panel",
    say: "Every reasoning step and tool call streams into the live agent feed. Money only moves inside the policy the merchant set. Anything bigger waits in the approval queue, signed with a passkey.",
    min: 9,
  },
  {
    title: "Explainable scores",
    tab: "Transactions",
    focus: "main",
    say: "Every score is explainable: deterministic signals, AI reasoning, and an in-house machine learning model whose verdict splits exactly into per-feature contributions.",
    min: 8,
  },
  {
    title: "Fraud ring hunt",
    tab: "Fraud Rings",
    focus: "main",
    run: async () => {
      const g = await api<{ rings: { id: string; verdict: unknown }[] }>("/graph");
      const ring = g.rings.find((r) => !r.verdict) ?? g.rings[0];
      if (ring) await quiet(api(`/rings/${ring.id}/analyse`, {}));
    },
    say: "Organised fraud hides in small, normal-looking orders. Ring Hunter links accounts through shared devices, IP ranges and normalised addresses, then decides: fraud ring, or a family sharing a laptop.",
    min: 10,
  },
  {
    title: "AI versus AI",
    tab: "War Game",
    focus: "main",
    run: () => quiet(api("/wargame/round", {})),
    say: "Now AI fights AI. A red team agent invents new fraud designed to slip past Argus. A blue team agent studies what got through and writes new detection rules, backtested against real customers before they go live.",
    min: 14,
  },
  {
    title: "Agent payment firewall",
    tab: "Agent Firewall",
    focus: "main",
    run: () => quiet(api("/firewall/scenario/injection", {})),
    say: "AI agents are starting to spend money. This shopping agent just read a poisoned web page that tries to redirect its payment. Argus checks the signed mandate, scans for prompt injection and asks an independent judge. Blocked.",
    min: 11,
  },
  {
    title: "The tribunal",
    tab: "Disputes",
    focus: "main",
    run: async () => {
      const s = await api<{ disputes: { id: string; status: string; tribunal?: unknown }[] }>("/state");
      const d = s.disputes.find((x) => x.status !== "RESOLVED" && !x.tribunal) ?? s.disputes[0];
      if (d) await quiet(api(`/disputes/${d.id}/tribunal`, {}));
    },
    say: "For disputes, Argus convenes a tribunal. Merchant's counsel and the buyer's advocate argue the case, and an independent judge rules, calling out any claim the evidence does not support.",
    min: 12,
  },
  {
    title: "Verify, don't trust",
    tab: "Trust Center",
    focus: "main",
    say: "Verify, don't trust. Mandates and receipts are signed with Ed25519, big approvals need a passkey, and the audit log is a Merkle tree that anyone can check in the browser.",
    min: 9,
  },
  {
    title: "Tamper-evident audit",
    tab: "Observability",
    focus: "main",
    say: async () => {
      try {
        const v = await api<{ ok: boolean; entries: number }>("/audit/verify");
        return v.ok
          ? `Every decision is hash chained. I just re-verified all ${v.entries} audit entries. The chain is intact.`
          : "Every decision is hash chained, and verification just caught a tampered entry.";
      } catch {
        return "Every decision, tool call and PayPal API call is hash chained into a tamper-evident audit log.";
      }
    },
    min: 8,
  },
  {
    title: "Argus",
    tab: "Command Center",
    focus: ".globe-panel",
    say: "That's Argus. A hundred eyes on every PayPal payment, and a human holding the leash.",
    min: 7,
  },
];

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const en = voices.filter((v) => v.lang.startsWith("en"));
  return en.find((v) => /natural|aria|jenny|guy|neural/i.test(v.name)) ?? en.find((v) => /google (us|uk) english|samantha|daniel/i.test(v.name)) ?? en[0];
}

/** Speaks sentence by sentence (long utterances get cut off in Chrome). */
function narrate(text: string, muted: () => boolean, cancelled: () => boolean): Promise<void> {
  const synth = window.speechSynthesis;
  if (!synth || muted()) return new Promise((r) => setTimeout(r, Math.max(2500, text.split(/\s+/).length * 330)));
  synth.cancel();
  const voice = pickVoice();
  const parts = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  return parts.reduce<Promise<void>>(
    (p, part) =>
      p.then(
        () =>
          new Promise<void>((resolve) => {
            if (cancelled() || muted()) return resolve();
            const u = new SpeechSynthesisUtterance(part.trim());
            if (voice) u.voice = voice;
            u.rate = 1.04;
            const guard = setTimeout(resolve, 9000 + part.length * 90);
            u.onend = u.onerror = () => {
              clearTimeout(guard);
              resolve();
            };
            synth.speak(u);
          }),
      ),
    Promise.resolve(),
  );
}

export function DemoMode({ go }: { go: (tab: string) => void }) {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [caption, setCaption] = useState("");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const run = useRef(0); // bumps to cancel the current tour
  const skip = useRef<() => void>(() => undefined);

  const stop = useCallback(() => {
    run.current++;
    skip.current();
    window.speechSynthesis?.cancel();
    document.querySelectorAll(".demo-focus").forEach((el) => el.classList.remove("demo-focus"));
    document.body.classList.remove("demo-on");
    setActive(false);
  }, []);

  const start = async () => {
    const me = ++run.current;
    const cancelled = () => run.current !== me;
    setActive(true);
    document.body.classList.add("demo-on");
    window.speechSynthesis?.getVoices(); // warm the voice list
    for (let i = 0; i < STEPS.length && !cancelled(); i++) {
      const s = STEPS[i];
      setIndex(i);
      setCaption("");
      go(s.tab);
      await new Promise((r) => setTimeout(r, 450));
      if (cancelled()) return;
      document.querySelectorAll(".demo-focus").forEach((el) => el.classList.remove("demo-focus"));
      const el = s.focus ? document.querySelector(s.focus) : null;
      if (el) {
        el.classList.add("demo-focus");
        el.scrollIntoView({ behavior: "smooth", block: s.focus === "main" ? "start" : "center" });
      }
      if (s.run) void s.run();
      const text = typeof s.say === "string" ? s.say : await s.say();
      if (cancelled()) return;
      setCaption(text);
      const skipped = new Promise<void>((r) => (skip.current = r));
      const minimum = new Promise((r) => setTimeout(r, s.min * 1000));
      await Promise.race([Promise.all([narrate(text, () => mutedRef.current, cancelled), minimum]), skipped]);
      window.speechSynthesis?.cancel();
    }
    if (!cancelled()) stop();
  };

  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
      else if (e.key === "ArrowRight" || e.key.toLowerCase() === "n") skip.current();
      else if (e.key.toLowerCase() === "m") setMuted((m) => !m);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, stop]);

  useEffect(() => {
    if (muted) window.speechSynthesis?.cancel();
  }, [muted]);

  if (!active)
    return (
      <button className="demo-btn" onClick={start} title="Narrated, hands-free tour of every Argus capability (about 2 minutes)">
        <span className="demo-play">▶</span> Live demo
      </button>
    );

  const s = STEPS[index];
  return (
    <>
      <button className="demo-btn on" onClick={stop} title="Stop the demo (Esc)">
        ■ Stop demo
      </button>
      {createPortal(
        <>
          <div className="demo-bars" aria-hidden />
          <div className="demo-caption" role="status" aria-live="polite">
            <div className="demo-meta">
              <span className="demo-rec">● LIVE DEMO</span>
              <span>
                {String(index + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")} · {s.title}
              </span>
              <span className="spacer" />
              <button onClick={() => setMuted((m) => !m)} title="Mute narration (M)">
                {muted ? "🔇" : "🔊"}
              </button>
              <button onClick={() => skip.current()} title="Next step (→)">
                ⏭
              </button>
              <button onClick={stop} title="Stop (Esc)">
                ✕
              </button>
            </div>
            <p key={index}>{caption || "…"}</p>
            <div className="demo-progress">
              {STEPS.map((_, i) => (
                <i key={i} className={i < index ? "done" : i === index ? "now" : ""} />
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
