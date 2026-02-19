// ====================== Shop App ======================
class ShopApp {
  constructor() {
    this.cart = JSON.parse(localStorage.getItem('shop_cart') || '[]');
    this.products = [];
    this.adminToken = localStorage.getItem('shop_admin_token');
    this.config = {};
    this.currentFilter = 'all';
    this.currentSort = 'default';
    this.init();
  }

  async init() {
    await this.loadConfig();
    await this.loadProducts();
    this.updateCartCount();
    this.setupRouter();
    this.navigate(window.location.pathname + window.location.search);
  }

  async loadConfig() {
    try {
      const res = await fetch('/api/config');
      this.config = await res.json();
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  }

  async loadProducts() {
    try {
      const res = await fetch('/api/products');
      this.products = await res.json();
    } catch (e) {
      console.error('Failed to load products:', e);
    }
  }

  // ====================== Router ======================
  setupRouter() {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('[data-link]');
      if (link) {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (href) this.navigate(href);
      }
    });
    window.addEventListener('popstate', () => {
      this.navigate(window.location.pathname + window.location.search, false);
    });
  }

  navigate(path, pushState = true) {
    if (pushState) {
      history.pushState(null, '', path);
    }
    this.closeCart();
    this.closeMobileMenu();
    this.closeAdminSidebar();
    window.scrollTo(0, 0);
    this.route(path);
    this.updateActiveNav(path);
  }

  route(path) {
    const main = document.getElementById('mainContent');
    const [pathname, search] = path.split('?');
    const params = new URLSearchParams(search || '');

    // Admin routes
    if (pathname.startsWith('/admin')) {
      this.renderAdmin(pathname);
      return;
    }

    if (pathname === '/' || pathname === '') {
      this.renderHome(main);
    } else if (pathname === '/catalog') {
      this.renderCatalog(main);
    } else if (pathname.startsWith('/product/')) {
      const slug = pathname.split('/product/')[1];
      this.renderProduct(main, slug);
    } else if (pathname === '/custom-quote') {
      this.renderQuoteForm(main);
    } else if (pathname === '/contact') {
      this.renderContact(main);
    } else if (pathname === '/shipping') {
      this.renderShipping(main);
    } else if (pathname === '/cart') {
      this.openCart();
      this.renderCatalog(main);
    } else if (pathname === '/order-confirmation') {
      this.renderOrderConfirmation(main, params.get('session_id'));
    } else {
      this.render404(main);
    }
  }

  updateActiveNav(path) {
    document.querySelectorAll('.nav-link').forEach(link => {
      const href = link.getAttribute('href');
      link.classList.toggle('active', href === path || (href !== '/' && path.startsWith(href)));
    });
  }

  // ====================== Home Page ======================
  renderHome(container) {
    container.innerHTML = `
      <div class="hero">
        <div class="hero-bg"></div>
        <div class="hero-pattern"></div>
        <div class="hero-content">
          <h1>Premium 3D Prints</h1>
          <p>Custom designed, high-quality 3D printed accessories for your tech</p>
          <a href="/catalog" class="hero-cta" data-link>Shop All Prints</a>
        </div>
      </div>
      <div class="section">
        <h2 class="section-title">Featured Products</h2>
        <p class="section-subtitle">Check out our latest 3D printed creations</p>
        <div class="products-grid">
          ${this.products.map(p => this.renderProductCard(p)).join('')}
        </div>
      </div>
    `;
  }

  // ====================== Catalog Page ======================
  renderCatalog(container) {
    let filtered = [...this.products];

    if (this.currentFilter === 'physical') {
      filtered = filtered.filter(p => p.type === 'physical');
    } else if (this.currentFilter === 'digital') {
      filtered = filtered.filter(p => p.type === 'digital');
    } else if (this.currentFilter === 'sale') {
      filtered = filtered.filter(p => p.compare_at_price);
    }

    if (this.currentSort === 'price-low') {
      filtered.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    } else if (this.currentSort === 'price-high') {
      filtered.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    } else if (this.currentSort === 'name') {
      filtered.sort((a, b) => a.name.localeCompare(b.name));
    }

    container.innerHTML = `
      <div class="section">
        <h2 class="section-title">All Products</h2>
        <p class="section-subtitle">${this.products.length} products available</p>
        <div class="filter-bar">
          <button class="filter-btn ${this.currentFilter === 'all' ? 'active' : ''}" onclick="app.setFilter('all')">All</button>
          <button class="filter-btn ${this.currentFilter === 'physical' ? 'active' : ''}" onclick="app.setFilter('physical')">Physical</button>
          <button class="filter-btn ${this.currentFilter === 'digital' ? 'active' : ''}" onclick="app.setFilter('digital')">Digital</button>
          <button class="filter-btn ${this.currentFilter === 'sale' ? 'active' : ''}" onclick="app.setFilter('sale')">On Sale</button>
          <select class="sort-select" onchange="app.setSort(this.value)">
            <option value="default" ${this.currentSort === 'default' ? 'selected' : ''}>Sort by: Default</option>
            <option value="price-low" ${this.currentSort === 'price-low' ? 'selected' : ''}>Price: Low to High</option>
            <option value="price-high" ${this.currentSort === 'price-high' ? 'selected' : ''}>Price: High to Low</option>
            <option value="name" ${this.currentSort === 'name' ? 'selected' : ''}>Name: A-Z</option>
          </select>
        </div>
        <div class="products-grid">
          ${filtered.length ? filtered.map(p => this.renderProductCard(p)).join('') : '<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px;">No products found</p>'}
        </div>
      </div>
    `;
  }

  setFilter(filter) {
    this.currentFilter = filter;
    this.renderCatalog(document.getElementById('mainContent'));
  }

  setSort(sort) {
    this.currentSort = sort;
    this.renderCatalog(document.getElementById('mainContent'));
  }

  // ====================== Product Card ======================
  renderProductCard(product) {
    const isOnSale = product.compare_at_price && parseFloat(product.compare_at_price) > parseFloat(product.price);
    const isCustom = parseFloat(product.price) === 0;
    const isOutOfStock = product.type === 'physical' && product.inventory_quantity <= 0;

    let badge = '';
    if (isOutOfStock) badge = '<span class="product-badge badge-out-of-stock">Sold Out</span>';
    else if (isOnSale) badge = '<span class="product-badge badge-sale">Sale</span>';
    else if (product.type === 'digital') badge = '<span class="product-badge badge-digital">Digital</span>';

    const imageHtml = product.image_url
      ? `<img src="${this.escapeHtml(product.image_url)}" alt="${this.escapeHtml(product.name)}" loading="lazy">`
      : `<div class="product-image-placeholder">&#x1F4E6;</div>`;

    let priceHtml;
    if (isCustom) {
      priceHtml = '<span class="price-custom">Custom Quote</span>';
    } else {
      priceHtml = `<span class="price-current">$${parseFloat(product.price).toFixed(2)}</span>`;
      if (isOnSale) {
        priceHtml += `<span class="price-compare">$${parseFloat(product.compare_at_price).toFixed(2)}</span>`;
      }
    }

    const href = isCustom ? '/custom-quote' : `/product/${product.slug}`;

    return `
      <a href="${href}" class="product-card" data-link>
        <div class="product-image">
          ${imageHtml}
          ${badge}
        </div>
        <div class="product-info">
          <div class="product-name">${this.escapeHtml(product.name)}</div>
          <div class="product-price">${priceHtml}</div>
        </div>
      </a>
    `;
  }

  // ====================== Product Detail ======================
  async renderProduct(container, slug) {
    const product = this.products.find(p => p.slug === slug);
    if (!product) {
      container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
      try {
        const res = await fetch(`/api/products/${slug}`);
        if (!res.ok) return this.render404(container);
        const p = await res.json();
        this.renderProductDetail(container, p);
      } catch (e) {
        this.render404(container);
      }
      return;
    }
    this.renderProductDetail(container, product);
  }

  renderProductDetail(container, product) {
    const isOnSale = product.compare_at_price && parseFloat(product.compare_at_price) > parseFloat(product.price);
    const isCustom = parseFloat(product.price) === 0;
    const isOutOfStock = product.type === 'physical' && product.inventory_quantity <= 0;

    const imageHtml = product.image_url
      ? `<img src="${this.escapeHtml(product.image_url)}" alt="${this.escapeHtml(product.name)}">`
      : `<div class="detail-image-placeholder">&#x1F4E6;</div>`;

    let priceHtml;
    if (isCustom) {
      priceHtml = '<span class="price-custom" style="font-size:20px">Contact for Custom Quote</span>';
    } else {
      priceHtml = `<span class="price-current">$${parseFloat(product.price).toFixed(2)}</span>`;
      if (isOnSale) {
        priceHtml += `<span class="price-compare">$${parseFloat(product.compare_at_price).toFixed(2)}</span>`;
      }
    }

    let buttonHtml;
    if (isCustom) {
      buttonHtml = `<a href="/custom-quote" class="add-to-cart-btn" data-link style="text-align:center;display:block">Request Custom Quote</a>`;
    } else if (isOutOfStock) {
      buttonHtml = `<button class="add-to-cart-btn" disabled>Sold Out</button>`;
    } else {
      buttonHtml = `<button class="add-to-cart-btn" id="addToCartBtn" onclick="app.addToCart(${product.id})">Add to Cart</button>`;
    }

    container.innerHTML = `
      <div class="product-detail">
        <div class="detail-image">${imageHtml}</div>
        <div class="detail-info">
          <h1>${this.escapeHtml(product.name)}</h1>
          <div class="detail-price">${priceHtml}</div>
          <div class="detail-description">${this.escapeHtml(product.description || 'No description available.')}</div>
          <div class="detail-meta">
            <div class="meta-row">
              <span class="meta-label">Type</span>
              <span class="meta-value">${product.type === 'digital' ? 'Digital Download' : 'Physical Product'}</span>
            </div>
            ${product.type === 'physical' ? `
            <div class="meta-row">
              <span class="meta-label">Availability</span>
              <span class="meta-value" style="color: ${isOutOfStock ? 'var(--sale)' : 'var(--success)'}">${isOutOfStock ? 'Out of Stock' : 'In Stock'}</span>
            </div>` : ''}
            ${product.type === 'physical' ? `
            <div class="meta-row">
              <span class="meta-label">Shipping</span>
              <span class="meta-value">$5.00 USPS</span>
            </div>` : `
            <div class="meta-row">
              <span class="meta-label">Delivery</span>
              <span class="meta-value">Instant Download</span>
            </div>`}
          </div>
          ${!isCustom && !isOutOfStock ? `
          <div class="quantity-selector">
            <button class="qty-btn" onclick="app.updateDetailQty(-1)">-</button>
            <div class="qty-value" id="detailQty">1</div>
            <button class="qty-btn" onclick="app.updateDetailQty(1)">+</button>
          </div>` : ''}
          ${buttonHtml}
        </div>
      </div>
    `;
    this._detailQty = 1;
    this._detailProductId = product.id;
  }

  updateDetailQty(delta) {
    this._detailQty = Math.max(1, (this._detailQty || 1) + delta);
    const el = document.getElementById('detailQty');
    if (el) el.textContent = this._detailQty;
  }

  // ====================== Custom Quote Form ======================
  renderQuoteForm(container) {
    container.innerHTML = `
      <div class="form-page">
        <h1>Custom 3D Printing</h1>
        <p class="subtitle">You send it, I print it! Upload your STL file and describe what you need.</p>
        <form id="quoteForm" onsubmit="app.submitQuote(event)">
          <div class="form-group">
            <label for="quoteName">Your Name *</label>
            <input type="text" id="quoteName" name="name" required>
          </div>
          <div class="form-group">
            <label for="quoteEmail">Email Address *</label>
            <input type="email" id="quoteEmail" name="email" required>
          </div>
          <div class="form-group">
            <label for="quoteDesc">Project Description *</label>
            <textarea id="quoteDesc" name="description" placeholder="Describe your project, dimensions, material preferences, quantity, etc." required></textarea>
          </div>
          <div class="form-group">
            <label for="quoteFile">Upload File (STL, OBJ, 3MF, STEP, ZIP)</label>
            <input type="file" id="quoteFile" name="file" accept=".stl,.obj,.3mf,.step,.zip">
          </div>
          <button type="submit" class="form-submit">Submit Quote Request</button>
        </form>
        <div id="quoteSuccess" class="form-success" style="display:none">
          <h2>Quote Request Submitted!</h2>
          <p>We'll review your request and get back to you within 24-48 hours with a quote.</p>
          <a href="/catalog" data-link style="display:inline-block;margin-top:16px;color:var(--accent);font-weight:600">Continue Shopping</a>
        </div>
      </div>
    `;
  }

  async submitQuote(e) {
    e.preventDefault();
    const form = document.getElementById('quoteForm');
    const data = new FormData(form);

    try {
      const res = await fetch('/api/quotes', { method: 'POST', body: data });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }
      form.style.display = 'none';
      document.getElementById('quoteSuccess').style.display = 'block';
    } catch (err) {
      this.showToast(err.message || 'Failed to submit quote', 'error');
    }
  }

  // ====================== Contact Page ======================
  renderContact(container) {
    container.innerHTML = `
      <div class="info-page">
        <h1>Contact Us</h1>
        <p>Have a question about an order, product, or custom print? Get in touch!</p>
        <h2>Email</h2>
        <p><a href="mailto:ray@twray.dev" style="color:var(--accent);font-weight:600">ray@twray.dev</a></p>
        <h2>Custom 3D Printing</h2>
        <p>For custom printing requests, use our <a href="/custom-quote" data-link style="color:var(--accent);font-weight:600">Custom Quote Form</a> to submit your project details and files.</p>
        <h2>Order Issues</h2>
        <p>If you have any issues with your order, please email us with your order number and we'll get it sorted out.</p>
      </div>
    `;
  }

  // ====================== Shipping Page ======================
  renderShipping(container) {
    container.innerHTML = `
      <div class="info-page">
        <h1>Shipping Information</h1>
        <h2>Shipping Rates</h2>
        <ul>
          <li>Flat rate shipping: <strong>$5.00</strong> via USPS</li>
          <li>Ships within the United States only</li>
          <li>Orders typically ship within 2-3 business days</li>
        </ul>
        <h2>Digital Downloads</h2>
        <ul>
          <li>Digital products (STL files) are available for instant download</li>
          <li>Download links are valid for 48 hours</li>
          <li>Each download link allows up to 5 downloads</li>
        </ul>
        <h2>Returns &amp; Exchanges</h2>
        <p>Due to the custom nature of 3D printed products, all sales are final. If your item arrives damaged, please contact us within 7 days with photos and we'll work with you on a replacement.</p>
      </div>
    `;
  }

  // ====================== Order Confirmation ======================
  async renderOrderConfirmation(container, sessionId) {
    if (!sessionId) {
      return this.navigate('/');
    }

    container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    // Clear cart
    this.cart = [];
    this.saveCart();

    // Poll for order (webhook may not have processed yet)
    let order = null;
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`/api/orders/by-session/${sessionId}`);
        if (res.ok) {
          order = await res.json();
          break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!order) {
      container.innerHTML = `
        <div class="confirmation-page">
          <div class="confirmation-icon">&#x2705;</div>
          <h1>Payment Received!</h1>
          <p>Your order is being processed. You'll receive a confirmation email shortly.</p>
          <a href="/catalog" data-link style="display:inline-block;margin-top:24px;padding:12px 24px;background:var(--accent);color:white;border-radius:var(--radius);font-weight:600">Continue Shopping</a>
        </div>
      `;
      return;
    }

    const digitalItems = (order.items || []).filter(i => i.download_token);

    container.innerHTML = `
      <div class="confirmation-page">
        <div class="confirmation-icon">&#x2705;</div>
        <h1>Thank You for Your Order!</h1>
        <p class="order-number">Order #${this.escapeHtml(order.order_number)}</p>
        <div class="order-summary">
          <div class="order-summary-header">Order Summary</div>
          ${(order.items || []).map(item => `
            <div class="order-summary-item">
              <span>${this.escapeHtml(item.product_name)} x ${item.quantity}</span>
              <span>$${(parseFloat(item.price) * item.quantity).toFixed(2)}</span>
            </div>
          `).join('')}
          ${parseFloat(order.shipping_cost) > 0 ? `
          <div class="order-summary-item">
            <span>Shipping</span>
            <span>$${parseFloat(order.shipping_cost).toFixed(2)}</span>
          </div>` : ''}
          ${parseFloat(order.tax) > 0 ? `
          <div class="order-summary-item">
            <span>Tax</span>
            <span>$${parseFloat(order.tax).toFixed(2)}</span>
          </div>` : ''}
          <div class="order-summary-item total">
            <span>Total</span>
            <span>$${parseFloat(order.total).toFixed(2)}</span>
          </div>
        </div>
        ${digitalItems.length > 0 ? `
        <div class="order-summary" style="margin-bottom:24px">
          <div class="order-summary-header">Your Downloads</div>
          ${digitalItems.map(item => `
            <div class="order-summary-item">
              <span>${this.escapeHtml(item.product_name)}</span>
              <a href="/api/download/${item.download_token}" class="download-link">Download File</a>
            </div>
          `).join('')}
        </div>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:24px">Download links expire in 48 hours (5 downloads max)</p>
        ` : ''}
        <a href="/catalog" data-link style="display:inline-block;padding:12px 24px;background:var(--accent);color:white;border-radius:var(--radius);font-weight:600">Continue Shopping</a>
      </div>
    `;
  }

  // ====================== Cart ======================
  addToCart(productId) {
    const product = this.products.find(p => p.id === productId);
    if (!product) return;

    const qty = this._detailQty || 1;
    const existing = this.cart.find(item => item.product_id === productId);

    if (existing) {
      existing.quantity += qty;
    } else {
      this.cart.push({
        product_id: productId,
        name: product.name,
        price: parseFloat(product.price),
        image_url: product.image_url,
        type: product.type,
        quantity: qty
      });
    }

    this.saveCart();
    this.showToast('Added to cart!', 'success');

    // Update button state
    const btn = document.getElementById('addToCartBtn');
    if (btn) {
      btn.textContent = 'Added!';
      btn.classList.add('added');
      setTimeout(() => {
        btn.textContent = 'Add to Cart';
        btn.classList.remove('added');
      }, 1500);
    }
  }

  updateCartItem(productId, delta) {
    const item = this.cart.find(i => i.product_id === productId);
    if (!item) return;
    item.quantity += delta;
    if (item.quantity <= 0) {
      this.cart = this.cart.filter(i => i.product_id !== productId);
    }
    this.saveCart();
    this.renderCartSidebar();
  }

  removeCartItem(productId) {
    this.cart = this.cart.filter(i => i.product_id !== productId);
    this.saveCart();
    this.renderCartSidebar();
  }

  saveCart() {
    localStorage.setItem('shop_cart', JSON.stringify(this.cart));
    this.updateCartCount();
  }

  updateCartCount() {
    const count = this.cart.reduce((sum, item) => sum + item.quantity, 0);
    const el = document.getElementById('cartCount');
    if (el) {
      el.textContent = count;
      el.setAttribute('data-count', count);
    }
  }

  openCart() {
    document.getElementById('cartOverlay').classList.add('open');
    document.getElementById('cartSidebar').classList.add('open');
    document.body.classList.add('cart-open');
    this.renderCartSidebar();
  }

  closeCart() {
    document.getElementById('cartOverlay')?.classList.remove('open');
    document.getElementById('cartSidebar')?.classList.remove('open');
    document.body.classList.remove('cart-open');
  }

  renderCartSidebar() {
    const itemsEl = document.getElementById('cartItems');
    const footerEl = document.getElementById('cartFooter');

    if (this.cart.length === 0) {
      itemsEl.innerHTML = `
        <div class="cart-empty">
          <div class="cart-empty-icon">&#x1F6D2;</div>
          <p>Your cart is empty</p>
        </div>
      `;
      footerEl.innerHTML = '';
      return;
    }

    const hasPhysical = this.cart.some(i => i.type === 'physical');
    const subtotal = this.cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const shipping = hasPhysical ? 5.00 : 0;

    itemsEl.innerHTML = this.cart.map(item => `
      <div class="cart-item">
        <div class="cart-item-image">
          ${item.image_url ? `<img src="${this.escapeHtml(item.image_url)}" alt="">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:24px">&#x1F4E6;</div>'}
        </div>
        <div class="cart-item-info">
          <div class="cart-item-name">${this.escapeHtml(item.name)}</div>
          <div class="cart-item-price">$${(item.price * item.quantity).toFixed(2)}</div>
          <div class="cart-item-controls">
            <button class="cart-qty-btn" onclick="app.updateCartItem(${item.product_id}, -1)">-</button>
            <span class="cart-item-qty">${item.quantity}</span>
            <button class="cart-qty-btn" onclick="app.updateCartItem(${item.product_id}, 1)">+</button>
            <button class="cart-remove-btn" onclick="app.removeCartItem(${item.product_id})">Remove</button>
          </div>
        </div>
      </div>
    `).join('');

    footerEl.innerHTML = `
      <div class="cart-total">
        <span>Subtotal</span>
        <span>$${subtotal.toFixed(2)}</span>
      </div>
      ${hasPhysical ? `
      <div class="cart-total" style="font-size:14px;font-weight:400;color:var(--text-secondary)">
        <span>Shipping (USPS)</span>
        <span>$${shipping.toFixed(2)}</span>
      </div>` : ''}
      <p class="cart-shipping-note">${hasPhysical ? 'Tax calculated at checkout' : 'Digital products - no shipping required'}</p>
      <button class="checkout-btn" onclick="app.checkout()" ${!this.config.has_stripe ? 'disabled title="Stripe not configured"' : ''}>
        ${this.config.has_stripe ? 'Proceed to Checkout' : 'Checkout Unavailable'}
      </button>
    `;
  }

  async checkout() {
    if (this.cart.length === 0) return;

    const btn = document.querySelector('.checkout-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Redirecting...';
    }

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: this.cart.map(i => ({ product_id: i.product_id, quantity: i.quantity }))
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }

      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      this.showToast(err.message || 'Checkout failed', 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Proceed to Checkout';
      }
    }
  }

  // ====================== Admin ======================
  renderAdmin(path) {
    const main = document.getElementById('mainContent');

    if (!this.adminToken) {
      this.renderAdminLogin(main);
      return;
    }

    const section = path.replace('/admin', '') || '/dashboard';

    main.innerHTML = `
      <div class="admin-layout">
        <div class="admin-sidebar-overlay" id="adminSidebarOverlay" onclick="app.closeAdminSidebar()"></div>
        <div class="admin-sidebar" id="adminSidebar">
          <div class="admin-nav-item ${section === '/dashboard' ? 'active' : ''}" onclick="app.navigate('/admin/dashboard')">
            <span>&#x1F4CA;</span> Dashboard
          </div>
          <div class="admin-nav-item ${section === '/orders' || section.startsWith('/orders/') ? 'active' : ''}" onclick="app.navigate('/admin/orders')">
            <span>&#x1F4E6;</span> Orders
          </div>
          <div class="admin-nav-item ${section === '/products' ? 'active' : ''}" onclick="app.navigate('/admin/products')">
            <span>&#x1F6CD;</span> Products
          </div>
          <div class="admin-nav-item ${section === '/quotes' ? 'active' : ''}" onclick="app.navigate('/admin/quotes')">
            <span>&#x1F4DD;</span> Quotes
          </div>
          <div class="admin-nav-item" onclick="app.adminLogout()">
            <span>&#x1F6AA;</span> Logout
          </div>
        </div>
        <div class="admin-content" id="adminContent"></div>
      </div>
    `;

    const content = document.getElementById('adminContent');

    if (section === '/dashboard') {
      this.renderAdminDashboard(content);
    } else if (section === '/orders') {
      this.renderAdminOrders(content);
    } else if (section.startsWith('/orders/')) {
      const orderId = section.split('/orders/')[1];
      this.renderAdminOrderDetail(content, orderId);
    } else if (section === '/products') {
      this.renderAdminProducts(content);
    } else if (section === '/quotes') {
      this.renderAdminQuotes(content);
    } else {
      this.renderAdminDashboard(content);
    }
  }

  renderAdminLogin(container) {
    container.innerHTML = `
      <div class="admin-login">
        <h1>Admin Login</h1>
        <form onsubmit="app.adminLogin(event)">
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="adminEmail" required>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="adminPassword" required>
          </div>
          <button type="submit" class="form-submit">Sign In</button>
        </form>
      </div>
    `;
  }

  async adminLogin(e) {
    e.preventDefault();
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('adminEmail').value,
          password: document.getElementById('adminPassword').value
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }
      const data = await res.json();
      this.adminToken = data.token;
      localStorage.setItem('shop_admin_token', data.token);
      this.navigate('/admin/dashboard');
    } catch (err) {
      this.showToast(err.message || 'Login failed', 'error');
    }
  }

  adminLogout() {
    this.adminToken = null;
    localStorage.removeItem('shop_admin_token');
    this.navigate('/');
  }

  async adminFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${this.adminToken}`
      }
    });
    if (res.status === 401) {
      this.adminLogout();
      throw new Error('Session expired');
    }
    return res;
  }

  // Admin Dashboard
  async renderAdminDashboard(container) {
    container.innerHTML = `${this.adminToggleHtml()}<h1>Dashboard</h1><div class="loading-spinner"><div class="spinner"></div></div>`;
    try {
      const res = await this.adminFetch('/api/admin/analytics');
      const data = await res.json();

      container.innerHTML = `
        ${this.adminToggleHtml()}
        <h1>Dashboard</h1>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Total Revenue</div>
            <div class="stat-value">$${data.total_revenue.toFixed(2)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Orders</div>
            <div class="stat-value">${data.order_count}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Active Products</div>
            <div class="stat-value">${data.product_count}</div>
          </div>
        </div>

        ${data.top_products.length > 0 ? `
        <h2 style="font-size:18px;font-weight:600;margin-bottom:16px">Top Products</h2>
        <div class="admin-table-wrapper" style="margin-bottom:32px">
        <table class="admin-table">
          <thead><tr><th>Product</th><th>Units Sold</th><th>Revenue</th></tr></thead>
          <tbody>
            ${data.top_products.map(p => `
              <tr>
                <td>${this.escapeHtml(p.name)}</td>
                <td>${p.total_sold}</td>
                <td>$${parseFloat(p.revenue).toFixed(2)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>` : ''}

        <h2 style="font-size:18px;font-weight:600;margin-bottom:16px">Recent Orders</h2>
        ${data.recent_orders.length > 0 ? `
        <div class="admin-table-wrapper">
        <table class="admin-table">
          <thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${data.recent_orders.map(o => `
              <tr onclick="app.navigate('/admin/orders/${o.id}')" style="cursor:pointer">
                <td>${this.escapeHtml(o.order_number)}</td>
                <td>${this.escapeHtml(o.customer_email)}</td>
                <td>$${parseFloat(o.total).toFixed(2)}</td>
                <td><span class="status-badge status-${o.status}">${o.status}</span></td>
                <td>${new Date(o.created_at).toLocaleDateString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>` : '<p style="color:var(--text-muted)">No orders yet</p>'}
      `;
    } catch (err) {
      container.innerHTML = `${this.adminToggleHtml()}<h1>Dashboard</h1><p>Failed to load analytics</p>`;
    }
  }

  // Admin Orders
  async renderAdminOrders(container) {
    container.innerHTML = `${this.adminToggleHtml()}<h1>Orders</h1><div class="loading-spinner"><div class="spinner"></div></div>`;
    try {
      const res = await this.adminFetch('/api/admin/orders');
      const orders = await res.json();

      container.innerHTML = `
        ${this.adminToggleHtml()}
        <h1>Orders</h1>
        ${orders.length > 0 ? `
        <div class="admin-table-wrapper">
        <table class="admin-table">
          <thead><tr><th>Order #</th><th>Customer</th><th>Total</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
          <tbody>
            ${orders.map(o => `
              <tr>
                <td><strong>${this.escapeHtml(o.order_number)}</strong></td>
                <td>${this.escapeHtml(o.customer_email)}</td>
                <td>$${parseFloat(o.total).toFixed(2)}</td>
                <td><span class="status-badge status-${o.status}">${o.status}</span></td>
                <td>${new Date(o.created_at).toLocaleDateString()}</td>
                <td><button class="admin-btn" onclick="app.navigate('/admin/orders/${o.id}')">View</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>` : '<p style="color:var(--text-muted)">No orders yet</p>'}
      `;
    } catch (err) {
      container.innerHTML = `${this.adminToggleHtml()}<h1>Orders</h1><p>Failed to load orders</p>`;
    }
  }

  // Admin Order Detail
  async renderAdminOrderDetail(container, orderId) {
    container.innerHTML = `${this.adminToggleHtml()}<div class="loading-spinner"><div class="spinner"></div></div>`;
    try {
      const res = await this.adminFetch(`/api/admin/orders/${orderId}`);
      const order = await res.json();
      const shipping = order.shipping_address ? (typeof order.shipping_address === 'string' ? JSON.parse(order.shipping_address) : order.shipping_address) : null;

      container.innerHTML = `
        ${this.adminToggleHtml()}
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
          <button class="admin-btn" onclick="app.navigate('/admin/orders')">&larr; Back</button>
          <h1 style="margin-bottom:0;font-size:18px">Order ${this.escapeHtml(order.order_number)}</h1>
          <span class="status-badge status-${order.status}">${order.status}</span>
        </div>

        <div class="admin-detail-grid">
          <div class="admin-detail-card">
            <h3>Customer</h3>
            <p><strong>${this.escapeHtml(order.customer_name || 'N/A')}</strong></p>
            <p>${this.escapeHtml(order.customer_email)}</p>
          </div>
          ${shipping ? `
          <div class="admin-detail-card">
            <h3>Shipping Address</h3>
            <p>${this.escapeHtml(shipping.address?.line1 || shipping.name || '')}</p>
            ${shipping.address?.line2 ? `<p>${this.escapeHtml(shipping.address.line2)}</p>` : ''}
            <p>${this.escapeHtml(shipping.address?.city || '')}, ${this.escapeHtml(shipping.address?.state || '')} ${this.escapeHtml(shipping.address?.postal_code || '')}</p>
          </div>` : ''}
        </div>

        <div class="admin-table-wrapper" style="margin-bottom:24px">
        <table class="admin-table">
          <thead><tr><th>Product</th><th>Type</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
          <tbody>
            ${(order.items || []).map(item => `
              <tr>
                <td>${this.escapeHtml(item.product_name)}</td>
                <td>${item.type}</td>
                <td>${item.quantity}</td>
                <td>$${parseFloat(item.price).toFixed(2)}</td>
                <td>$${(parseFloat(item.price) * item.quantity).toFixed(2)}</td>
              </tr>
            `).join('')}
            <tr><td colspan="4" style="text-align:right;font-weight:600">Subtotal</td><td>$${parseFloat(order.subtotal).toFixed(2)}</td></tr>
            <tr><td colspan="4" style="text-align:right">Shipping</td><td>$${parseFloat(order.shipping_cost).toFixed(2)}</td></tr>
            ${parseFloat(order.tax) > 0 ? `<tr><td colspan="4" style="text-align:right">Tax</td><td>$${parseFloat(order.tax).toFixed(2)}</td></tr>` : ''}
            <tr style="font-weight:700"><td colspan="4" style="text-align:right">Total</td><td>$${parseFloat(order.total).toFixed(2)}</td></tr>
          </tbody>
        </table>
        </div>

        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <h3 style="width:100%;font-size:14px;color:var(--text-secondary)">Update Status</h3>
          ${['paid', 'shipped', 'fulfilled'].map(s => `
            <button class="admin-btn ${order.status === s ? 'admin-btn-primary' : ''}" onclick="app.updateOrderStatus(${order.id}, '${s}')">${s.charAt(0).toUpperCase() + s.slice(1)}</button>
          `).join('')}
        </div>
      `;
    } catch (err) {
      container.innerHTML = `${this.adminToggleHtml()}<p>Failed to load order</p>`;
    }
  }

  async updateOrderStatus(orderId, status) {
    try {
      await this.adminFetch(`/api/admin/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      this.showToast(`Order marked as ${status}`, 'success');
      this.renderAdmin(`/admin/orders/${orderId}`);
    } catch (err) {
      this.showToast('Failed to update order', 'error');
    }
  }

  // Admin Products
  async renderAdminProducts(container) {
    container.innerHTML = `${this.adminToggleHtml()}<h1>Products</h1><div class="loading-spinner"><div class="spinner"></div></div>`;
    try {
      const res = await this.adminFetch('/api/admin/products');
      const products = await res.json();

      container.innerHTML = `
        ${this.adminToggleHtml()}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:12px">
          <h1 style="margin-bottom:0">Products</h1>
          <button class="admin-btn admin-btn-primary" onclick="app.openProductModal()">+ Add Product</button>
        </div>
        <div class="admin-table-wrapper">
        <table class="admin-table">
          <thead><tr><th>Image</th><th>Name</th><th>Price</th><th>Type</th><th>Stock</th><th>Active</th><th>Actions</th></tr></thead>
          <tbody>
            ${products.map(p => `
              <tr>
                <td>
                  <div style="width:48px;height:48px;border-radius:6px;overflow:hidden;background:var(--bg-secondary)">
                    ${p.image_url ? `<img src="${this.escapeHtml(p.image_url)}" style="width:100%;height:100%;object-fit:cover">` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:20px">&#x1F4E6;</div>'}
                  </div>
                </td>
                <td><strong>${this.escapeHtml(p.name)}</strong></td>
                <td>$${parseFloat(p.price).toFixed(2)}${p.compare_at_price ? ` <s style="color:var(--text-muted)">$${parseFloat(p.compare_at_price).toFixed(2)}</s>` : ''}</td>
                <td>${p.type}</td>
                <td>${p.type === 'digital' ? '&infin;' : p.inventory_quantity}</td>
                <td>${p.active ? '<span style="color:var(--success)">Yes</span>' : '<span style="color:var(--sale)">No</span>'}</td>
                <td>
                  <div class="admin-btn-group">
                    <button class="admin-btn" onclick='app.openProductModal(${JSON.stringify(p).replace(/'/g, "&#39;")})'>Edit</button>
                    <button class="admin-btn admin-btn-danger" onclick="app.deleteProduct(${p.id})">Delete</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>

        <div class="modal-overlay" id="productModal">
          <div class="modal">
            <div class="modal-header">
              <h2 id="productModalTitle">Add Product</h2>
              <button class="close-btn" onclick="app.closeProductModal()">&times;</button>
            </div>
            <div class="modal-body">
              <form id="productForm" onsubmit="app.saveProduct(event)">
                <input type="hidden" id="productId">
                <div class="form-group">
                  <label>Product Name *</label>
                  <input type="text" id="prodName" required>
                </div>
                <div class="form-group">
                  <label>Description</label>
                  <textarea id="prodDesc"></textarea>
                </div>
                <div class="form-grid-2col">
                  <div class="form-group">
                    <label>Price *</label>
                    <input type="number" id="prodPrice" step="0.01" min="0" required>
                  </div>
                  <div class="form-group">
                    <label>Compare at Price</label>
                    <input type="number" id="prodComparePrice" step="0.01" min="0">
                  </div>
                </div>
                <div class="form-grid-2col">
                  <div class="form-group">
                    <label>Type</label>
                    <select id="prodType">
                      <option value="physical">Physical</option>
                      <option value="digital">Digital</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label>SKU</label>
                    <input type="text" id="prodSku">
                  </div>
                </div>
                <div class="form-grid-2col">
                  <div class="form-group">
                    <label>Inventory Quantity</label>
                    <input type="number" id="prodStock" min="0" value="0">
                  </div>
                  <div class="form-group">
                    <label>Sort Order</label>
                    <input type="number" id="prodSort" value="0">
                  </div>
                </div>
                <div class="form-group">
                  <label>Product Image</label>
                  <div class="image-preview" id="imagePreview" style="display:none"></div>
                  <input type="file" id="prodImage" accept="image/*">
                </div>
                <div class="form-group">
                  <label>
                    <input type="checkbox" id="prodActive" checked> Active (visible in store)
                  </label>
                </div>
              </form>
            </div>
            <div class="modal-footer">
              <button class="admin-btn" onclick="app.closeProductModal()">Cancel</button>
              <button class="admin-btn admin-btn-primary" onclick="document.getElementById('productForm').requestSubmit()">Save</button>
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `${this.adminToggleHtml()}<h1>Products</h1><p>Failed to load products</p>`;
    }
  }

  openProductModal(product) {
    document.getElementById('productModal').classList.add('open');
    document.getElementById('productModalTitle').textContent = product ? 'Edit Product' : 'Add Product';
    document.getElementById('productId').value = product ? product.id : '';
    document.getElementById('prodName').value = product ? product.name : '';
    document.getElementById('prodDesc').value = product ? (product.description || '') : '';
    document.getElementById('prodPrice').value = product ? product.price : '';
    document.getElementById('prodComparePrice').value = product?.compare_at_price || '';
    document.getElementById('prodType').value = product ? product.type : 'physical';
    document.getElementById('prodSku').value = product?.sku || '';
    document.getElementById('prodStock').value = product ? product.inventory_quantity : 0;
    document.getElementById('prodSort').value = product ? (product.sort_order || 0) : 0;
    document.getElementById('prodActive').checked = product ? product.active : true;

    const preview = document.getElementById('imagePreview');
    if (product?.image_url) {
      preview.innerHTML = `<img src="${this.escapeHtml(product.image_url)}" alt="">`;
      preview.style.display = 'block';
    } else {
      preview.style.display = 'none';
    }
  }

  closeProductModal() {
    document.getElementById('productModal')?.classList.remove('open');
  }

  async saveProduct(e) {
    e.preventDefault();
    const id = document.getElementById('productId').value;
    const formData = new FormData();
    formData.append('name', document.getElementById('prodName').value);
    formData.append('description', document.getElementById('prodDesc').value);
    formData.append('price', document.getElementById('prodPrice').value);
    formData.append('compare_at_price', document.getElementById('prodComparePrice').value);
    formData.append('type', document.getElementById('prodType').value);
    formData.append('sku', document.getElementById('prodSku').value);
    formData.append('inventory_quantity', document.getElementById('prodStock').value);
    formData.append('sort_order', document.getElementById('prodSort').value);
    formData.append('active', document.getElementById('prodActive').checked);

    const imageFile = document.getElementById('prodImage').files[0];
    if (imageFile) formData.append('image', imageFile);

    try {
      const url = id ? `/api/admin/products/${id}` : '/api/admin/products';
      const method = id ? 'PUT' : 'POST';
      const res = await this.adminFetch(url, { method, body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }
      this.closeProductModal();
      this.showToast(id ? 'Product updated' : 'Product created', 'success');
      await this.loadProducts();
      this.renderAdmin('/admin/products');
    } catch (err) {
      this.showToast(err.message || 'Failed to save product', 'error');
    }
  }

  async deleteProduct(id) {
    if (!confirm('Are you sure you want to delete this product?')) return;
    try {
      await this.adminFetch(`/api/admin/products/${id}`, { method: 'DELETE' });
      this.showToast('Product deleted', 'success');
      await this.loadProducts();
      this.renderAdmin('/admin/products');
    } catch (err) {
      this.showToast('Failed to delete product', 'error');
    }
  }

  // Admin Quotes
  async renderAdminQuotes(container) {
    container.innerHTML = `${this.adminToggleHtml()}<h1>Custom Quotes</h1><div class="loading-spinner"><div class="spinner"></div></div>`;
    try {
      const res = await this.adminFetch('/api/admin/quotes');
      const quotes = await res.json();

      container.innerHTML = `
        ${this.adminToggleHtml()}
        <h1>Custom Quotes</h1>
        ${quotes.length > 0 ? `
        <div class="admin-table-wrapper">
        <table class="admin-table">
          <thead><tr><th>Name</th><th>Email</th><th>Description</th><th>File</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
          <tbody>
            ${quotes.map(q => `
              <tr>
                <td>${this.escapeHtml(q.customer_name)}</td>
                <td><a href="mailto:${this.escapeHtml(q.customer_email)}">${this.escapeHtml(q.customer_email)}</a></td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.escapeHtml(q.description)}">${this.escapeHtml(q.description)}</td>
                <td>${q.file_url ? `<a href="${q.file_url}" target="_blank" class="admin-btn" style="font-size:12px">Download</a>` : '-'}</td>
                <td><span class="status-badge status-${q.status}">${q.status}</span></td>
                <td>${new Date(q.created_at).toLocaleDateString()}</td>
                <td>
                  <select onchange="app.updateQuoteStatus(${q.id}, this.value)" style="padding:8px 12px;border:1px solid var(--border);border-radius:4px;font-size:14px;min-height:44px">
                    ${['pending', 'quoted', 'accepted', 'rejected'].map(s =>
                      `<option value="${s}" ${q.status === s ? 'selected' : ''}>${s}</option>`
                    ).join('')}
                  </select>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>` : '<p style="color:var(--text-muted)">No quote requests yet</p>'}
      `;
    } catch (err) {
      container.innerHTML = `${this.adminToggleHtml()}<h1>Custom Quotes</h1><p>Failed to load quotes</p>`;
    }
  }

  async updateQuoteStatus(id, status) {
    try {
      await this.adminFetch(`/api/admin/quotes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      this.showToast(`Quote marked as ${status}`, 'success');
    } catch (err) {
      this.showToast('Failed to update quote', 'error');
    }
  }

  // ====================== 404 ======================
  render404(container) {
    container.innerHTML = `
      <div class="info-page" style="text-align:center;padding:80px 24px">
        <h1 style="font-size:72px;margin-bottom:8px">404</h1>
        <p style="font-size:18px;margin-bottom:32px">Page not found</p>
        <a href="/" data-link class="hero-cta" style="color:white;background:var(--accent)">Go Home</a>
      </div>
    `;
  }

  // ====================== Utilities ======================
  toggleMobileMenu() {
    const nav = document.getElementById('mainNav');
    if (!nav) return;
    const isOpen = nav.classList.toggle('open');
    document.body.classList.toggle('menu-open', isOpen);
  }

  closeMobileMenu() {
    document.getElementById('mainNav')?.classList.remove('open');
    document.body.classList.remove('menu-open');
  }

  adminToggleHtml() {
    return `<button class="admin-menu-toggle" onclick="app.toggleAdminSidebar()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      Menu
    </button>`;
  }

  toggleAdminSidebar() {
    document.getElementById('adminSidebar')?.classList.toggle('open');
    document.getElementById('adminSidebarOverlay')?.classList.toggle('open');
  }

  closeAdminSidebar() {
    document.getElementById('adminSidebar')?.classList.remove('open');
    document.getElementById('adminSidebarOverlay')?.classList.remove('open');
  }

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  showToast(message, type = '') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

// ====================== Initialize ======================
const app = new ShopApp();
