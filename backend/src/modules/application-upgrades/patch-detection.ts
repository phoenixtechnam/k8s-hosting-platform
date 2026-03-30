/**
 * Patch detection — determines whether a catalog sync brought image tag changes
 * within the same application version (a "patch") vs a version jump ("upgrade").
 *
 * Patches are lightweight: they only change container image tags without
 * altering the version identifier, upgrade paths, or parameters.
 */

interface ComponentImage {
  readonly name: string;
  readonly image: string;
}

interface ChangedImage {
  readonly component: string;
  readonly oldImage: string;
  readonly newImage: string;
}

interface PatchResult {
  readonly isPatch: boolean;
  readonly changedImages: readonly ChangedImage[];
}

/**
 * Compare two sets of component images and detect which ones changed.
 * Returns isPatch=true if at least one image tag changed.
 */
export function detectPatchChange(
  oldComponents: readonly ComponentImage[] | null | undefined,
  newComponents: readonly ComponentImage[] | null | undefined,
): PatchResult {
  if (!oldComponents || !newComponents || oldComponents.length === 0 || newComponents.length === 0) {
    return { isPatch: false, changedImages: [] };
  }

  const oldMap = new Map(oldComponents.map(c => [c.name, c.image]));
  const changedImages: ChangedImage[] = [];

  for (const comp of newComponents) {
    const oldImage = oldMap.get(comp.name);
    if (oldImage && oldImage !== comp.image) {
      changedImages.push({
        component: comp.name,
        oldImage,
        newImage: comp.image,
      });
    }
  }

  return {
    isPatch: changedImages.length > 0,
    changedImages,
  };
}

/**
 * Check if the "upgrade" is actually a patch — same version identifier,
 * just different image tags. In this case the version string matches
 * but the underlying images have been updated.
 */
export function isPatchUpgrade(
  fromVersion: string | null,
  toVersion: string | null,
): boolean {
  if (!fromVersion || !toVersion) return false;
  return fromVersion === toVersion;
}
