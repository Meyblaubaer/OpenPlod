export function Brand({ compact = false }: { compact?: boolean }) {
  // A plain div may not carry aria-label (axe aria-prohibited-attr); the name comes from the
  // wordmark text, or from the mark's alt text when the wordmark is hidden.
  return (
    <div className="brand">
      <img src="/openplod-mark.svg" className="brand-mark" width="30" height="30" alt={compact ? 'OpenPlod' : ''} aria-hidden={compact ? undefined : true} />
      {!compact && (
        <span className="brand-wordmark">
          Open<span>Plod</span>
        </span>
      )}
    </div>
  )
}
