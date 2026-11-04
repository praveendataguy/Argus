import { geoEquirectangular, geoInterpolate, geoDistance, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import landTopo from "world-atlas/land-110m.json";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, usd } from "../api";
import { jitter } from "../geo";
import type { Transaction } from "../types";

/* ------------------------------------------------------------------ */
/* Land as a dot matrix, rasterised once from Natural Earth (110m).    */
/* ------------------------------------------------------------------ */

let landDots: [number, number][] | null = null;
function getLandDots() {
  if (landDots) return landDots;
  const W = 720;
  const H = 360;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const topo = landTopo as unknown as Topology<{ land: GeometryCollection }>;
  const land = feature(topo, topo.objects.land);
  const path = geoPath(geoEquirectangular().fitSize([W, H], { type: "Sphere" }), ctx);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  path(land);
  ctx.fill();
  const px = ctx.getImageData(0, 0, W, H).data;
  const dots: [number, number][] = [];
  const STEP = 1.9;
  for (let lat = -58; lat <= 82; lat += STEP) {
    const lonStep = STEP / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    for (let lon = -180; lon < 180; lon += lonStep) {
      const x = Math.floor(((lon + 180) / 360) * W);
      const y = Math.floor(((90 - lat) / 180) * H);
      if (px[(y * W + x) * 4] > 128) dots.push([lon, lat]);
    }
  }
  return (landDots = dots);
}

/* ------------------------------------------------------------------ */

const RED = "255,77,109";
const AMBER = "255,196,57";
const GREEN = "46,229,157";
const SKY = "92,200,255";

const colorFor = (t: Transaction) => {
  const s = t.risk?.score;
  if (s === undefined) return SKY;
  return s >= 60 ? RED : s >= 30 ? AMBER : GREEN;
};
const blocked = (t: Transaction) => t.status === "HELD" || t.status === "REFUNDED" || t.risk?.action === "hold" || t.risk?.action === "refund";

interface Flight { id: string; born: number }
interface Burst { lon: number; lat: number; born: number; color: string; kind: "land" | "block" }

/**
 * A live 3D threat globe. Every PayPal capture flies from where the buyer's
 * IP actually is to where the parcel is going. Honest orders stay local and
 * green; attacks cross the planet in red, and when Argus holds or cancels one,
 * a shield burst marks the interception. Drag to spin.
 */
export function Globe({ txs }: { txs: Transaction[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef(txs);
  live.current = txs;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dots = getLandDots();
    let w = 0;
    let h = 0;
    let yaw = 40; // degrees; starts over the Atlantic so the US and Europe both show
    let tilt = 18;
    let raf = 0;
    let last = performance.now();
    let drag: { x: number; y: number; yaw: number; tilt: number } | null = null;
    let idleUntil = 0;
    const seen = new Map<string, { blocked: boolean }>();
    const flights: Flight[] = [];
    const bursts: Burst[] = [];
    let first = true;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const project = (lon: number, lat: number, alt = 0) => {
      const l = ((lon + yaw) * Math.PI) / 180;
      const p = (lat * Math.PI) / 180;
      const t = (tilt * Math.PI) / 180;
      const x = Math.cos(p) * Math.sin(l);
      const y = Math.sin(p);
      const z = Math.cos(p) * Math.cos(l);
      const y2 = y * Math.cos(t) - z * Math.sin(t);
      const z2 = y * Math.sin(t) + z * Math.cos(t);
      const R = Math.min(w, h) * 0.44 * (1 + alt);
      const visible = z2 > 0 || (alt > 0 && Math.hypot(x, y2) * (1 + alt) > 1);
      return { x: w / 2 + x * R, y: h / 2 - y2 * R, z: z2, visible };
    };

    const endpoints = (t: Transaction) => {
      const a = jitter(t.ipCountry, `${t.id}:ip`);
      const b = jitter(t.shipping.country, t.shipping.city || t.id);
      return a && b ? { a, b } : null;
    };

    const drawArc = (t: Transaction, upto: number, alpha: number, width: number, head: boolean) => {
      const e = endpoints(t);
      if (!e) return;
      const dist = geoDistance(e.a, e.b);
      if (dist < 0.06) return; // local orders get a ping instead of an arc
      const lift = 0.05 + Math.min(0.16, dist * 0.09);
      const interp = geoInterpolate(e.a, e.b);
      const color = colorFor(t);
      const N = 48;
      ctx.beginPath();
      let pen = false;
      let tip: { x: number; y: number } | null = null;
      for (let i = 0; i <= N * upto; i++) {
        const k = i / N;
        const [lon, lat] = interp(k);
        const q = project(lon, lat, lift * Math.sin(Math.PI * k));
        if (!q.visible) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
        pen = true;
        tip = q;
      }
      ctx.strokeStyle = `rgba(${color},${alpha})`;
      ctx.lineWidth = width;
      ctx.shadowColor = `rgba(${color},0.9)`;
      ctx.shadowBlur = head ? 12 : 4;
      ctx.stroke();
      if (head && tip) {
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,0.95)`;
        ctx.shadowBlur = 18;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    };

    const frame = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (!drag && now > idleUntil && !still) yaw = (yaw + dt * 0.006) % 360;

      // Track arrivals and interceptions.
      const recent = live.current.slice(0, 70);
      for (const t of recent) {
        const prev = seen.get(t.id);
        const isBlocked = blocked(t);
        if (!prev) {
          if (!first) flights.push({ id: t.id, born: now });
        } else if (!prev.blocked && isBlocked) {
          const e = endpoints(t);
          if (e) {
            const [lon, lat] = geoInterpolate(e.a, e.b)(0.5);
            bursts.push({ lon, lat, born: now, color: RED, kind: "block" });
            const [blon, blat] = e.b;
            bursts.push({ lon: blon, lat: blat, born: now + 120, color: RED, kind: "block" });
          }
        }
        seen.set(t.id, { blocked: isBlocked });
      }
      first = false;

      ctx.clearRect(0, 0, w, h);
      const R = Math.min(w, h) * 0.44;
      const cx = w / 2;
      const cy = h / 2;

      // Atmosphere and ocean.
      const halo = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.35);
      halo.addColorStop(0, "rgba(255,196,57,0.18)");
      halo.addColorStop(0.4, "rgba(0,112,224,0.08)");
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);
      const ocean = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
      ocean.addColorStop(0, "#1b1d2b");
      ocean.addColorStop(1, "#08080d");
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = ocean;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,196,57,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Graticule rings for depth.
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        let pen = false;
        for (let lon = -180; lon <= 180; lon += 6) {
          const q = project(lon, lat);
          if (!q.visible) { pen = false; continue; }
          if (pen) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
          pen = true;
        }
        ctx.stroke();
      }

      // Land.
      for (const [lon, lat] of dots) {
        const q = project(lon, lat);
        if (q.z <= 0) continue;
        ctx.fillStyle = `rgba(255,214,120,${0.18 + q.z * 0.62})`;
        ctx.fillRect(q.x - 1, q.y - 1, 2, 2);
      }

      // Settled arcs: faint trails of recent traffic.
      for (const t of recent) {
        if (flights.some((f) => f.id === t.id)) continue;
        drawArc(t, 1, blocked(t) ? 0.55 : 0.28, blocked(t) ? 1.4 : 1, false);
      }

      // Origins: a dot at each buyer IP, red for anything risky.
      for (const t of recent) {
        const e = endpoints(t);
        if (!e) continue;
        const q = project(e.a[0], e.a[1]);
        if (q.z <= 0) continue;
        const c = colorFor(t);
        ctx.beginPath();
        ctx.arc(q.x, q.y, c === RED ? 2.6 : 1.8, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c},0.95)`;
        ctx.shadowColor = `rgba(${c},1)`;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Live flights.
      for (let i = flights.length - 1; i >= 0; i--) {
        const f = flights[i];
        const t = recent.find((x) => x.id === f.id);
        const p = (now - f.born) / 1500;
        if (!t || p >= 1) {
          if (t) {
            const e = endpoints(t);
            if (e) bursts.push({ lon: e.b[0], lat: e.b[1], born: now, color: colorFor(t), kind: "land" });
          }
          flights.splice(i, 1);
          continue;
        }
        drawArc(t, Math.max(0.02, 1 - (1 - p) ** 3), 0.95, 2.2, true);
      }

      // Bursts: landing ripples and shield interceptions.
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        const age = (now - b.born) / (b.kind === "block" ? 1400 : 1100);
        if (age < 0) continue;
        if (age >= 1) { bursts.splice(i, 1); continue; }
        const q = project(b.lon, b.lat, b.kind === "block" ? 0.05 : 0);
        if (!q.visible) continue;
        const r = (b.kind === "block" ? 6 : 3) + age * (b.kind === "block" ? 26 : 16);
        ctx.strokeStyle = `rgba(${b.color},${1 - age})`;
        ctx.lineWidth = b.kind === "block" ? 2.2 : 1.4;
        ctx.beginPath();
        if (b.kind === "block") {
          for (let k = 0; k <= 6; k++) {
            const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
            const px = q.x + r * Math.cos(a);
            const py = q.y + r * Math.sin(a);
            if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
          }
        } else ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        ctx.stroke();
        if (b.kind === "block" && age < 0.7) {
          ctx.fillStyle = `rgba(${RED},${1 - age / 0.7})`;
          ctx.font = "700 10px Inter, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("BLOCKED", q.x, q.y - r - 4);
        }
      }

      raf = still ? 0 : requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, yaw, tilt };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      yaw = drag.yaw + (e.clientX - drag.x) * 0.35;
      tilt = Math.max(-60, Math.min(60, drag.tilt + (e.clientY - drag.y) * 0.3));
      if (still) requestAnimationFrame(frame);
    };
    const up = () => {
      drag = null;
      idleUntil = performance.now() + 2500;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  }, []);

  return <canvas ref={ref} className="globe" aria-label="Live threat globe: payments flying from buyer IP to shipping destination" />;
}

/* ------------------------------------------------------------------ */
/* Threat level: a DEFCON-style read on the last few minutes.          */
/* ------------------------------------------------------------------ */

export function threatLevel(txs: Transaction[]) {
  const cutoff = Date.now() - 15 * 60_000;
  let window = txs.filter((t) => Date.parse(t.createdAt) >= cutoff);
  if (window.length < 5) window = txs.slice(0, 12);
  const scores = window.map((t) => t.risk?.score ?? 25).sort((a, b) => a - b);
  if (!scores.length) return { index: 0, label: "CALM", tone: GREEN };
  const avg = scores.reduce((s, x) => s + x, 0) / scores.length;
  const p90 = scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.9))];
  const index = Math.round(0.45 * avg + 0.55 * p90);
  const [label, tone] = index >= 65 ? ["SEVERE", RED] : index >= 45 ? ["ELEVATED", AMBER] : index >= 25 ? ["GUARDED", SKY] : ["CALM", GREEN];
  return { index, label, tone };
}

function Gauge({ index, label, tone }: { index: number; label: string; tone: string }) {
  const a = Math.PI * (1 - index / 100);
  const R = 52;
  const nx = 64 + R * Math.cos(a);
  const ny = 62 - R * Math.sin(a);
  return (
    <svg viewBox="0 0 128 76" className="gauge" role="img" aria-label={`Threat level ${label}, ${index} of 100`}>
      <defs>
        <linearGradient id="gaugeg" x1="0" x2="1">
          <stop offset="0" stopColor={`rgb(${GREEN})`} />
          <stop offset="0.45" stopColor={`rgb(${AMBER})`} />
          <stop offset="1" stopColor={`rgb(${RED})`} />
        </linearGradient>
      </defs>
      <path d="M12 62 A52 52 0 0 1 116 62" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" strokeLinecap="round" />
      <path d="M12 62 A52 52 0 0 1 116 62" fill="none" stroke="url(#gaugeg)" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(index / 100) * 163.4} 400`} />
      <line x1="64" y1="62" x2={nx} y2={ny} stroke="#fff" strokeWidth="2.5" strokeLinecap="round" style={{ transition: "all .8s" }} />
      <circle cx="64" cy="62" r="4" fill="#fff" />
    </svg>
  );
}

/** The globe plus everything a judge needs to read it at a glance. */
export function ThreatGlobePanel({ txs }: { txs: Transaction[] }) {
  const [storming, setStorming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const level = threatLevel(txs);
  const stats = useMemo(() => {
    const countries = new Set(txs.flatMap((t) => [t.ipCountry, t.shipping.country]));
    const crossBorder = txs.filter((t) => t.ipCountry !== t.shipping.country).length;
    const intercepted = txs.filter(blocked).reduce((s, t) => s + t.amount, 0);
    const corridors = new Map<string, { from: string; to: string; n: number; max: number; amount: number }>();
    for (const t of txs) {
      if (t.ipCountry === t.shipping.country && (t.risk?.score ?? 0) < 60) continue;
      const k = `${t.ipCountry}>${t.shipping.country}`;
      const c = corridors.get(k) ?? { from: t.ipCountry, to: t.shipping.country, n: 0, max: 0, amount: 0 };
      c.n++;
      c.max = Math.max(c.max, t.risk?.score ?? 0);
      c.amount += t.amount;
      corridors.set(k, c);
    }
    return { countries: countries.size, crossBorder, intercepted, corridors: [...corridors.values()].sort((a, b) => b.max - a.max || b.n - a.n).slice(0, 5) };
  }, [txs]);
  const latest = txs[0];

  const storm = async () => {
    setErr(null);
    setStorming(true);
    try {
      await api("/simulate/storm", { size: 14 });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      window.setTimeout(() => setStorming(false), 9000);
    }
  };

  return (
    <section className={`panel globe-panel threat-${level.label.toLowerCase()}`}>
      <div className="globe-wrap">
        <Globe txs={txs} />
        <div className="globe-legend">
          <span><i style={{ background: `rgb(${GREEN})` }} />low risk</span>
          <span><i style={{ background: `rgb(${AMBER})` }} />review</span>
          <span><i style={{ background: `rgb(${RED})` }} />high risk</span>
          <span><i style={{ background: `rgb(${SKY})` }} />scoring…</span>
        </div>
        {latest && (
          <div className="globe-ticker" key={latest.id}>
            <b>{latest.id}</b> {latest.ipCountry} → {latest.shipping.country} · {usd(latest.amount)} ·{" "}
            {latest.risk ? <span style={{ color: `rgb(${colorFor(latest)})` }}>risk {latest.risk.score} · {latest.risk.action}</span> : <span className="muted">scoring…</span>}
          </div>
        )}
      </div>
      <div className="globe-side">
        <h2>Live threat globe</h2>
        <p className="muted small">Each payment flies from the buyer's real IP to the shipping address. Fraud crosses oceans; Argus intercepts it mid-flight.</p>
        <div className="threat">
          <Gauge {...level} />
          <div>
            <div className="threat-label" style={{ color: `rgb(${level.tone})` }}>{level.label}</div>
            <div className="muted small">threat index <b style={{ color: `rgb(${level.tone})` }}>{level.index}</b>/100 · last 15 min</div>
          </div>
        </div>
        <div className="globe-stats">
          <div><b>{stats.countries}</b><span>countries</span></div>
          <div><b>{stats.crossBorder}</b><span>cross-border</span></div>
          <div><b>{usd(stats.intercepted)}</b><span>intercepted</span></div>
        </div>
        <h3>Hot corridors</h3>
        {stats.corridors.length === 0 && <p className="empty small">No suspicious routes yet.</p>}
        <ul className="corridors">
          {stats.corridors.map((c) => (
            <li key={`${c.from}${c.to}`}>
              <span className="cc">{c.from}</span>
              <span className="corr-line" style={{ background: `linear-gradient(90deg, transparent, rgb(${c.max >= 60 ? RED : c.max >= 30 ? AMBER : SKY}))` }} />
              <span className="cc">{c.to}</span>
              <span className="muted small">{c.n}× · {usd(c.amount)}</span>
              <b style={{ color: `rgb(${c.max >= 60 ? RED : c.max >= 30 ? AMBER : SKY})` }}>{c.max || "–"}</b>
            </li>
          ))}
        </ul>
        <button className="primary storm" disabled={storming} onClick={storm}>
          {storming ? "🌪️ Storm incoming…" : "🌪️ Launch global attack storm"}
        </button>
        {err && <div className="small bad">{err}</div>}
      </div>
    </section>
  );
}
