export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureData } = await import("./src/lib/bootstrap");
    await ensureData();
  } catch (err) {
    console.error("[bootstrap] failed:", err);
  }
}
