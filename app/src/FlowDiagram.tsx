/** Hand-drawn SVG architecture diagram — orthogonal routing, no overlaps. */
export function FlowDiagram() {
  const P = '#7c5cff', T = '#4dd6c1', LINE = '#2c3850', TXT = '#e8edf6', MUT = '#8b96ab';
  const OK = '#3ecf8e', WARN = '#f5b83d', BAD = '#ff6b6b';
  const box = { fill: '#111621', stroke: LINE, rx: 12 } as const;

  return (
    <div className="flowsvg">
      <svg viewBox="0 0 960 704" role="img" aria-label="VeilGuard flow: encrypted mandates, TEE evaluation, three outcomes">
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={MUT} />
          </marker>
          <marker id="arrT" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={T} />
          </marker>
          <linearGradient id="teeg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgba(124,92,255,.16)" />
            <stop offset="1" stopColor="rgba(77,214,193,.07)" />
          </linearGradient>
        </defs>

        {/* ================= Row 1 — governance ================= */}
        <rect x="30" y="24" width="200" height="64" {...box} />
        <text x="130" y="50" textAnchor="middle" fill={TXT} fontSize="15" fontWeight="700">👔 Finance Admin</text>
        <text x="130" y="72" textAnchor="middle" fill={MUT} fontSize="11">proposes · can only tighten</text>

        <rect x="420" y="24" width="200" height="64" fill="#111621" stroke={P} strokeWidth="1.6" rx="12" />
        <text x="520" y="50" textAnchor="middle" fill={TXT} fontSize="15" fontWeight="700">🛡 VeilGuardModule</text>
        <text x="520" y="72" textAnchor="middle" fill={MUT} fontSize="11">Safe Module · holds escrow</text>

        <rect x="730" y="24" width="200" height="64" {...box} />
        <text x="830" y="50" textAnchor="middle" fill={TXT} fontSize="15" fontWeight="700">🔐 Safe multisig</text>
        <text x="830" y="72" textAnchor="middle" fill={MUT} fontSize="11">activates · approves · resumes</text>

        {/* Admin -> Module */}
        <line x1="230" y1="56" x2="414" y2="56" stroke={MUT} strokeWidth="1.4" markerEnd="url(#arr)" />
        <text x="322" y="46" textAnchor="middle" fill={T} fontSize="11.5" fontFamily="monospace">proposeMandate</text>
        <text x="322" y="74" textAnchor="middle" fill={MUT} fontSize="10.5">🔒 encrypted limits</text>

        {/* Safe -> Module */}
        <line x1="730" y1="56" x2="626" y2="56" stroke={MUT} strokeWidth="1.4" markerEnd="url(#arr)" />
        <text x="678" y="46" textAnchor="middle" fill={T} fontSize="11.5" fontFamily="monospace">activate</text>
        <text x="678" y="74" textAnchor="middle" fill={MUT} fontSize="10.5">a real Safe tx</text>

        {/* Module <-> TEE */}
        <line x1="520" y1="88" x2="520" y2="170" stroke={P} strokeWidth="1.4" strokeDasharray="4 4" />

        {/* Safe lends its balance handle (orthogonal, right side) */}
        <path d="M 830 88 L 830 300 L 708 300" fill="none" stroke={LINE} strokeWidth="1.3" strokeDasharray="5 4" markerEnd="url(#arr)" />
        <text x="822" y="182" textAnchor="end" fill={MUT} fontSize="10.5">lends its balance handle</text>
        <text x="822" y="197" textAnchor="end" fill={MUT} fontSize="10.5">transient access · same tx</text>

        {/* ================= TEE ================= */}
        <rect x="340" y="176" width="360" height="248" fill="url(#teeg)" stroke={P} strokeWidth="1.6" rx="16" />
        <text x="520" y="204" textAnchor="middle" fill={TXT} fontSize="14.5" fontWeight="700">⚙️ Nox TEE — computed on ciphertext</text>
        <text x="520" y="222" textAnchor="middle" fill={MUT} fontSize="10.5">nothing decrypted on-chain · select-only, no branches</text>

        {[
          ['budget check', 'safeSub(budget, amt)'],
          ['balance & reserve', 'vs the Safe’s real balance'],
          ['auto-limit check', 'le(amount, autoLimit)'],
          ['decision', 'nested select → 1·2·3'],
        ].map(([label, code], i) => (
          <g key={label}>
            <rect x="362" y={236 + i * 46} width="316" height="36" fill="#0e1320" stroke={LINE} rx="8" />
            <text x="376" y={259 + i * 46} fill={TXT} fontSize="12.5">{label}</text>
            <text x="664" y={259 + i * 46} textAnchor="end" fill={T} fontSize="10.5" fontFamily="monospace">{code}</text>
          </g>
        ))}

        {/* ================= Delegate ================= */}
        <rect x="30" y="280" width="200" height="64" {...box} />
        <text x="130" y="306" textAnchor="middle" fill={TXT} fontSize="15" fontWeight="700">🧑‍💼 Delegate</text>
        <text x="130" y="328" textAnchor="middle" fill={MUT} fontSize="11">never sees the policy</text>

        <line x1="230" y1="312" x2="334" y2="312" stroke={MUT} strokeWidth="1.4" markerEnd="url(#arr)" />
        <text x="282" y="300" textAnchor="middle" fill={T} fontSize="11.5" fontFamily="monospace">requestSpend</text>
        <text x="282" y="330" textAnchor="middle" fill={MUT} fontSize="10.5">🔒 amount</text>

        {/* ================= atomic escrow ================= */}
        <line x1="520" y1="424" x2="520" y2="446" stroke={T} strokeWidth="1.5" markerEnd="url(#arrT)" />
        <rect x="300" y="452" width="460" height="46" fill="rgba(77,214,193,.07)" stroke={T} rx="10" />
        <text x="530" y="471" textAnchor="middle" fill={TXT} fontSize="12.5" fontWeight="600">funds atomically reserved in the same transaction</text>
        <text x="530" y="487" textAnchor="middle" fill={MUT} fontSize="10.5">blocked ⇒ an encrypted zero moves — indistinguishable on-chain</text>

        {/* anyone finalizes */}
        <rect x="30" y="452" width="200" height="46" {...box} />
        <text x="130" y="471" textAnchor="middle" fill={TXT} fontSize="12.5" fontWeight="700">🤖 anyone — untrusted</text>
        <text x="130" y="488" textAnchor="middle" fill={T} fontSize="10.5" fontFamily="monospace">submits finalize(proof)</text>
        <line x1="230" y1="475" x2="294" y2="475" stroke={MUT} strokeWidth="1.4" markerEnd="url(#arr)" />

        {/* ================= three outcomes ================= */}
        <line x1="520" y1="498" x2="520" y2="522" stroke={MUT} strokeWidth="1.4" />
        <line x1="170" y1="522" x2="845" y2="522" stroke={MUT} strokeWidth="1.2" />
        {[
          { x: 170, w: 220, c: OK, t: 'WITHIN MANDATE', s: 'instant confidential payout' },
          { x: 520, w: 220, c: WARN, t: 'APPROVAL REQUIRED', s: 'escrow waits for the Safe multisig' },
          { x: 845, w: 210, c: BAD, t: 'BLOCKED', s: 'nothing moves · reason stays private' },
        ].map(({ x, w, c, t, s }) => (
          <g key={t}>
            <line x1={x} y1="522" x2={x} y2="540" stroke={MUT} strokeWidth="1.2" markerEnd="url(#arr)" />
            <rect x={x - w / 2} y="544" width={w} height="58" fill="#111621" stroke={c} strokeWidth="1.5" rx="12" />
            <text x={x} y="568" textAnchor="middle" fill={c} fontSize="13.5" fontWeight="800" fontFamily="monospace">{t}</text>
            <text x={x} y="588" textAnchor="middle" fill={MUT} fontSize="10.8">{s}</text>
          </g>
        ))}

        {/* ================= auditor ================= */}
        <line x1="520" y1="602" x2="520" y2="630" stroke={MUT} strokeWidth="1.3" strokeDasharray="5 4" markerEnd="url(#arr)" />
        <rect x="340" y="636" width="360" height="52" {...box} />
        <text x="520" y="657" textAnchor="middle" fill={TXT} fontSize="13" fontWeight="700">🕵️ Auditor</text>
        <text x="520" y="675" textAnchor="middle" fill={MUT} fontSize="10.8">scoped immutable snapshots — never live state, never future versions</text>
      </svg>
    </div>
  );
}
