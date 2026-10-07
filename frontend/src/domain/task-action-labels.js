import { rulebookText } from "../i18n/rulebook.js";

// Display labels from GNP rubrics.csv (actions-escalations-v5).
const LABELS = {
  "LITTER-1": "Pick up the litter",
  "LITTER-2": "File 311 ticket",
  "BULKY-1": "Call for pickup",
  "BULKY-2": "File 311 ticket",
  "FECES-1": "Ask the owner to clean it up",
  "FECES-2": "File 311 ticket",
  "FECES-3": "Call SFPD: 415-553-0123",
  "NEEDLES-1": "File 311 ticket",
  "TENTS-1": "File 311 ticket",
  "GRAFFITI-1": "Clean up the graffiti",
  "GRAFFITI-2": "File 311 ticket",
  "GRAFFITI-3": "Call SFPD: 415-553-0123",
  "GRAFFITI-4": "Call 911",
  "FIRE-1": "File 311 ticket",
  "FIRE-2": "Call 911",
  "BLOCK-1": "Ask them to move",
  "BLOCK-2": "File 311 ticket",
  "BLOCK-3": "Call SFPD: 415-553-0123",
  "DRUG-1": "Offer help",
  "DRUG-2": "Call SFPD: 415-553-0123",
  "DRUG-3": "Call SFPD: 415-553-0123",
  "DRUG-4": "Call 911",
  "DISTRESS-1": "Call 911",
  "DISTRESS-2": "Offer help",
  "DISTRESS-3": "Call 911",
  "ANIMAL-1": "Speak to them about their animal",
  "ANIMAL-2": "Call SFACC: 415-554-9400",
  "ANIMAL-3": "File 311 ticket",
  "ANIMAL-4": "Call 911",
  "MED-1": "Call 911",
  "MED-2": "Offer help",
  "MED-3": "Call 911",
  "THREAT-1": "Call SFPD: 415-553-0123",
  "THREAT-2": "Ask them to leave",
  "THREAT-3": "Call 911",
  "PARKING-1": "Call 311",
};

export function taskActionLabel(task) {
  return rulebookText(LABELS[task.ruleId] || task.buttons?.[0] || "");
}
