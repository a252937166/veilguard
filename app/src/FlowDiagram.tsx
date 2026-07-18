/** Hand-drawn SVG architecture/flow diagram for the landing page. */
export function FlowDiagram() {
  const P = '#7c5cff', T = '#4dd6c1', LINE = '#2c3850', TXT = '#e8edf6', MUT = '#8b96ab';
  const OK = '#3ecf8e', WARN = '#f5b83d', BAD = '#ff6b6b';
  const box = { fill: '#111621', stroke: LINE, rx: 12 } as const;

  return (
    <div className="flowsvg">
      <svg viewBox="0 0 960 620" role="img" aria-label="VeilGuard flow: encrypted mandates, TEE evaluation, three outcomes">
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

        {/* ---- Row 1: governance ---- */}
        <rect x="30" y="24" width="200" height="64" {...box} />
        <text x="130" y="50" textAnchor="middle" fill={TXT} fontSize="15" fontWeight="700">👔 Finance Admin</text>
        <text x="130" y="72" textAnchor="middle" fill={MUT} fontSize="11.5">proposes · can only tighten</text>

        <rect x="380" y="24" width="200" height="64" fill="#111621" stroke={P} strokeWidth="1.6" rx="12" />
        <text x="480" y="50" textAnchor="middle" fill={TXT} fontSize="15" fontWeight="700">🛡 VeilGuardModule</text>
        <text x="480" y="72" textAnchor="middle" fill={MUT} fontSize="11.5">Safe Module · holds escrow</text>

        <rect x="730" y="24" width="200" height="64" {...box} />
        <text x="830" y="50" textAnchor="middle" fill={TXT} fontSize="15" fontWeight="700">🔐 Safe multisig</text>
        <text x="830" y="72" textAnchor="middle" fill={MUT} fontSize="11.5">activates · approves · resumes</text>

        <line x1="230" y1="56" x2="374" y2="56" stroke={MUT} strokeWidth="1.4" markerEnd="url(#arr)" />
        <text x="302" y="46" textAnchor="middle" fill={T} fontSize="11.5" fontFamily="monospace">proposeMandate(🔒 limits)</text>
        <line x1="730" y1="56" x2="586" y2="56" stroke={MUT} strokeWidth="1.4" markerEnd="url(#arr)" />
        <text x="658" y="46" textAnchor="middle" fill={T} fontSize="11.5" fontFamily="monospace">activateMandate()</text>

        {/* ---- Delegate + request ---- */}
        <rect x="30" y="176" width="200" height="64" {...box} />
        <text x="130" y="202" textAnchor="middle" fill={TXT} fontSize="15" fontWeight="700">🧑‍💼 Delegate</text>
        <text x="130" y="224" textAnchor="middle" fill={MUT} fontSize="11.5">never sees the policy</text>

        <line x1="230" y1="208" x2="294" y2="208" stroke={MUT} strokeWidth="1.4" markerEnd="url(#arr)" />
        <text x="262" y="196" textAnchor="middle" fill={T} fontSize="11.5" fontFamily="monospace">requestSpend</text>
        <text x="262" y="224" textAnchor="middle" fill={MUT} fontSize="10.5">🔒 encrypted amount</text>

        {/* ---- TEE box ---- */}
        <rect x="300" y="128" width="360" height="220" fill="url(#teeg)" stroke={P} strokeWidth="1.6" rx="16" />
        <text x="480" y="156" textAnchor="middle" fill={TXT} fontSize="14.5" fontWeight="700">⚙️ Nox TEE — computed on ciphertext</text>
        <text x="480" y="175" textAnchor="middle" fill={MUT} fontSize="11">nothing decrypted on-chain · select-only, no branches</text>

        {[
          ['budget check', 'safeSub(budget, amount)'],
          ['balance + reserve check', 'vs the Safe’s real confidential balance'],
          ['auto-limit check', 'le(amount, autoLimit)'],
          ['decision', 'nested select → 1 · 2 · 3'],
        ].map(([label, code], i) => (
          <g key={label}>
            <rect x="322" y={188 + i * 36} width="316" height="28" fill="#0e1320" stroke={LINE} rx="7" />
            <text x="336" y={206 + i * 36} fill={TXT} fontSize="12">{label}</text>
            <text x="626" y={206 + i * 36} textAnchor="end" fill={T} fontSize="10.5" fontFamily="monospace">{code}</text>
          </g>
        ))}

        {/* Safe lends balance handle */}
        <path d="M 830 88 C 830 130 700 130 662 160" fill="none" stroke={LINE} strokeWidth="1.3" strokeDasharray="5 4" markerEnd="url(#arr)" />
        <text x="805" y="126" textAnchor="middle" fill={MUT} fontSize="10.5">lends its balance handle</text>
        <text x="805" y="140" textAnchor="middle" fill={MUT} fontSize="10.5">(transient access, same tx)</text>

        {/* module ↕ TEE link */}
        <line x1="480" y1="88" x2="480" y2="122" stroke={P} strokeWidth="1.4" strokeDasharray="4 4" />

        {/* ---- atomic escrow bar ---- */}
        <rect x="240" y="372" width="480" height="40" fill="rgba(77,214,193,.07)" stroke={T} rx="10" />
        <text x="480" y="392" textAnchor="middle" fill={TXT} fontSize="12.5" fontWeight="600">funds atomically reserved in the same transaction</text>
        <text x="480" y="406" textAnchor="middle" fill={MUT} fontSize="10.5">blocked ⇒ an encrypted zero moves — indistinguishable on-chain</text>
        <line x1="480" y1="348" x2="480" y2="366" stroke={T} strokeWidth="1.5" markerEnd="url(#arrT)" />

        {/* ---- finalize ---- */}
        <rect x="30" y="372" width="150" height="40" {...box} />
        <text x="105" y="392" textAnchor="middle" fill={TXT} fontSize="12.5" fontWeight="600">🤖 anyone</text>
        <text x="105" y="406" textAnchor="middle" fill={MUT} fontSize="10.5">keeper or user — untrusted</text>
        <line x1="180" y1="392" x2="234" y2="392" stroke={MUT} strokeWidth="1.4" markerEnd="url(#arr)" />
        <text x="207" y="382" textAnchor="middle" fill={T} fontSize="10.5" fontFamily="monospace">finalize(proof)</text>

        {/* ---- three outcomes ---- */}
        <line x1="480" y1="412" x2="480" y2="438" stroke={MUT} strokeWidth="1.4" />
        <line x1="180" y1="438" x2="780" y2="438" stroke={MUT} strokeWidth="1.2" />
        {[
          { x: 105, c: OK, t: 'WITHIN MANDATE', s: 'instant confidential payout' },
          { x: 480, c: WARN, t: 'APPROVAL REQUIRED', s: 'escrow waits for the Safe multisig' },
          { x: 855, c: BAD, t: 'BLOCKED', s: 'nothing moves · reason stays private' },
        ].map(({ x, c, t, s }) => (
          <g key={t}>
            <line x1={x} y1="438" x2={x} y2="456" stroke={MUT} strokeWidth="1.2" markerEnd="url(#arr)" />
            <rect x={x - 105} y="460" width="210" height="58" fill="#111621" stroke={c} strokeWidth="1.5" rx="12" />
            <text x={x} y="484" textAnchor="middle" fill={c} fontSize="13.5" fontWeight="800" fontFamily="monospace">{t}</text>
            <text x={x} y="504" textAnchor="middle" fill={MUT} fontSize="10.8">{s}</text>
          </g>
        ))}

        {/* ---- auditor ---- */}
        <rect x="310" y="556" width="340" height="48" {...box} />
        <text x="480" y="576" textAnchor="middle" fill={TXT} fontSize="13" fontWeight="700">🕵️ Auditor</text>
        <text x="480" y="593" textAnchor="middle" fill={MUT} fontSize="10.8">scoped immutable snapshots — never live state, never future versions</text>
        <line x1="480" y1="518" x2="480" y2="550" stroke={MUT} strokeWidth="1.3" strokeDasharray="5 4" markerEnd="url(#arr)" />
      </svg>
    </div>
  );
}
