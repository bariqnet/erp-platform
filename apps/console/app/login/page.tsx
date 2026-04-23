import { redirect } from "next/navigation";

import { readSession } from "../../lib/session";

import { LoginForm } from "./login-form";

export default function LoginPage(): JSX.Element {
  const session = readSession();
  if (session !== null) {
    redirect("/entities/ent.customer");
  }
  return (
    <div className="mx-auto mt-8 max-w-md rounded-lg bg-white p-6 shadow-sm">
      <LoginForm />
    </div>
  );
}
