/** Message of anything thrown, without assuming it's an Error. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
