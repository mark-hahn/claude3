// "There is always a session open", one queue per tab. Each request (Clean, a trash) lands before
// its check, since a card made earlier would be caught by it, and the checks never overlap, so a
// burst of events opens one card.
export function keepOpen(needed: () => boolean, open: () => Promise<void>, report: (error: unknown) => void): (request?: Promise<unknown>) => Promise<void> {
  let last = Promise.resolve();
  return (request) => (last = last.then(() => request).then(() => (needed() ? open() : undefined)).catch(report));
}
