import { Navigate, NavLink, useParams } from "react-router";
import { ChatKey } from "../app/ChatKey";
import { ProfilePage } from "../profile/ProfilePage";
import { Icon } from "../ui/Icon";
import { AccountTab } from "./AccountTab";
import { ConnectionsTab } from "./ConnectionsTab";
import { DataTab } from "./DataTab";

const TABS = [
  { key: "profile", label: "Profile", icon: "profile" },
  { key: "connections", label: "Connections", icon: "sync" },
  { key: "data", label: "Data", icon: "data" },
  { key: "account", label: "Account", icon: "user" },
] as const;

/** Settings (decision 37): Profile · Connections · Data · Account, one destination. The rail has
 * one key for all of it and the phone's More sheet one row, instead of three overlapping places. */
export function SettingsPage() {
  const tab = useParams()["*"]?.split("/")[0] || "profile";
  if (!TABS.some((t) => t.key === tab)) return <Navigate to="/settings/profile" replace />;
  return (
    <div className="page settings">
      <div className="strip" role="toolbar" aria-label="Settings">
        <h1 className="page-t">Settings</h1>
        <nav className="seg settings-tabs" aria-label="Settings sections">
          {TABS.map((t) => (
            <NavLink key={t.key} to={`/settings/${t.key}`} className={`key ${tab === t.key ? "is-on" : ""}`} aria-current={tab === t.key ? "page" : undefined}>
              <Icon name={t.icon} />{t.label}
            </NavLink>
          ))}
        </nav>
        <span className="fill" />
        <ChatKey />
      </div>
      {tab === "profile" ? <ProfilePage embedded /> : (
        <div className="page-scroll pad-page settings-grid">
          {tab === "connections" && <ConnectionsTab />}
          {tab === "data" && <DataTab />}
          {tab === "account" && <AccountTab />}
        </div>
      )}
    </div>
  );
}
