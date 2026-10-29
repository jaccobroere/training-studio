import { useScrollChrome } from "../ui/chrome";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import { useMe } from "../auth/session";
import { useInbox } from "../plan/api";
import { Icon } from "../ui/Icon";
import { useDock } from "./dock";
import { DockContent } from "./DockContent";
import { readPref } from "./prefs";
import { setTheme, type Theme } from "./theme";
import { useMobile, usePinnedDock } from "./useMedia";
import { useFocusTrap } from "../ui/focusTrap";

const PLAN = ["plan", "Plan", "plan"] as const;
const ACTIVITY = ["activities", "Activity", "activities"] as const;
const HEALTH = ["stats", "Health", "stats"] as const;
const LIBRARY = ["library", "Library", "library"] as const;
const INBOX = ["inbox", "Inbox", "inbox"] as const;
/** The rail has room for all five. The phone's bar keeps four plus More: Inbox goes under More,
 * with its count on both the More tab and its own row, so "something to sort" is still seen. */
const RAIL = [PLAN, ACTIVITY, HEALTH, LIBRARY, INBOX];
const TABS = [PLAN, ACTIVITY, HEALTH, LIBRARY];

function Badge() {
  const n = useInbox().data?.count ?? 0;
  if (!n) return null;
  return <span className="nav-badge mono" aria-label={`${n} to sort`}>{n > 99 ? "99+" : n}</span>;
}

/** The same count as a row hint in the More sheet. */
function MoreBadge() {
  const n = useInbox().data?.count ?? 0;
  return n ? <span className="hint mono">{n} to sort</span> : null;
}

/** Tapping the tab you are on scrolls its page back to the top first (as native tab bars do);
 * a second tap, already at the top, goes to the section's start. */
function toTop(e: React.MouseEvent, to: string) {
  if (!location.pathname.startsWith(`/${to}`)) return;
  const page = document.querySelector(".main-m .page");
  const sc = page ? [...page.querySelectorAll<HTMLElement>("*")].find((el) => el.scrollTop > 0 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) : null;
  if (!sc) return;
  e.preventDefault();
  sc.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function NavItem({ to, label, icon, tab }: { to: string; label: string; icon: string; tab?: boolean }) {
  return (
    <NavLink to={`/${to}`} onClick={tab ? (e) => toTop(e, to) : undefined}>
      <span className="nav-ic"><Icon name={icon} />{to === "inbox" && <Badge />}</span>
      <span>{label}</span>
    </NavLink>
  );
}

function useSignOut() {
  const qc = useQueryClient();
  return async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/");
    qc.clear();
  };
}

function ThemeKeys() {
  const [t, setT] = useState<Theme>(() => readPref<Theme>("theme", "system"));
  return (
    <div className="theme-keys" role="radiogroup" aria-label="Theme">
      <span className="silk">Theme</span>
      <div className="seg">
        {(["system", "light", "dark"] as const).map((k) => (
          <button key={k} role="radio" aria-checked={t === k} className={`key ${t === k ? "is-on" : ""}`}
            onClick={() => { setTheme(k); setT(k); }}>{k}</button>
        ))}
      </div>
    </div>
  );
}

/** The initial of the athlete's name, as a key: the rail's Settings tile and the More sheet's
 * Settings row. Decorative; the tile's text names the destination. */
function Monogram({ name }: { name: string }) {
  return <span className="avatar" aria-hidden="true">{name.slice(0, 1)}</span>;
}

function Rail() {
  const { me } = useMe();
  return (
    <nav className="rail" aria-label="Destinations">
      {RAIL.map(([to, label, icon]) => <NavItem key={to} to={to} label={label} icon={icon} />)}
      <div className="spacer" />
      <NavLink to="/settings" aria-label={`Settings: ${me.username}`}>
        <Monogram name={me.username} />
        <span>Settings</span>
      </NavLink>
    </nav>
  );
}

function TabBar({ onMore, moreOn }: { onMore: () => void; moreOn: boolean }) {
  const section = useLocation().pathname.split("/")[1];
  const inMore = section === "inbox" || section === "settings";
  return (
    <nav className="tabbar" aria-label="Destinations">
      {TABS.map(([to, label, icon]) => <NavItem key={to} to={to} label={label} icon={icon} tab />)}
      <button className={inMore || moreOn ? "active" : ""} aria-haspopup="dialog" aria-expanded={moreOn} onClick={onMore}>
        <span className="nav-ic"><Icon name="more" /><Badge /></span><span>More</span>
      </button>
    </nav>
  );
}

function MoreSheet({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const signOut = useSignOut();
  const { me } = useMe();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("button")?.focus(); }, []);
  useFocusTrap(ref, { onEscape: onClose });
  const go = (p: string) => { onClose(); nav(p); };
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="sheet bottom more-sheet" role="dialog" aria-modal="true" aria-label="More">
        <span className="grab" aria-hidden="true" />
        <div className="more-list">
          <button className="more-row" onClick={() => go("/inbox")}><Icon name="inbox" />Inbox<MoreBadge /></button>
          <button className="more-row" onClick={() => go("/settings")}><Monogram name={me.username} />Settings<span className="hint mono">{me.username}</span></button>
        </div>
        <ThemeKeys />
        <button className="key more-out" onClick={() => void signOut()}>Sign out</button>
      </div>
    </>
  );
}

function Resizer() {
  const { width, setWidth } = useDock();
  const start = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (start.current) setWidth(start.current.w + (start.current.x - e.clientX));
    };
    const up = () => (start.current = null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [setWidth]);
  // A focusable vertical separator is the ARIA "window splitter" pattern.
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuenow={width}
      aria-valuemin={360}
      aria-valuemax={620}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onPointerDown={(e) => (start.current = { x: e.clientX, w: width })}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setWidth(width + 24);
        if (e.key === "ArrowRight") setWidth(width - 24);
      }}
    />
  );
}

/** ⌘J / Ctrl J toggles the chat everywhere; Esc closes the topmost panel. */
function useShellKeys() {
  const dock = useDock();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        dock.toggleConsole();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [dock]);
}

/** The mobile dock sheet: traps Tab; the editor and log own their Esc (they may ask first),
 * the chat closes on Esc here. Focus goes back to the opener via the dock. */
function DockSheet({ bottom }: { bottom: boolean }) {
  const { view, close } = useDock();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { restore: false, onEscape: view?.kind === "console" ? close : undefined });
  return (
    <div ref={ref} className={`sheet ${bottom ? "bottom" : ""} ${view?.kind === "editor" ? "tall" : ""}`} role="dialog" aria-modal="true" aria-label="Panel" tabIndex={-1}>
      <DockContent />
    </div>
  );
}

export function Shell({ children }: { children?: ReactNode }) {
  const mobile = useMobile();
  const pinned = usePinnedDock();
  const { view, width } = useDock();
  const section = useLocation().pathname.split("/")[1];
  const [more, setMore] = useState(false);
  useShellKeys();
  const shellRef = useRef<HTMLDivElement>(null);
  useScrollChrome(shellRef, mobile);
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [section]);

  if (mobile) {
    const bottom = view?.kind === "log" || view?.kind === "editor";
    return (
      <div className="shell-m" ref={shellRef}>
        <main id="main" tabIndex={-1} className="main-m">{children ?? <Outlet />}</main>
        <TabBar onMore={() => setMore(!more)} moreOn={more} />
        {more && <MoreSheet onClose={() => setMore(false)} />}
        {view && (
          <>
            {bottom && <div className="scrim" aria-hidden="true" />}
            <DockSheet bottom={bottom} />
          </>
        )}
      </div>
    );
  }
  const docked = view && pinned;
  return (
    <div className="shell" style={{ gridTemplateColumns: docked ? `68px minmax(0,1fr) ${width}px` : "68px minmax(0,1fr)" }}>
      <Rail />
      <main id="main" tabIndex={-1} className="main">{children ?? <Outlet />}</main>
      {view && (docked ? (
        <aside className="dock" aria-label="Side panel">
          <Resizer />
          <DockContent />
        </aside>
      ) : (
        <aside className="dock overlay" aria-label="Side panel">
          <DockContent />
        </aside>
      ))}
    </div>
  );
}
