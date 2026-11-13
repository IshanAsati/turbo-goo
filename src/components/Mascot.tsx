/** "Goo", TurboGoo's mascot: an original little violet blob with a lightning-bolt tuft and a yellow book. */
export type MascotMood = "reading" | "thinking" | "cheer";

export function Mascot({ size = 120, mood = "reading", className = "" }: { size?: number; mood?: MascotMood; className?: string }) {
  const looking = mood === "reading" ? 6 : mood === "thinking" ? -4 : 0; // pupils glance toward the book, or up while thinking
  return (
    <svg className={"mascot " + className} width={size} height={size} viewBox="0 0 120 120" role="img" aria-label="Goo, the TurboGoo mascot" fill="none" style={{ overflow: "visible" }}>
      <ellipse cx="60" cy="112" rx="34" ry="5" fill="#000" opacity=".22" />
      {/* body */}
      <path d="M60 18c-22 0-37 17-37 40 0 22 12 40 37 40s37-18 37-40c0-23-15-40-37-40Z" fill="#8b6bf0" />
      <path d="M26 66c3 20 15 32 34 32s31-12 34-32c-6 12-18 20-34 20S32 78 26 66Z" fill="#6d4fd8" opacity=".55" />
      <ellipse cx="46" cy="34" rx="12" ry="7" fill="#fff" opacity=".18" transform="rotate(-20 46 34)" />
      {/* lightning tuft */}
      <path d="M62 4 50 24h9l-5 14 16-22h-10l7-12Z" fill="#ffd54a" stroke="#e0a800" strokeWidth="1.5" strokeLinejoin="round" />
      {/* eyes */}
      <circle cx="46" cy="56" r="10" fill="#fff" />
      <circle cx="74" cy="56" r="10" fill="#fff" />
      <circle cx={47 + looking * 0.4} cy={58 + (mood === "thinking" ? -3 : 3)} r="5" fill="#2a1d5c" />
      <circle cx={75 + looking * 0.4} cy={58 + (mood === "thinking" ? -3 : 3)} r="5" fill="#2a1d5c" />
      <circle cx={49 + looking * 0.4} cy={56 + (mood === "thinking" ? -3 : 3)} r="1.6" fill="#fff" />
      <circle cx={77 + looking * 0.4} cy={56 + (mood === "thinking" ? -3 : 3)} r="1.6" fill="#fff" />
      <circle cx="35" cy="70" r="4" fill="#ff8fb1" opacity=".55" />
      <circle cx="85" cy="70" r="4" fill="#ff8fb1" opacity=".55" />
      {mood === "cheer" ? <path d="M50 72c3 8 17 8 20 0Z" fill="#2a1d5c" /> : <path d="M52 73c4 5 12 5 16 0" stroke="#2a1d5c" strokeWidth="3" strokeLinecap="round" />}
      {/* book */}
      {mood !== "cheer" && (
        <g transform="rotate(-6 60 94)">
          <rect x="34" y="82" width="52" height="30" rx="5" fill="#f4b73c" />
          <rect x="38" y="86" width="22" height="22" rx="2" fill="#fff6dc" />
          <rect x="62" y="86" width="20" height="22" rx="2" fill="#fff6dc" />
          <path d="M42 93h14M42 98h14M66 93h12M66 98h12" stroke="#e0a800" strokeWidth="2" strokeLinecap="round" />
        </g>
      )}
      {mood === "cheer" && (
        <g>
          <path d="M24 66c-10-6-12-18-10-26M96 66c10-6 12-18 10-26" stroke="#8b6bf0" strokeWidth="9" strokeLinecap="round" />
          <path d="M14 30l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5ZM106 24l2 4 4 2-4 2-2 4-2-4-4-2 4-2 2-4Z" fill="#ffd54a" />
        </g>
      )}
      {mood === "thinking" && (
        <g>
          <circle cx="98" cy="22" r="3" fill="#fff" opacity=".8" />
          <circle cx="104" cy="14" r="4.5" fill="#fff" opacity=".9" />
          <ellipse cx="108" cy="2" rx="11" ry="9" fill="#fff" opacity=".95" />
          <path d="M108 -2a3.2 3.2 0 0 1 2 5.8V6h-4v-.2A3.2 3.2 0 0 1 108-2Z" fill="#ffd54a" />
        </g>
      )}
    </svg>
  );
}
