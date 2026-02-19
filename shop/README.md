# Tech With Ray - Shop

Self-hosted e-commerce platform for 3D printed products, digital downloads, and custom printing services. Built with Node.js, Express, PostgreSQL, and Stripe.

## Features

- Product catalog with filtering and sorting (physical, digital, services)
- Stripe Checkout integration for payments
- Digital product downloads with expiring tokens
- Custom 3D printing quote requests with file uploads
- Admin dashboard with analytics, order management, and product CRUD
- SPA frontend with client-side routing
- Mobile-responsive design

## Prerequisites

- Node.js 18+
- PostgreSQL 16+
- Stripe account (for payments)

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Copy environment file and configure
cp .env.example .env

# Start the server (creates database and tables automatically)
npm run dev

# Seed products (optional - run after server starts once)
npm run seed
```

The server auto-creates the database, all tables, and a default admin user on first start.

### Docker (Production)

The shop is configured in the root `docker-compose.yml`:

```bash
# From the parent apps/ directory
docker compose up shop -d

# Seed products inside the container
docker exec lobsty-shop node seed.js
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://lobsty:***REMOVED***@localhost:5432/shop` |
| `JWT_SECRET` | Secret for admin JWT tokens | `shop-dev-secret-change-me` |
| `STRIPE_SECRET_KEY` | Stripe secret key | _(empty, checkout disabled)_ |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key | _(empty)_ |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | _(empty)_ |
| `BASE_URL` | Public URL for the shop | `http://localhost:3000` |

## Default Admin Credentials

- **Email:** `ray@twray.dev`
- **Password:** `admin2026`

Access the admin panel at `/admin`.

## Project Structure

```
shop/
  server.js          # Express API server (all routes)
  seed.js            # Database seeder (products)
  package.json       # Dependencies
  Dockerfile         # Container build
  .env.example       # Environment template
  public/
    index.html       # SPA shell
    app.js           # Client-side SPA (routing, cart, admin)
    style.css        # Styles
  uploads/           # User-uploaded files (images, STLs)
```

## API Endpoints

### Public
- `GET /api/products` - List active products
- `GET /api/products/:slug` - Product detail
- `POST /api/checkout` - Create Stripe Checkout session
- `POST /api/quotes` - Submit custom quote request
- `GET /api/orders/by-session/:sessionId` - Order confirmation
- `GET /api/download/:token` - Download digital product
- `GET /api/config` - Stripe public config

### Admin (requires Bearer token)
- `POST /api/admin/login` - Admin login
- `GET /api/admin/me` - Current admin user
- `GET/POST /api/admin/products` - List/create products
- `PUT/DELETE /api/admin/products/:id` - Update/delete product
- `GET /api/admin/orders` - List orders
- `GET/PUT /api/admin/orders/:id` - View/update order
- `GET /api/admin/quotes` - List quote requests
- `PUT /api/admin/quotes/:id` - Update quote status
- `GET /api/admin/analytics` - Dashboard stats

### Webhook
- `POST /api/webhooks/stripe` - Stripe payment webhook

## Stripe Setup

1. Create a [Stripe account](https://dashboard.stripe.com)
2. Get your API keys from the Stripe dashboard
3. Set `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` in `.env`
4. For webhooks, set up an endpoint pointing to `https://shop.twray.dev/api/webhooks/stripe`
5. Set `STRIPE_WEBHOOK_SECRET` from the webhook configuration

## Deployment

The shop runs on port 8096 behind a reverse proxy (Caddy) at `shop.twray.dev`. The Docker Compose config handles:

- PostgreSQL dependency with health checks
- Persistent volume for uploaded files (`shop-uploads`)
- Stripe keys passed via environment variables
