// Runtime display policy only. Backend duplicate links and action routing remain
// authoritative regardless of this flag. Fail closed until site settings arrive.
let enabled = false;
const listeners = new Set();
/** @param {{featureFlags?:{duplicateDetection?:boolean}}|null|undefined} site */
export function setDuplicateUiSite(site) {
  const next = site?.featureFlags?.duplicateDetection === true;
  if (next === enabled) return;
  enabled = next;
  for (const listener of listeners) listener();
}
export const duplicateUiEnabled = () => enabled;
/** @param {()=>void} listener */
export function onDuplicateUiChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
