import type { Metadata } from "next";
import { CustomersScreen } from "@/components/CustomersScreen";

export const metadata: Metadata = { title: "Clientes y planes · Puntualito" };

export default function CustomersPage() {
  return <CustomersScreen />;
}
