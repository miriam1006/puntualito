/** Normaliza un celular mexicano a 10 dígitos (lo que pide Pey). Devuelve null si no es válido. */
export function normalizeMxPhone(input: string): string | null {
  let digits = input.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("521")) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith("52")) digits = digits.slice(2);
  return /^[0-9]{10}$/.test(digits) ? digits : null;
}

/** "150", "150.5" o "0.01" a centavos enteros. Devuelve null si no es un monto válido. */
export function parsePesosToCents(input: string): number | null {
  const text = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);
}
