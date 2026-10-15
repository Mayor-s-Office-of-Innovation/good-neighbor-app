/** @typedef {import('./image-matcher.js').ImageObservation} Observation */
// Deliberately narrow English hints. Unknown, negated or mixed descriptions abstain.
const families = [
  /\b(mattress(?:es)?|box springs?)\b/i,
  /\b(sofas?|couches|couch|armchairs?)\b/i,
  /\b(cabinets?|dressers?|wardrobes?)\b/i,
  /\b(cardboard|cartons?|boxes|box)\b/i,
  /\b(litter|wrappers?|cigarette butts?|scattered (?:trash|rubbish))\b/i,
  /\b(bicycles?|bikes?)\b/i,
  /\b(cars?|minivans?|sedans?|suvs?)\b/i,
];
/** @param {string} text @returns {number|undefined} */
function family(text) {
  if (/\b(no|not|without|possibly|perhaps|maybe)\b/i.test(text))
    return undefined;
  const matches = families.flatMap((pattern, i) =>
    pattern.test(text) ? [i] : [],
  );
  return matches.length === 1 ? matches[0] : undefined;
}
/**
 * Metadata is retrieval evidence only, never a duplicate/negative decision.
 * Defer a photo only if EVERY same-category issue pair has distinct known objects.
 * @param {Observation} source @param {Observation} candidate
 * @returns {boolean}
 */
export function metadataMismatch(source, candidate) {
  const pairs = (source.conditions ?? []).flatMap((s) =>
    (candidate.conditions ?? [])
      .filter((c) => c.category && c.category === s.category)
      .map((c) => [s, c]),
  );
  return (
    pairs.length > 0 &&
    pairs.every(([s, c]) => {
      const a = family(s.description),
        b = family(c.description);
      return a !== undefined && b !== undefined && a !== b;
    })
  );
}
/**
 * Cheap shortlist selection; recent-first order is applied AFTER selecting it.
 * Hashes/object hints rank only, with no irreversible metadata exclusion.
 * @param {Observation} source @param {Observation[]} candidates
 * @returns {Observation[]}
 */
export function visualPriority(source, candidates) {
  const distance = (/** @type {Observation} */ c) => {
    if (source.fingerprint && c.fingerprint === source.fingerprint) return -1;
    if (
      !/^[01]{64}$/.test(source.perceptualHash ?? "") ||
      !/^[01]{64}$/.test(c.perceptualHash ?? "")
    )
      return 64;
    return [...(source.perceptualHash ?? "")].reduce(
      (n, bit, i) => n + Number(bit !== c.perceptualHash?.[i]),
      0,
    );
  };
  return [...candidates].sort(
    (a, b) =>
      Number(metadataMismatch(source, a)) -
        Number(metadataMismatch(source, b)) ||
      distance(a) - distance(b) ||
      (Date.parse(b.observedAt ?? "") || 0) -
        (Date.parse(a.observedAt ?? "") || 0) ||
      a.id.localeCompare(b.id),
  );
}
