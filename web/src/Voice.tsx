import { useRef, useState } from "react";
import { api } from "./api";

/* Minimal typing for the Web Speech API (Chrome / Edge / Safari). */
interface Recognition {
  lang: string;
  interimResults: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: (e: { error: string }) => void;
  start: () => void;
  stop: () => void;
}
const SR = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

const speak = (text: string) => {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text.slice(0, 400)));
};

const TAB_WORDS: [RegExp, string][] = [
  [/command|home|dashboard/, "Command Center"],
  [/transaction/, "Transactions"],
  [/ring|graph|network/, "Fraud Rings"],
  [/war ?game/, "War Game"],
  [/firewall|agent pay/, "Agent Firewall"],
  [/dispute/, "Disputes"],
  [/billing|invoice/, "Billing"],
  [/store|shop|checkout/, "Storefront"],
  [/trust|security|passkey|key/, "Trust Center"],
  [/observ|trace|audit|log/, "Observability"],
];

/**
 * Hands-free operation. Voice can look, navigate, simulate and ask, but by
 * design it can never approve money or switch to Autopilot: those need a
 * click (and a passkey above the step-up limit).
 */
async function handle(raw: string, go: (tab: string) => void, aiOnline: boolean): Promise<string> {
  const t = raw.toLowerCase();
  if (/\b(approve|pay|refund|send money|transfer)\b/.test(t) && !/\b(how|what|why|show|list)\b/.test(t))
    return "For safety, I can't move money by voice. Open the approval queue and approve it with a click.";
  if (/autopilot/.test(t)) return "Autopilot has to be switched on by hand. I won't do that from a voice command.";
  if (/(observe|guarded) mode|switch to (observe|guarded)/.test(t)) {
    const autonomy = /observe/.test(t) ? "observe" : "guarded";
    await api("/settings", { autonomy });
    return `Switched to ${autonomy} mode.`;
  }
  if (/war ?game|attack wave|red team/.test(t) && /(play|run|start|launch)/.test(t)) {
    go("War Game");
    await api("/wargame/round", {});
    return "Red team wave launched. Watch the war game.";
  }
  if (/investigat/.test(t)) {
    go("Investigator");
    const { queued } = await api<{ queued: string[] }>("/investigations/all", {});
    return queued.length ? `Opening ${queued.length} case${queued.length > 1 ? "s" : ""}. Watch the investigator work.` : "Nothing suspicious is waiting for an investigation.";
  }
  if (/storm|global attack/.test(t)) {
    go("Command Center");
    await api("/simulate/storm", { size: 14 });
    return "Global attack storm launched. Watch the threat globe.";
  }
  if (/risk sweep|analy[sz]e (new|unscored)/.test(t)) {
    await api("/transactions/analyse-unscored", {});
    return "Running a risk sweep on new orders.";
  }
  const sim = t.match(/simulate (an? )?(card[- ]testing|account takeover|reseller|normal)/);
  if (sim) {
    const scenario = sim[2].startsWith("card") ? "card-testing" : sim[2].startsWith("account") ? "account-takeover" : sim[2];
    await api(`/simulate/${scenario}`, {});
    return `Simulated a ${sim[2]} order.`;
  }
  if (/verify .*(audit|log|chain)/.test(t)) {
    const v = await api<{ ok: boolean; entries: number; brokenAt?: number }>("/audit/verify");
    return v.ok ? `The audit chain is intact. All ${v.entries} entries verified.` : `Warning: the audit chain is broken at entry ${v.brokenAt}.`;
  }
  if (/^(open|show|go to)\b/.test(t)) {
    const hit = TAB_WORDS.find(([re]) => re.test(t));
    if (hit) {
      go(hit[1]);
      return `Opening ${hit[1]}.`;
    }
  }
  if (!aiOnline) return "I only know built-in commands while the AI is offline. Try: open fraud rings, run a risk sweep, or verify the audit log.";
  const r = await api<{ text: string }>("/copilot", { question: raw });
  return r.text;
}

export function Voice({ go, aiOnline }: { go: (tab: string) => void; aiOnline: boolean }) {
  const [listening, setListening] = useState(false);
  const [line, setLine] = useState("");
  const rec = useRef<Recognition | null>(null);
  if (!SR) return null;

  const toggle = () => {
    if (listening) return rec.current?.stop();
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = false;
    r.onresult = async (e) => {
      const said = e.results[0][0].transcript;
      setLine(`“${said}”`);
      try {
        const reply = await handle(said, go, aiOnline);
        setLine(`“${said}” → ${reply}`);
        speak(reply);
      } catch (err) {
        setLine(`“${said}” → ${err instanceof Error ? err.message : err}`);
      }
    };
    r.onerror = (e) => setLine(e.error === "not-allowed" ? "Microphone blocked" : `Voice error: ${e.error}`);
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    setLine("Listening…");
    r.start();
  };

  return (
    <div className="voice">
      <button className={listening ? "listening" : ""} onClick={toggle} title="Voice commands: “open fraud rings”, “run a risk sweep”, “play a war game round”, “verify the audit log”, or ask anything">
        🎙️ {listening ? "Listening" : "Voice"}
      </button>
      {line && <span className="voice-text" title={line}>{line}</span>}
    </div>
  );
}

