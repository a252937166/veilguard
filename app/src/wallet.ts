/**
 * Multi-wallet discovery (EIP-6963) with a legacy `window.ethereum` fallback.
 * Detects every injected wallet (MetaMask, OKX, Rabby, Coinbase, Trust, …),
 * exposes their real name + icon, and lets the app connect to a SPECIFIC one
 * rather than assuming `window.ethereum` is MetaMask.
 */
export type Eip1193Provider = {
  request: (args: { method: string; params?: any[] | object }) => Promise<any>;
  on?: (event: string, cb: (...a: any[]) => void) => void;
  removeListener?: (event: string, cb: (...a: any[]) => void) => void;
};

export type WalletInfo = {
  uuid: string;
  name: string;
  icon: string; // data URI or url
  rdns?: string;
  provider: Eip1193Provider;
};

const KNOWN_ICONS: Record<string, string> = {
  metamask: '🦊',
  okx: '⬛',
  rabby: '🐰',
  coinbase: '🔵',
  trust: '🛡️',
  brave: '🦁',
  rainbow: '🌈',
  phantom: '👻',
};

function fallbackEmoji(name: string): string {
  const k = name.toLowerCase();
  for (const key in KNOWN_ICONS) if (k.includes(key)) return KNOWN_ICONS[key];
  return '👛';
}

/** Detect legacy injected wallets when a provider does not emit EIP-6963. */
function legacyWallets(): WalletInfo[] {
  const eth = (window as any).ethereum;
  if (!eth) return [];
  const providers: any[] = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
  const out: WalletInfo[] = [];
  const seen = new Set<string>();
  const identify = (p: any): { name: string; key: string } => {
    if (p.isOkxWallet || p.isOKExWallet || (window as any).okxwallet === p) return { name: 'OKX Wallet', key: 'okx' };
    if (p.isRabby) return { name: 'Rabby', key: 'rabby' };
    if (p.isCoinbaseWallet || p.isCoinbaseBrowser) return { name: 'Coinbase Wallet', key: 'coinbase' };
    if (p.isTrust || p.isTrustWallet) return { name: 'Trust Wallet', key: 'trust' };
    if (p.isBraveWallet) return { name: 'Brave Wallet', key: 'brave' };
    if (p.isRainbow) return { name: 'Rainbow', key: 'rainbow' };
    if (p.isPhantom) return { name: 'Phantom', key: 'phantom' };
    if (p.isMetaMask) return { name: 'MetaMask', key: 'metamask' };
    return { name: 'Injected Wallet', key: 'injected' };
  };
  for (const p of providers) {
    const { name, key } = identify(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ uuid: `legacy:${key}`, name, icon: fallbackEmoji(name), provider: p });
  }
  return out;
}

const discovered = new Map<string, WalletInfo>();
let started = false;

function startDiscovery() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('eip6963:announceProvider', (e: any) => {
    const { info, provider } = e.detail;
    discovered.set(info.uuid, { uuid: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns, provider });
    listeners.forEach((l) => l());
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

const listeners = new Set<() => void>();
export function onWalletsChanged(cb: () => void): () => void {
  startDiscovery();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** All detected wallets (EIP-6963 first, then any legacy ones not already seen). */
export function listWallets(): WalletInfo[] {
  startDiscovery();
  const byRdns = new Set([...discovered.values()].map((w) => w.rdns).filter(Boolean));
  const eip = [...discovered.values()];
  const legacy = legacyWallets().filter((w) => {
    // avoid duplicating a wallet already announced via EIP-6963
    const nm = w.name.toLowerCase();
    return ![...byRdns].some((r) => r!.toLowerCase().includes(nm.split(' ')[0]))
      && !eip.some((e) => e.name.toLowerCase().includes(nm.split(' ')[0]));
  });
  return [...eip, ...legacy].sort((a, b) => a.name.localeCompare(b.name));
}

export function walletByUuid(uuid: string): WalletInfo | undefined {
  return listWallets().find((w) => w.uuid === uuid);
}

export const isEmojiIcon = (icon: string) => !icon.startsWith('data:') && !icon.startsWith('http');
