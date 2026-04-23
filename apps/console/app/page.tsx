import { redirect } from "next/navigation";

import { readSession } from "../lib/session";

export default function HomePage(): never {
  const session = readSession();
  if (session === null) {
    redirect("/login");
  }
  redirect("/entities/ent.customer");
}
