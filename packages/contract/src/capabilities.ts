export const CAPABILITY_FLAGS = [
  'externalIdIn',
  'attributeFilters',
  'dateRanges',
  'randomSample',
  'declaredSchema',
] as const;
export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
