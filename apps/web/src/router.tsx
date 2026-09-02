import { useCallback, useEffect, useState } from "react";

/**
 * A minimal path router.
 *
 * Three routes do not justify a routing library, and keeping the dependency out
 * means the bundle stays small enough that the part page — the only page that
 * matters for the landing-page experiment — loads fast.
 */

export type Route =
  | { name: "home" }
  | { name: "part"; owner: string; slug: string }
  | { name: "publish" }
  | { name: "notFound"; path: string };

export function parseRoute(path: string): Route {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/") return { name: "home" };
  if (clean === "/publish") return { name: "publish" };

  const parts = clean.slice(1).split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { name: "part", owner: parts[0], slug: parts[1] };
  }
  return { name: "notFound", path: clean };
}

export function navigate(to: string) {
  if (to === window.location.pathname) return;
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return route;
}

/** An anchor that routes client-side but still behaves like a real link. */
export function Link({
  to,
  children,
  className,
}: {
  to: string;
  children: React.ReactNode;
  className?: string;
}) {
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Let the browser handle modified clicks so "open in new tab" still works.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      e.preventDefault();
      navigate(to);
    },
    [to],
  );

  return (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
