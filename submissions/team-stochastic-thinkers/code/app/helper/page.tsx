import { redirect } from "next/navigation";

/** Everyone now uses one app: sign in, add skills and equipment, then ask for help or help others from the dashboard. */
export default function HelperRedirect() {
  redirect("/");
}
