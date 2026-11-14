"use client";
import { clientApi } from "@/lib/client-api";

type Section = "panel" | "review" | "customers";

const LINKS: { section: Section; href: string; label: string }[] = [
  { section: "panel", href: "/", label: "Cobros" },
  { section: "review", href: "/revisar", label: "Por revisar" },
  { section: "customers", href: "/clientes", label: "Clientes y planes" },
];

export function AppHeader({ merchantName, active, reviewCount }: {
  merchantName: string; active: Section; reviewCount?: number;
}) {
  async function logout() {
    await clientApi("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
    window.location.assign("/login");
  }
  return (
    <header className="app-header">
      <div className="topbar">
        <span className="brand">Puntualito<span>.</span> <span className="muted">{merchantName}</span></span>
        <button className="quiet" onClick={logout}>Salir</button>
      </div>
      <nav className="tabs" aria-label="Secciones">
        {LINKS.map(link => (
          <a key={link.section} href={link.href} className={link.section === active ? "tab active" : "tab"}
            aria-current={link.section === active ? "page" : undefined}>
            {link.label}
            {link.section === "review" && !!reviewCount && <span className="badge">{reviewCount}</span>}
          </a>
        ))}
      </nav>
    </header>
  );
}
