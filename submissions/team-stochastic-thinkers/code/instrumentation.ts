/** Runs once when the Next.js server starts: keep the MongoDB `jobs` collection in step with live requests. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.MONGODB_URI) return;
  const { registerJobMirror } = await import("./lib/jobs");
  registerJobMirror();
}
