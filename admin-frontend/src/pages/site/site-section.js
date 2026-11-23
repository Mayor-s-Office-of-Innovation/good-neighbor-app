/**
 * openSite() loads data for this section and render() shows it, so both read it here.
 * @param {string | null} requested
 * @param {Record<string, boolean>} capabilities
 * @returns {string}
 */
export function activeSiteSection(requested, capabilities) {
  const section = requested || "details";
  const aliases = {
    staff: "details",
    terms: "compliance",
    letters: "compliance",
    perimeter: "compliance",
  };
  // hasOwn, so ?section=constructor can't return Object's own function.
  if (Object.hasOwn(aliases, section))
    return aliases[/** @type {keyof typeof aliases} */ (section)];
  return section === "settings" && capabilities.createEntities !== true
    ? "details"
    : section;
}
