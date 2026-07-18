import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'overview' | 'payments' | 'policies' | 'approvals' | 'disclosure'
  | 'audit' | 'verify' | 'contracts' | 'provenance' | 'funds'
  | 'role' | 'tour' | 'wallet' | 'close' | 'chevron';

const paths: Record<IconName, ReactNode> = {
  overview: <><rect x="4" y="4" width="6" height="7" rx="1" /><rect x="14" y="4" width="6" height="4" rx="1" /><rect x="14" y="12" width="6" height="8" rx="1" /><rect x="4" y="15" width="6" height="5" rx="1" /></>,
  payments: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h3" /></>,
  policies: <><path d="M12 3 5 6v5c0 4.8 2.9 8.1 7 10 4.1-1.9 7-5.2 7-10V6l-7-3Z" /><path d="m9.5 12 1.7 1.7 3.8-4" /></>,
  approvals: <><path d="M7 12.5 10.2 16 17 8.5" /><rect x="3" y="3" width="18" height="18" rx="3" /></>,
  disclosure: <><path d="M4 7h16v13H4zM8 7V4h8v3" /><path d="M8 12h8M8 16h5" /></>,
  audit: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4M11 8v6M8 11h6" /></>,
  verify: <><path d="M4 12 9 17 20 6" /><path d="M4 5h8M4 19h8" /></>,
  contracts: <><path d="M7 3h8l4 4v14H7z" /><path d="M15 3v5h5M10 13h6M10 17h6" /></>,
  provenance: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="m7.7 7.1 3.2 8.8M16.3 7.1l-3.2 8.8M8 6h8" /></>,
  funds: <><path d="M12 3v18M17 7.5c0-1.7-1.8-3-5-3s-5 1.3-5 3 1.8 2.8 5 3 5 1.3 5 3-1.8 3-5 3-5-1.3-5-3" /></>,
  role: <><circle cx="12" cy="8" r="4" /><path d="M4 21c.7-4.3 3.4-6.5 8-6.5s7.3 2.2 8 6.5" /></>,
  tour: <><path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></>,
  wallet: <><path d="M4 6h15a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h13" /><path d="M16 11h5v4h-5a2 2 0 0 1 0-4Z" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevron: <path d="m9 18 6-6-6-6" />,
};

export function Icon({ name, size = 18, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
