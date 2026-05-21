/**
 * RedirectWithQuery — wrapper around <Navigate> that preserves the
 * incoming `?query=string` when forwarding to a new path. React
 * Router's plain <Navigate to="/new/path"> drops the search params,
 * which breaks bookmarked URLs that pinned a sub-tab (e.g.
 * `/settings/security-hardening?tab=waf` → operator runbooks reference
 * these exact links).
 *
 * Use for every URL move where the SAME `?tab=X` should land on the
 * same conceptual sub-area at the new URL. If the new page's tab
 * vocabulary differs from the old, do the renaming at the call site
 * (this component is pure forward).
 */
import { Navigate, useLocation } from 'react-router-dom';

export interface RedirectWithQueryProps {
  readonly to: string;
  readonly replace?: boolean;
}

export default function RedirectWithQuery({ to, replace = true }: RedirectWithQueryProps) {
  const { search: incomingSearch } = useLocation();
  // Merge the incoming search params over any params already on `to`.
  // Naive string concatenation `${to}${search}` produces `/p?a=1?b=2`
  // if `to` already has a `?`, and silently drops collisions. Using
  // URLSearchParams gives us correct merging semantics.
  const [path, existing] = to.split('?');
  const merged = new URLSearchParams(existing ?? '');
  if (incomingSearch) {
    const incoming = new URLSearchParams(incomingSearch.startsWith('?')
      ? incomingSearch.slice(1)
      : incomingSearch);
    for (const [k, v] of incoming) merged.set(k, v);
  }
  const finalSearch = merged.toString();
  return <Navigate to={finalSearch ? `${path}?${finalSearch}` : path} replace={replace} />;
}
