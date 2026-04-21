import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "ERP Platform",
  description: "Multi-tenant, metadata-driven ERP for the MENA market.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
