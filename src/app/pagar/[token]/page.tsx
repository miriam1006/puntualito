import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PayClient from "./PayClient";

export const metadata: Metadata = { title: "Pagar con CoDi", robots: { index: false, follow: false } };

export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();
  return <PayClient token={token} />;
}
