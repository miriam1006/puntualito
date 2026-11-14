export async function clientApi(path: string, options: RequestInit & { publicPage?: boolean } = {}) {
  const { publicPage, ...init } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.method === "POST" ? 35_000 : 15_000);
  try {
    const response = await fetch(path, {
      ...init, signal: controller.signal, cache: "no-store",
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    if (response.status === 401 && !publicPage) {
      window.location.assign("/login");
      throw new Error("Inicia sesión para continuar.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "No se pudo completar la operación.");
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("La consulta tardó demasiado. Vuelve a intentar.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
