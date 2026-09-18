import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(E2E_DIR, "..", "fixtures", "photos");

/** input-1.jpg — several issues expected (encampment scene). */
export const PHOTO_ISSUES = join(FIXTURES, "input-1.jpg");
/** input-2.jpg — clear scene, no issues expected. */
export const PHOTO_CLEAR = join(FIXTURES, "input-2.jpg");

/** Seed code for St. John the Evangelist (has 3 places, legacy → never consumed). */
export const SITE_CODE = "GUBSJE";
export const SITE_NAME = "St. John the Evangelist";
export const PLACES = ["15th St", "Front entrance", "Caledonia St"];

export { dirname, join };
