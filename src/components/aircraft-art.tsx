export function AircraftArt({
  business = false,
  compact = false,
}: {
  business?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={`aircraft-art ${business ? "art-business" : ""} ${compact ? "art-compact" : ""}`}
      aria-hidden="true"
    >
      <svg aria-hidden="true" viewBox="0 0 500 200" fill="none">
        <defs>
          <linearGradient
            id={business ? "jet-fill" : "airliner-fill"}
            x1="220"
            y1="65"
            x2="220"
            y2="138"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#fff" />
            <stop offset=".65" stopColor="#e1e7e5" />
            <stop offset="1" stopColor="#afbfbd" />
          </linearGradient>
        </defs>
        <path
          d="M40 164H460M105 35V180M205 35V180M305 35V180M405 35V180"
          stroke="currentColor"
          opacity=".09"
          strokeDasharray="3 5"
        />
        <ellipse cx="247" cy="158" rx="170" ry="7" fill="#263b3c" opacity=".09" />
        <g transform={business ? "translate(25 12) scale(.9)" : ""}>
          <path
            d="M71 106L34 50L54 48L111 100L387 100C411 100 438 108 456 120C460 123 458 128 451 129L95 131L60 124L71 106Z"
            fill={`url(#${business ? "jet-fill" : "airliner-fill"})`}
            stroke="#9fafad"
            strokeWidth="1.3"
          />
          <path d="M206 107L159 58L182 59L279 110L206 107Z" fill="#c8d5d3" stroke="#9fafad" />
          <path d="M230 121L170 169L193 169L307 121" fill="#e2eae7" stroke="#9fafad" />
          <path d="M74 106L56 87L73 88L121 112" fill="#d2ddda" stroke="#9fafad" />
          <path d="M96 121H424" stroke="#e76c3b" strokeWidth="3" />
          <path d="M110 111H370" stroke="#829a99" strokeWidth="3" strokeDasharray="4 7" />
          <path d="M398 108L415 109L427 115H399Z" fill="#3d5859" />
          <path d="M234 131H266V141C252 147 240 145 234 139Z" fill="#a6b9b7" stroke="#90a6a3" />
          <path d="M374 129V145M139 132V145" stroke="#8da29e" strokeWidth="3" />
          <circle cx="375" cy="147" r="5" fill="#536868" />
          <circle cx="140" cy="147" r="5" fill="#536868" />
        </g>
      </svg>
    </div>
  );
}
