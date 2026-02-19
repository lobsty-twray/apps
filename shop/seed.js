const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://lobsty:***REMOVED***@localhost:5432/shop';

const products = [
  {
    name: '5050/5080 FE Travel Kit',
    slug: '5050-5080-fe-travel-kit',
    description: 'Premium 3D printed GPU support and travel case for NVIDIA 5050/5080 Founders Edition graphics cards. Designed for secure transport with hex-patterned impact protection. Keeps your GPU safe during moves, LAN parties, or shipping.',
    price: 25.00,
    compare_at_price: 60.00,
    type: 'physical',
    sku: 'TWR-TK-5080',
    inventory_quantity: 20,
    sort_order: 1
  },
  {
    name: 'Apple Vision Pro Stand',
    slug: 'apple-vision-pro-stand',
    description: 'Elegant 3D printed stand designed specifically for the Apple Vision Pro headset. Clean lines, minimal footprint, and stable base keep your Vision Pro safely displayed and ready to use. Printed in premium black PLA+.',
    price: 29.99,
    compare_at_price: null,
    type: 'physical',
    sku: 'TWR-AVP-STAND',
    inventory_quantity: 15,
    sort_order: 2
  },
  {
    name: 'Custom 3D Printing Service',
    slug: 'custom-3d-printing-service',
    description: 'You Send It, I Print It! Have a custom project in mind? Send us your STL file and we\'ll provide a quote for professional 3D printing. We work with PLA, PETG, ABS, and TPU materials. Fast turnaround and competitive pricing.',
    price: 0.00,
    compare_at_price: null,
    type: 'physical',
    sku: 'TWR-CUSTOM',
    inventory_quantity: 999,
    sort_order: 3
  },
  {
    name: 'Travel Kit 5080/5090 FE STL FILE',
    slug: 'travel-kit-5080-5090-fe-stl-file',
    description: 'Digital download - STL file for the Travel Kit compatible with NVIDIA 5080/5090 Founders Edition GPUs. Print it yourself at home! Includes all parts and assembly instructions. Tested with PLA and PETG materials.',
    price: 2.00,
    compare_at_price: null,
    type: 'digital',
    sku: 'TWR-TK-STL',
    inventory_quantity: 0,
    sort_order: 4
  }
];

async function seed() {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    for (const product of products) {
      // Upsert - update if slug exists, insert if not
      await pool.query(`
        INSERT INTO products (name, slug, description, price, compare_at_price, type, sku, inventory_quantity, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          price = EXCLUDED.price,
          compare_at_price = EXCLUDED.compare_at_price,
          type = EXCLUDED.type,
          sku = EXCLUDED.sku,
          inventory_quantity = EXCLUDED.inventory_quantity,
          sort_order = EXCLUDED.sort_order,
          updated_at = NOW()
      `, [
        product.name, product.slug, product.description,
        product.price, product.compare_at_price, product.type,
        product.sku, product.inventory_quantity, product.sort_order
      ]);
      console.log(`Seeded: ${product.name}`);
    }

    console.log('\nAll products seeded successfully!');
    console.log('\nDefault admin credentials:');
    console.log('  Email: ray@twray.dev');
    console.log('  Password: admin2026');
  } catch (err) {
    console.error('Seed error:', err);
  } finally {
    await pool.end();
  }
}

seed();
