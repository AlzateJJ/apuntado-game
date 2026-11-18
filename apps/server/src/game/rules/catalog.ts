import { classic } from './classic.js';
import { apuntado } from './apuntado.js';
import type { Variant, VariantCatalog } from './model.js';
const variants = new Map<string, Variant>([
  ['classic-v2', classic],
  ['apuntado-v2', apuntado],
]);
export const variantCatalog: VariantCatalog = (profileId) => {
  const variant = variants.get(profileId);
  if (!variant) throw new Error(`Unsupported rule profile: ${profileId}`);
  return variant;
};
