import assert from "node:assert/strict";
import test from "node:test";
import { isDatabasePhoto, isProductImage, MAX_PRODUCT_IMAGE_LENGTH, parseShelfProduct, withoutPhoto } from "../lib/shelf.ts";
import { buildSuggestion, parseObfSearch } from "../lib/product-identify.ts";

const OBF = "https://images.openbeautyfacts.org/images/products/333/787/559/7197/front_en.15.200.jpg";
const DATA = `data:image/jpeg;base64,${"A".repeat(400)}`;
const base = { id: "p1", brand: "CeraVe", name: "PM Lotion", category: "moisturizer", allowed_time: "both", is_active: false, usage_note: "", enabled: true };

test("a product photo is a small image data URL or an Open Beauty Facts photo URL, nothing else", () => {
  assert.equal(isProductImage(DATA), true);
  assert.equal(isProductImage(`data:image/webp;base64,${"B".repeat(100)}`), true);
  assert.equal(isProductImage(OBF), true);
  for (const bad of [
    "https://evil.example/x.jpg",
    "http://images.openbeautyfacts.org/images/products/1/front.jpg",
    "https://images.openbeautyfacts.org.evil.example/images/products/1/front.jpg",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,PGgxPg==",
    `data:image/jpeg;base64,${"A".repeat(MAX_PRODUCT_IMAGE_LENGTH)}`,
    42,
  ]) assert.equal(isProductImage(bad), false, String(bad).slice(0, 60));
  assert.equal(isDatabasePhoto(OBF), true);
  assert.equal(isDatabasePhoto(DATA), false);
});

test("the photo is optional on a saved product, and an invalid one is dropped without losing the product", () => {
  assert.equal(parseShelfProduct({ ...base, image: DATA }).image, DATA);
  assert.equal("image" in parseShelfProduct(base), false);
  const bad = parseShelfProduct({ ...base, image: "https://evil.example/x.jpg" });
  assert.equal(bad.name, "PM Lotion");
  assert.equal("image" in bad, false);
});

test("routine requests never carry the photo", () => {
  const product = parseShelfProduct({ ...base, image: DATA, per_week: 3 });
  const sent = withoutPhoto(product);
  assert.equal("image" in sent, false);
  assert.equal(sent.per_week, 3);
  assert.equal(product.image, DATA, "the saved product keeps its photo");
});

test("auto-fill passes on the database photo only when it is an Open Beauty Facts image URL", () => {
  const [good, bad] = parseObfSearch({ products: [
    { code: "3337875597197", product_name: "PM Facial Moisturizing Lotion", brands: "CeraVe", image_front_small_url: OBF },
    { code: "3337875597198", product_name: "Other", image_front_small_url: "https://tracker.example/pixel.jpg" },
  ] });
  assert.equal(good.image_url, OBF);
  assert.equal(bad.image_url, null);
  assert.equal(buildSuggestion("CeraVe PM Facial Moisturizing Lotion", good).suggestion.image_url, OBF);
  assert.equal(buildSuggestion("CeraVe PM Facial Moisturizing Lotion", null).suggestion.image_url, null);
});
