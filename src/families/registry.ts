/**
 * The one place that says which object families this build registers.
 *
 * `index.ts` used to spell the list inline (`[programFamily, ...textFamilies, ...xmlFamilies]`), which
 * is fine while the descriptors live in one file and wrong the moment they are split per domain —
 * every split would have to remember to touch that literal. The list lives here instead, so moving a
 * family into its own module is a change in *this* file only.
 *
 * S3 of `docs/ARCHITECTURE.md`: the descriptors are split per domain under `families/<domain>/`
 * and re-exported by `descriptors.ts`, which now holds nothing but the two registration lists.
 * This file stays the one place that says which of them register.
 */
import { textFamilies, xmlFamilies } from "./descriptors.js";
import { programFamily } from "./program.js";
import type { ObjectFamily } from "./types.js";

/** Every family this build registers, in registration order. */
export const allFamilies: readonly ObjectFamily[] = [programFamily, ...textFamilies, ...xmlFamilies];

/**
 * Duplicate ids would register two handlers for the same verbs, and the second would win silently —
 * one tool list, two behaviours, no error anywhere. Cheaper to refuse at startup.
 */
export function assertUniqueFamilyIds(families: readonly ObjectFamily[] = allFamilies): void {
  const seen = new Set<string>();
  for (const family of families) {
    if (seen.has(family.id)) {
      throw new Error(`duplicate object family "${family.id}": two descriptors would own the same verbs`);
    }
    seen.add(family.id);
  }
}
