/** Opening a project file failed: say it in the person's terms and keep the parser's own text as "details" (copyable, never the headline). */
export type OpenFailureKind = "newer" | "damaged";

/** Raw text of any thrown value (an `Error`, an engine `{ message }` object, a string). */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** Which plain sentence fits. Only a project from a newer version is told apart; everything else is "not a project, or damaged". */
export function openFailureKind(raw: string, newerText: string): OpenFailureKind {
  return raw === newerText || /newer version/i.test(raw) ? "newer" : "damaged";
}
