"use client";
import { useState, type FormEvent } from "react";
import { clientApi } from "@/lib/client-api";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await clientApi("/api/auth/login", {
        method: "POST", publicPage: true, body: JSON.stringify({ email: email.trim(), password }),
      });
      window.location.assign("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo iniciar sesión.");
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <div className="topbar"><span className="brand">Puntualito<span>.</span></span></div>
      <section className="card">
        <h1>Entra a tu negocio</h1>
        <p className="muted">Cobra con CoDi y lleva el control de quién ya pagó.</p>
        <form onSubmit={submit} aria-busy={busy}>
          <div className="field">
            <label htmlFor="email">Correo electrónico</label>
            <input id="email" type="email" autoComplete="username" autoCapitalize="none" required maxLength={254}
              disabled={busy} value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Contraseña</label>
            <input id="password" type="password" autoComplete="current-password" required maxLength={256}
              disabled={busy} value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          <button className="block" type="submit" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      </section>
    </main>
  );
}
