export const SHELF_STORAGE_KEY = "skin-routine-copilot.product-shelf";
export const SHELF_SCHEMA_VERSION = 1 as const;
export const MAX_SHELF_PRODUCTS = 30;
export const MAX_PRODUCT_BRAND_LENGTH = 60;
export const MAX_PRODUCT_NAME_LENGTH = 100;
export const MAX_PRODUCT_NOTE_LENGTH = 180;

export const PRODUCT_CATEGORIES = [
  "cleanser",
  "toner-essence",
  "serum",
  "treatment",
  "moisturizer",
  "sunscreen",
  "other",
] as const;

export const PRODUCT_TIMES = ["morning", "evening", "both"] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];
export type ProductTime = (typeof PRODUCT_TIMES)[number];

export type ShelfProduct = {
  id: string;
  brand: string;
  name: string;
  category: ProductCategory;
  allowed_time: ProductTime;
  is_active: boolean;
  usage_note: string;
  enabled: boolean;
};

export type ShelfStore = {
  version: typeof SHELF_SCHEMA_VERSION;
  products: ShelfProduct[];
};

export const DEFAULT_SHELF: ShelfProduct[] = [
  { id: "beplain-cleanser", brand: "Beplain", name: "Mung Bean Cleanser", category: "cleanser", allowed_time: "both", is_active: false, usage_note: "Cleanse gently without scrubbing.", enabled: true },
  { id: "micro-essence", brand: "", name: "Micro Essence", category: "toner-essence", allowed_time: "both", is_active: false, usage_note: "Pat on one light layer.", enabled: true },
  { id: "torriden-serum", brand: "Torriden", name: "Dive-In", category: "serum", allowed_time: "both", is_active: false, usage_note: "Use a thin hydrating layer.", enabled: true },
  { id: "azelaic-acid", brand: "", name: "Azelaic Acid 10%", category: "treatment", allowed_time: "evening", is_active: true, usage_note: "Apply only to dry, comfortable skin.", enabled: true },
  { id: "lancome-cream", brand: "Lancôme", name: "Youth Activating Cream", category: "moisturizer", allowed_time: "both", is_active: false, usage_note: "Use a light layer to seal in moisture.", enabled: true },
  { id: "centella-sunscreen", brand: "", name: "Centella Sunscreen", category: "sunscreen", allowed_time: "morning", is_active: false, usage_note: "Apply generously as the final morning step.", enabled: true },
];

const categories = new Set<string>(PRODUCT_CATEGORIES);
const times = new Set<string>(PRODUCT_TIMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, maxLength: number, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
  return cleaned || allowEmpty ? cleaned : null;
}

export function productDisplayName(product: ShelfProduct): string {
  const brand = product.brand.trim();
  const name = product.name.trim();
  if (!brand || name.toLocaleLowerCase().startsWith(brand.toLocaleLowerCase())) return name;
  return `${brand} ${name}`;
}

export function parseShelfProduct(value: unknown): ShelfProduct | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, 80);
  const brand = cleanString(value.brand, MAX_PRODUCT_BRAND_LENGTH, true);
  const name = cleanString(value.name, MAX_PRODUCT_NAME_LENGTH);
  const usageNote = cleanString(value.usage_note, MAX_PRODUCT_NOTE_LENGTH, true);
  if (!id || brand === null || !name || usageNote === null) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(id)) return null;
  if (typeof value.category !== "string" || !categories.has(value.category)) return null;
  if (typeof value.allowed_time !== "string" || !times.has(value.allowed_time)) return null;
  if (typeof value.is_active !== "boolean" || typeof value.enabled !== "boolean") return null;
  return {
    id,
    brand,
    name,
    category: value.category as ProductCategory,
    allowed_time: value.allowed_time as ProductTime,
    is_active: value.is_active,
    usage_note: usageNote,
    enabled: value.enabled,
  };
}

export function validateShelfProducts(value: unknown): ShelfProduct[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const products: ShelfProduct[] = [];
  for (const candidate of value.slice(0, MAX_SHELF_PRODUCTS)) {
    const product = parseShelfProduct(candidate);
    if (!product || seen.has(product.id)) continue;
    seen.add(product.id);
    products.push(product);
  }
  return products;
}

export function createDefaultShelfStore(): ShelfStore {
  return { version: SHELF_SCHEMA_VERSION, products: DEFAULT_SHELF.map((product) => ({ ...product })) };
}

export function parseShelfStore(raw: string | null): ShelfStore {
  if (!raw) return createDefaultShelfStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return createDefaultShelfStore();
    if (parsed.version === SHELF_SCHEMA_VERSION && Array.isArray(parsed.products)) {
      const products = validateShelfProducts(parsed.products);
      return products.length === parsed.products.length
        ? { version: SHELF_SCHEMA_VERSION, products }
        : createDefaultShelfStore();
    }
    // A pre-versioned array is migrated when every entry already matches the current schema.
    if (Array.isArray(parsed)) {
      const products = validateShelfProducts(parsed);
      if (products.length === parsed.length) return { version: SHELF_SCHEMA_VERSION, products };
    }
    return createDefaultShelfStore();
  } catch {
    return createDefaultShelfStore();
  }
}

export function addShelfProduct(products: ShelfProduct[], product: ShelfProduct): ShelfProduct[] {
  const parsed = parseShelfProduct(product);
  if (!parsed || products.some((item) => item.id === parsed.id) || products.length >= MAX_SHELF_PRODUCTS) return validateShelfProducts(products);
  return [...validateShelfProducts(products), parsed].slice(0, MAX_SHELF_PRODUCTS);
}

export function updateShelfProduct(products: ShelfProduct[], id: string, update: ShelfProduct): ShelfProduct[] {
  const parsed = parseShelfProduct({ ...update, id });
  if (!parsed) return validateShelfProducts(products);
  return validateShelfProducts(products).map((product) => product.id === id ? parsed : product);
}

export function deleteShelfProduct(products: ShelfProduct[], id: string): ShelfProduct[] {
  return validateShelfProducts(products).filter((product) => product.id !== id);
}

export function enabledShelf(products: ShelfProduct[]): ShelfProduct[] {
  return validateShelfProducts(products).filter((product) => product.enabled);
}
