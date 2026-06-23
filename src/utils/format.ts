/** Format a number as IDR locale: dot as thousands separator, no currency symbol.
 *  Shared across layers (telegram formatter + agent prompt) so the agent layer
 *  does not import from the transport layer. */
export function formatIDR(n: number): string {
  return n.toLocaleString('id-ID');
}
