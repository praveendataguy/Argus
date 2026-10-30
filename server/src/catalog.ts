export interface Product {
  sku: string;
  name: string;
  price: number;
  blurb: string;
  emoji: string;
}

/** The demo merchant: a small independent audio gear shop. */
export const merchant = {
  name: "Nimbus Audio",
  tagline: "Independent audio gear, shipped worldwide",
  returnPolicy: "30-day returns on unused items. Buyer pays return shipping unless the item is defective.",
  shippingPolicy: "Orders ship within 2 business days with tracking. Orders over $300 require signature on delivery.",
};

export const catalog: Product[] = [
  { sku: "NA-ORBIT", name: "Orbit Wireless Headphones", price: 249, blurb: "Hybrid ANC, 40h battery", emoji: "🎧" },
  { sku: "NA-PEBBLE", name: "Pebble Earbuds", price: 89, blurb: "Pocket-size, IPX5", emoji: "🔵" },
  { sku: "NA-MONO", name: "Monolith Studio Monitor", price: 529, blurb: "5\" bi-amped nearfield", emoji: "🔊" },
  { sku: "NA-DAC", name: "Pulse USB DAC", price: 139, blurb: "32-bit, balanced out", emoji: "🎛️" },
  { sku: "NA-CABLE", name: "Braided Cable Kit", price: 19, blurb: "3 lengths, gold plated", emoji: "🪢" },
  { sku: "NA-STAND", name: "Walnut Headphone Stand", price: 45, blurb: "Hand-finished hardwood", emoji: "🪵" },
];

export const productBySku = (sku: string) => catalog.find((p) => p.sku === sku);
