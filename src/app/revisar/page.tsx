import type { Metadata } from "next";
import { ReviewScreen } from "@/components/ReviewScreen";

export const metadata: Metadata = { title: "Por revisar · Puntualito" };

export default function ReviewPage() {
  return <ReviewScreen />;
}
