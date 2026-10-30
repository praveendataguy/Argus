import { useEffect, useRef } from "react";

/**
 * Animated background that shows what Argus does: a drifting payment network
 * (the identity graph), PayPal payments flowing between accounts, fraud
 * packets being intercepted by a shield pulse, radar scans, and the audit
 * log's hash chain scrolling past. Canvas 2D, throttled when the tab is hidden,
 * and a single still frame for people who prefer reduced motion.
 */

interface Node { x: number; y: number; vx: number; vy: number; r: number; ring: boolean }
interface Packet { a: number; b: number; t: number; speed: number; fraud: boolean; dead: boolean }
interface Burst { x: number; y: number; age: number; kind: "block" | "scan" }
interface Hash { x: number; y: number; text: string; speed: number; alpha: number }

const YELLOW = "255,196,57";
const RED = "255,77,109";
const SKY = "0,156,222";
const hex = () => Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

export function Backdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let nodes: Node[] = [];
    let packets: Packet[] = [];
    let bursts: Burst[] = [];
    let hashes: Hash[] = [];
    let raf = 0;
    let last = performance.now();

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(110, Math.max(30, (w * h) / 15000)));
      nodes = Array.from({ length: count }, (_, i) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.12,
        vy: (Math.random() - 0.5) * 0.12,
        r: 1.4 + Math.random() * 2.2,
        ring: i % 7 === 0,
      }));
      hashes = Array.from({ length: Math.round(w / 140) }, () => ({ x: Math.random() * w, y: Math.random() * h, text: `${hex()}…${hex().slice(0, 4)}`, speed: 0.08 + Math.random() * 0.12, alpha: 0.07 + Math.random() * 0.08 }));
    };

    const LINK = 190;
    const neighbours = (i: number) => {
      const out: number[] = [];
      for (let j = 0; j < nodes.length; j++) if (j !== i && Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < LINK) out.push(j);
      return out;
    };

    const spawn = () => {
      const a = Math.floor(Math.random() * nodes.length);
      const ns = neighbours(a);
      if (!ns.length) return;
      const fraud = Math.random() < 0.18;
      packets.push({ a, b: ns[Math.floor(Math.random() * ns.length)], t: 0, speed: 0.004 + Math.random() * 0.006, fraud, dead: false });
    };

    const frame = (now: number) => {
      const dt = Math.min(50, now - last) / 16.7;
      last = now;
      ctx.clearRect(0, 0, w, h);

      // audit-log hash chain drifting upward
      ctx.font = '11px "JetBrains Mono", monospace';
      for (const s of hashes) {
        s.y -= s.speed * dt;
        if (s.y < -20) Object.assign(s, { y: h + 20, x: Math.random() * w, text: `${hex()}…${hex().slice(0, 4)}` });
        ctx.fillStyle = `rgba(${YELLOW},${s.alpha})`;
        ctx.fillText(s.text, s.x, s.y);
      }

      // nodes drift
      for (const n of nodes) {
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        if (n.x < -20) n.x = w + 20;
        if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        if (n.y > h + 20) n.y = -20;
      }

      // links: the identity / payment graph
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++) {
          const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
          if (d < LINK) {
            ctx.strokeStyle = `rgba(255,255,255,${0.13 * (1 - d / LINK)})`;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }

      // packets: payments (yellow) and fraud attempts (red, intercepted mid-flight)
      if (Math.random() < 0.16 * dt && packets.length < 70) spawn();
      for (const p of packets) {
        p.t += p.speed * dt;
        const A = nodes[p.a];
        const B = nodes[p.b];
        const x = A.x + (B.x - A.x) * p.t;
        const y = A.y + (B.y - A.y) * p.t;
        if (p.fraud && p.t > 0.55) {
          bursts.push({ x, y, age: 0, kind: "block" });
          p.dead = true;
          continue;
        }
        if (p.t >= 1) {
          p.dead = true;
          continue;
        }
        const c = p.fraud ? RED : YELLOW;
        const tail = 0.06;
        const tx = A.x + (B.x - A.x) * Math.max(0, p.t - tail);
        const ty = A.y + (B.y - A.y) * Math.max(0, p.t - tail);
        const g = ctx.createLinearGradient(tx, ty, x, y);
        g.addColorStop(0, `rgba(${c},0)`);
        g.addColorStop(1, `rgba(${c},0.8)`);
        ctx.strokeStyle = g;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = `rgba(${c},0.95)`;
        ctx.shadowColor = `rgba(${c},0.9)`;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      packets = packets.filter((p) => !p.dead);

      // occasional radar scan from a node
      if (Math.random() < 0.006 * dt) {
        const n = nodes[Math.floor(Math.random() * nodes.length)];
        bursts.push({ x: n.x, y: n.y, age: 0, kind: "scan" });
      }

      // bursts: shield block (red ring + cross) and radar scan (sky ring)
      for (const b of bursts) {
        b.age += dt;
        const life = b.kind === "block" ? 50 : 90;
        const k = b.age / life;
        const alpha = Math.max(0, 1 - k);
        const r = b.kind === "block" ? 4 + k * 26 : 6 + k * 90;
        ctx.strokeStyle = b.kind === "block" ? `rgba(${RED},${0.7 * alpha})` : `rgba(${SKY},${0.35 * alpha})`;
        ctx.lineWidth = b.kind === "block" ? 2 : 1.2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.stroke();
        if (b.kind === "block" && k < 0.6) {
          const s = 4;
          ctx.strokeStyle = `rgba(${RED},${alpha})`;
          ctx.beginPath();
          ctx.moveTo(b.x - s, b.y - s);
          ctx.lineTo(b.x + s, b.y + s);
          ctx.moveTo(b.x + s, b.y - s);
          ctx.lineTo(b.x - s, b.y + s);
          ctx.stroke();
        }
      }
      bursts = bursts.filter((b) => b.age < (b.kind === "block" ? 50 : 90));

      // nodes on top; ring members pulse in yellow
      for (const n of nodes) {
        const pulse = n.ring ? 0.5 + 0.5 * Math.sin(now / 600 + n.x) : 0;
        ctx.fillStyle = n.ring ? `rgba(${YELLOW},${0.5 + 0.4 * pulse})` : "rgba(255,255,255,0.5)";
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + (n.ring ? 1 + pulse : 0), 0, Math.PI * 2);
        ctx.fill();
        if (n.ring) {
          ctx.strokeStyle = `rgba(${YELLOW},${0.15 + 0.2 * pulse})`;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 6 + pulse * 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      if (!still) raf = requestAnimationFrame(frame);
    };

    resize();
    if (still) {
      for (let i = 0; i < 12; i++) spawn();
      packets.forEach((p) => (p.t = Math.random() * 0.5));
    }
    raf = requestAnimationFrame(frame);

    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={ref} className="backdrop" aria-hidden />;
}
