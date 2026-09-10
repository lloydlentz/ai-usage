export const driverCategories = ["shipping", "research", "review", "video", "admin", "unlabeled"] as const;
export type DriverCategory = (typeof driverCategories)[number];
export type DriverLabels = Record<string, DriverCategory>;
export function parseDriverLabels(value: unknown): DriverLabels {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([day, label]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) && driverCategories.includes(label as DriverCategory)
  )) as DriverLabels;
}
