/** Brand lockup: the real shield artwork + the VeilGuard wordmark
 *  (Veil in light, Guard in the purple→blue gradient, matching the logo). */
export function Logo({ wordmark = true, className = '' }: { wordmark?: boolean; className?: string }) {
  return (
    <span className={`brand ${className}`}>
      <img src="/shield.png" alt="" aria-hidden="true" className="brand-shield" />
      {wordmark && (
        <span className="brand-word">Veil<span className="brand-guard">Guard</span></span>
      )}
    </span>
  );
}
