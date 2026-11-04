/**
 * White line-art for the hero: a wireframe PayPal-style card wired through
 * a circuit to a glowing shield, with data pulses running along the traces
 * and a token orbiting the shield.
 */
export function HeroArt() {
  return (
    <svg className="hero-art" viewBox="0 0 320 230" role="img" aria-label="A payment card protected by the Argus shield">
      <defs>
        <linearGradient id="ha-card" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id="ha-shield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#cfe9ff" stopOpacity="0.75" />
        </linearGradient>
        <filter id="ha-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <path id="ha-orbit" d="M232 118 m-62 0 a62 22 0 1 0 124 0 a62 22 0 1 0 -124 0" />
      </defs>

      {/* faint dotted grid */}
      <g opacity="0.25">
        {Array.from({ length: 8 }, (_, r) =>
          Array.from({ length: 12 }, (_, c) => <circle key={`${r}-${c}`} cx={10 + c * 27} cy={12 + r * 29} r="0.9" fill="#fff" />),
        )}
      </g>

      {/* circuit traces from card to shield */}
      <g fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" opacity="0.7">
        <path id="ha-t1" d="M136 86 H170 L184 72 H206" />
        <path id="ha-t2" d="M136 112 H200" />
        <path id="ha-t3" d="M136 138 H168 L182 152 H206" />
      </g>
      <g className="ha-pulse" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" filter="url(#ha-glow)">
        <path d="M136 86 H170 L184 72 H206" />
        <path d="M136 112 H200" style={{ animationDelay: "-0.6s" }} />
        <path d="M136 138 H168 L182 152 H206" style={{ animationDelay: "-1.2s" }} />
      </g>
      {[[136, 86], [136, 112], [136, 138], [206, 72], [206, 152]].map(([x, y]) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r="3" fill="#0b4fb8" stroke="#fff" strokeWidth="1.4" />
      ))}

      {/* wireframe card, tilted */}
      <g className="ha-card" transform="translate(14 54) skewY(-6)">
        <rect width="124" height="80" rx="10" fill="url(#ha-card)" stroke="#fff" strokeWidth="1.6" />
        <rect x="12" y="22" width="22" height="16" rx="3" fill="none" stroke="#fff" strokeWidth="1.3" />
        <path d="M17 22v16M23 22v16M12 30h22" stroke="#fff" strokeWidth="0.8" opacity="0.8" />
        <g fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round">
          <path d="M44 26a6 6 0 0 1 0 8" />
          <path d="M48 23a10 10 0 0 1 0 14" opacity="0.7" />
          <path d="M52 20a14 14 0 0 1 0 20" opacity="0.45" />
        </g>
        <text x="12" y="60" fill="#fff" fontSize="10" fontFamily="JetBrains Mono, monospace" letterSpacing="1.5">•••• •••• 4242</text>
        <text x="12" y="72" fill="#fff" fontSize="6.5" fontFamily="JetBrains Mono, monospace" opacity="0.75" letterSpacing="1">PAYPAL · GUARDED</text>
        <text x="96" y="16" fill="#fff" fontSize="9" fontWeight="700" fontFamily="Sora, Inter, sans-serif" fontStyle="italic">P</text>
      </g>

      {/* orbit behind the shield */}
      <use href="#ha-orbit" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="3 5" />

      {/* shield */}
      <g filter="url(#ha-glow)">
        <path d="M232 62 262 74v24c0 21-13 36-30 42-17-6-30-21-30-42V74z" fill="url(#ha-shield)" stroke="#fff" strokeWidth="2" />
        <path d="M218 101l10 10 19-21" fill="none" stroke="#0b4fb8" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <circle r="4" fill="#fff" filter="url(#ha-glow)">
        <animateMotion dur="6s" repeatCount="indefinite">
          <mpath href="#ha-orbit" />
        </animateMotion>
      </circle>

      {/* status tags */}
      <g fontFamily="JetBrains Mono, monospace" fontSize="8" fill="#fff">
        <g className="ha-tag" transform="translate(196 170)">
          <rect width="104" height="18" rx="9" fill="rgba(255,255,255,0.16)" stroke="#fff" strokeOpacity="0.7" />
          <circle cx="11" cy="9" r="3" fill="#19ffb0" />
          <text x="20" y="12">ED25519 SIGNED</text>
        </g>
        <g className="ha-tag" transform="translate(30 168)" style={{ animationDelay: "-2s" }}>
          <rect width="118" height="18" rx="9" fill="rgba(255,255,255,0.16)" stroke="#fff" strokeOpacity="0.7" />
          <circle cx="11" cy="9" r="3" fill="#00e5ff" />
          <text x="20" y="12">AI RISK SCORE · LIVE</text>
        </g>
        <g className="ha-tag" transform="translate(196 22)" style={{ animationDelay: "-4s" }}>
          <rect width="96" height="18" rx="9" fill="rgba(255,255,255,0.16)" stroke="#fff" strokeOpacity="0.7" />
          <circle cx="11" cy="9" r="3" fill="#ffd23f" />
          <text x="20" y="12">HUMAN ON LEASH</text>
        </g>
      </g>
    </svg>
  );
}
