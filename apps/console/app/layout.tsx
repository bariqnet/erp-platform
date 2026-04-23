import "./globals.css";

import { TopNav } from "../components/top-nav";
import { localeDir } from "../lib/i18n";
import { readSession } from "../lib/session";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "ERP Platform",
  description: "Multi-tenant, metadata-driven ERP for the MENA market.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const session = readSession();
  const locale = session?.locale ?? "en";
  const dir = localeDir(locale);
  return (
    <html lang={locale} dir={dir}>
      <body>
        <TopNav session={session} />
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
