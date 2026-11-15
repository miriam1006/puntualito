import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ChatClient from "./ChatClient";

export const metadata: Metadata = { title: "Chat de cobro · Puntualito", robots: { index: false, follow: false } };

export default async function ChatPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();
  return <ChatClient token={token} />;
}
