class BudgetApp {
    constructor() {
        this.currentView = 'dashboard';
        this.currentMonth = new Date().getMonth() + 1;
        this.currentYear = new Date().getFullYear();
        this.categories = [];
        this.transactions = [];
        this.budgets = [];
        this.categoryChart = null;
        this.trendsChart = null;
        this.savingsChart = null;
        this.init();
    }

    async init() {
        this.initEventListeners();
        this.updateDateDisplay();
        await this.loadCategories();
        this.switchView('dashboard');
    }

    initEventListeners() {
        // Bottom nav
        document.querySelectorAll('.bottom-nav-item').forEach(btn => {
            btn.addEventListener('click', () => this.switchView(btn.dataset.view));
        });

        // Date nav
        document.getElementById('prevMonth').addEventListener('click', () => this.changeMonth(-1));
        document.getElementById('nextMonth').addEventListener('click', () => this.changeMonth(1));

        // FAB
        document.getElementById('fab').addEventListener('click', () => {
            if (this.currentView === 'budgets') this.openBudgetModal();
            else if (this.currentView === 'categories') this.openCategoryModal();
            else this.openTransactionModal();
        });

        // View all transactions
        document.getElementById('viewAllTransactions').addEventListener('click', () => this.switchView('transactions'));

        // Filter chips
        document.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                this.loadTransactions();
            });
        });

        document.getElementById('categoryFilter').addEventListener('change', () => this.loadTransactions());

        // Export CSV
        document.getElementById('exportCsv').addEventListener('click', () => this.exportCsv());

        // Type toggle in transaction modal
        document.querySelectorAll('.type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.querySelector('[name="type"]').value = btn.dataset.type;
                this.updateTransactionCategorySelects();
            });
        });

        // Forms
        document.getElementById('transaction-form').addEventListener('submit', e => { e.preventDefault(); this.saveTransaction(); });
        document.getElementById('category-form').addEventListener('submit', e => { e.preventDefault(); this.saveCategory(); });
        document.getElementById('budget-form').addEventListener('submit', e => { e.preventDefault(); this.saveBudget(); });

        // Modal overlay close
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('active'); });
        });
    }

    changeMonth(delta) {
        this.currentMonth += delta;
        if (this.currentMonth > 12) { this.currentMonth = 1; this.currentYear++; }
        if (this.currentMonth < 1) { this.currentMonth = 12; this.currentYear--; }
        this.updateDateDisplay();
        this.refreshCurrentView();
    }

    updateDateDisplay() {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        document.getElementById('dateDisplay').textContent = `${months[this.currentMonth - 1]} ${this.currentYear}`;
    }

    switchView(viewName) {
        document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === viewName));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(`${viewName}-view`).classList.add('active');
        this.currentView = viewName;

        switch (viewName) {
            case 'dashboard': this.loadDashboard(); break;
            case 'transactions': this.loadTransactions(); break;
            case 'categories': this.loadCategories().then(() => this.renderCategories()); break;
            case 'budgets': this.loadBudgets(); break;
            case 'trends': this.loadTrends(); break;
        }
    }

    refreshCurrentView() { this.switchView(this.currentView); }

    // ─── Dashboard ───
    async loadDashboard() {
        try {
            const [dashRes, txRes, budgetRes] = await Promise.all([
                fetch(`/api/dashboard?month=${this.currentMonth}&year=${this.currentYear}`),
                fetch(`/api/transactions?month=${this.currentMonth}&year=${this.currentYear}`),
                fetch(`/api/budgets?month=${this.currentMonth}&year=${this.currentYear}`)
            ]);
            const data = await dashRes.json();
            const txs = await txRes.json();
            const budgets = await budgetRes.json();

            this.animateValue('total-income', data.income);
            this.animateValue('total-expenses', data.expenses);

            const savingsEl = document.getElementById('net-savings');
            this.animateValue('net-savings', data.netSavings);
            savingsEl.classList.toggle('negative', data.netSavings < 0);

            this.renderCategoryChart(data.categoryBreakdown);
            this.renderRecentTransactions(txs.slice(0, 5));
            this.renderBudgetRings(budgets);
            this.checkRecurring();
        } catch (err) { console.error('Dashboard error:', err); }
    }

    animateValue(id, target) {
        const el = document.getElementById(id);
        el.textContent = this.formatCurrency(target);
    }

    renderCategoryChart(categoryData) {
        const ctx = document.getElementById('categoryChart');
        if (this.categoryChart) this.categoryChart.destroy();

        const legend = document.getElementById('category-legend');

        if (!categoryData.length) {
            ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height);
            legend.innerHTML = '<div class="empty-state"><p>No expenses this month</p></div>';
            return;
        }

        legend.innerHTML = categoryData.map(c =>
            `<div class="legend-item"><span class="legend-dot" style="background:${c.color}"></span>${c.name}: ${this.formatCurrency(c.total)}</div>`
        ).join('');

        this.categoryChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: categoryData.map(c => c.name),
                datasets: [{
                    data: categoryData.map(c => c.total),
                    backgroundColor: categoryData.map(c => c.color),
                    borderWidth: 0,
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(20,20,30,0.9)',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        titleColor: '#f0f0f5',
                        bodyColor: '#f0f0f5',
                        cornerRadius: 10,
                        padding: 12,
                        callbacks: { label: ctx => ` ${this.formatCurrency(ctx.raw)}` }
                    }
                },
                animation: { animateRotate: true, duration: 800 }
            }
        });
    }

    renderRecentTransactions(txs) {
        const container = document.getElementById('recent-transactions');
        if (!txs.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💳</div><p>No transactions yet</p></div>';
            return;
        }
        container.innerHTML = txs.map((tx, i) => this.transactionHTML(tx, i, false)).join('');
    }

    renderBudgetRings(budgets) {
        const section = document.getElementById('budget-overview-section');
        const container = document.getElementById('ring-container');
        if (!budgets.length) { section.style.display = 'none'; return; }
        section.style.display = '';

        container.innerHTML = budgets.map(b => {
            const pct = Math.min((b.spent / b.amount) * 100, 100);
            const r = 26;
            const circ = 2 * Math.PI * r;
            const offset = circ - (pct / 100) * circ;
            const color = pct < 70 ? 'var(--income)' : pct < 90 ? 'var(--warning)' : 'var(--expense)';
            const cat = this.categories.find(c => c.id === b.category_id);
            return `<div class="ring-item">
                <svg class="ring-svg" viewBox="0 0 60 60">
                    <circle class="ring-bg" cx="30" cy="30" r="${r}"/>
                    <circle class="ring-fill" cx="30" cy="30" r="${r}" stroke="${color}"
                        stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
                </svg>
                <span class="ring-percent">${Math.round(pct)}%</span>
                <span class="ring-label">${cat?.icon || ''} ${b.category_name}</span>
            </div>`;
        }).join('');
    }

    // ─── Transactions ───
    async loadTransactions() {
        const activeChip = document.querySelector('.chip.active');
        const type = activeChip ? activeChip.dataset.type : '';
        const category = document.getElementById('categoryFilter').value;

        let url = `/api/transactions?month=${this.currentMonth}&year=${this.currentYear}`;
        if (type) url += `&type=${type}`;
        if (category) url += `&category=${category}`;

        const res = await fetch(url);
        this.transactions = await res.json();
        this.renderTransactions();
        this.updateCategoryFilter();
        this.loadSummary();
    }

    renderTransactions() {
        const container = document.getElementById('transaction-list');
        if (!this.transactions.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💳</div><p>No transactions found</p></div>';
            return;
        }
        container.innerHTML = this.transactions.map((tx, i) => this.transactionHTML(tx, i, true)).join('');
    }

    transactionHTML(tx, index, showActions) {
        const delay = Math.min(index * 40, 300);
        return `<div class="transaction-item stagger-in" style="animation-delay:${delay}ms" onclick="app.toggleTxActions(this)">
            <div class="tx-icon" style="background:${tx.category_color}15; color:${tx.category_color}">${tx.category_icon}</div>
            <div class="tx-details">
                <div class="tx-name">${tx.description || tx.category_name}</div>
                <div class="tx-meta">${tx.category_name}${tx.recurring ? ' 🔄' : ''}</div>
            </div>
            <div class="tx-right">
                <div class="tx-amount ${tx.type}">${tx.type === 'income' ? '+' : '-'}${this.formatCurrency(tx.amount)}</div>
                <div class="tx-date-small">${new Date(tx.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
            </div>
            ${showActions ? `<div class="tx-actions">
                <button class="tx-action-btn tx-action-edit" onclick="event.stopPropagation(); app.editTransaction(${tx.id})">Edit</button>
                <button class="tx-action-btn tx-action-delete" onclick="event.stopPropagation(); app.deleteTransaction(${tx.id})">Delete</button>
            </div>` : ''}
        </div>`;
    }

    toggleTxActions(el) {
        const actions = el.querySelector('.tx-actions');
        if (actions) actions.classList.toggle('show');
    }

    updateCategoryFilter() {
        const select = document.getElementById('categoryFilter');
        const val = select.value;
        select.innerHTML = '<option value="">All Categories</option>';
        this.categories.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = `${c.icon} ${c.name}`;
            if (c.id.toString() === val) opt.selected = true;
            select.appendChild(opt);
        });
    }

    // ─── Categories ───
    async loadCategories() {
        const res = await fetch('/api/categories');
        this.categories = await res.json();
        this.updateTransactionCategorySelects();
        this.updateBudgetCategorySelect();
    }

    renderCategories() {
        const container = document.getElementById('category-grid');
        container.innerHTML = this.categories.map((c, i) => {
            const delay = Math.min(i * 40, 400);
            return `<div class="category-item stagger-in" style="animation-delay:${delay}ms; border-left: 3px solid ${c.color}">
                <div class="cat-icon">${c.icon}</div>
                <div class="cat-name">${c.name}</div>
                <div class="cat-type">${c.type}</div>
                ${!c.is_default ? `<button class="cat-delete" onclick="app.deleteCategory(${c.id})">×</button>` : ''}
            </div>`;
        }).join('');
    }

    updateTransactionCategorySelects() {
        const select = document.getElementById('transaction-category-select');
        const currentType = document.querySelector('[name="type"]').value;
        const val = select.value;
        select.innerHTML = '';
        this.categories
            .filter(c => c.type === currentType || c.type === 'both')
            .forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = `${c.icon} ${c.name}`;
                if (c.id.toString() === val) opt.selected = true;
                select.appendChild(opt);
            });
    }

    updateBudgetCategorySelect() {
        const select = document.getElementById('budget-category-select');
        if (!select) return;
        const val = select.value;
        select.innerHTML = '';
        this.categories.filter(c => c.type === 'expense' || c.type === 'both').forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = `${c.icon} ${c.name}`;
            if (c.id.toString() === val) opt.selected = true;
            select.appendChild(opt);
        });
    }

    // ─── Budgets ───
    async loadBudgets() {
        const res = await fetch(`/api/budgets?month=${this.currentMonth}&year=${this.currentYear}`);
        this.budgets = await res.json();
        this.renderBudgets();
    }

    renderBudgets() {
        const container = document.getElementById('budget-list');
        if (!this.budgets.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎯</div><p>No budgets set</p></div>';
            return;
        }
        container.innerHTML = this.budgets.map((b, i) => {
            const pct = (b.spent / b.amount) * 100;
            const cls = pct < 70 ? 'low' : pct < 90 ? 'medium' : 'high';
            const cat = this.categories.find(c => c.id === b.category_id);
            const delay = Math.min(i * 50, 300);
            return `<div class="budget-item stagger-in" style="animation-delay:${delay}ms">
                <div class="budget-top">
                    <div class="budget-cat">
                        <span class="budget-cat-icon">${cat?.icon || '🏷️'}</span>
                        <span class="budget-cat-name">${b.category_name}</span>
                    </div>
                    <button class="budget-delete" onclick="app.deleteBudget(${b.id})">×</button>
                </div>
                <div class="progress-track">
                    <div class="progress-fill ${cls}" style="width:${Math.min(pct, 100)}%"></div>
                </div>
                <div class="progress-labels">
                    <span>${this.formatCurrency(b.spent)} spent</span>
                    <span>${this.formatCurrency(b.amount)} limit</span>
                </div>
            </div>`;
        }).join('');
    }

    // ─── Trends ───
    async loadTrends() {
        const res = await fetch('/api/trends?months=6');
        const trends = await res.json();
        this.renderTrendsChart(trends);
        this.renderSavingsChart(trends);
    }

    renderTrendsChart(data) {
        const ctx = document.getElementById('trendsChart');
        if (this.trendsChart) this.trendsChart.destroy();

        const labels = data.map(d => {
            const date = new Date(d.month + '-01');
            return date.toLocaleDateString('en-US', { month: 'short' });
        });

        this.trendsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { label: 'Income', data: data.map(d => d.income), backgroundColor: 'rgba(0,217,166,0.6)', borderRadius: 6, barPercentage: 0.4 },
                    { label: 'Expenses', data: data.map(d => d.expenses), backgroundColor: 'rgba(255,92,114,0.6)', borderRadius: 6, barPercentage: 0.4 }
                ]
            },
            options: this.chartOptions()
        });
    }

    renderSavingsChart(data) {
        const ctx = document.getElementById('savingsChart');
        if (this.savingsChart) this.savingsChart.destroy();

        const labels = data.map(d => {
            const date = new Date(d.month + '-01');
            return date.toLocaleDateString('en-US', { month: 'short' });
        });

        const savings = data.map(d => d.income - d.expenses);

        this.savingsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Net Savings',
                    data: savings,
                    borderColor: '#7c6cff',
                    backgroundColor: 'rgba(124,108,255,0.1)',
                    fill: true,
                    tension: 0.4,
                    pointBackgroundColor: '#7c6cff',
                    pointRadius: 4
                }]
            },
            options: this.chartOptions()
        });
    }

    chartOptions() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: 'rgba(255,255,255,0.3)', callback: v => '$' + v.toLocaleString(), font: { size: 11 } },
                    grid: { color: 'rgba(255,255,255,0.04)' }
                },
                x: {
                    ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 11 } },
                    grid: { display: false }
                }
            },
            plugins: {
                legend: { labels: { color: 'rgba(255,255,255,0.5)', font: { size: 12 }, usePointStyle: true, pointStyle: 'circle' } },
                tooltip: {
                    backgroundColor: 'rgba(20,20,30,0.9)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    titleColor: '#f0f0f5',
                    bodyColor: '#f0f0f5',
                    cornerRadius: 10,
                    padding: 12,
                    callbacks: { label: ctx => ` ${ctx.dataset.label}: ${this.formatCurrency(ctx.raw)}` }
                }
            },
            animation: { duration: 600 }
        };
    }

    // ─── Modals ───
    openTransactionModal(tx = null) {
        const modal = document.getElementById('transaction-modal');
        const form = document.getElementById('transaction-form');
        const title = document.getElementById('transaction-modal-title');

        if (tx) {
            title.textContent = 'Edit Transaction';
            form.elements.type.value = tx.type;
            document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === tx.type));
            form.elements.amount.value = tx.amount;
            form.elements.category_id.value = tx.category_id;
            form.elements.description.value = tx.description || '';
            form.elements.date.value = tx.date;
            form.elements.recurring.checked = tx.recurring;
            form.dataset.id = tx.id;
        } else {
            title.textContent = 'Add Transaction';
            form.reset();
            form.elements.type.value = 'expense';
            document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'expense'));
            form.elements.date.value = new Date().toISOString().split('T')[0];
            delete form.dataset.id;
        }
        this.updateTransactionCategorySelects();
        if (tx) form.elements.category_id.value = tx.category_id;
        modal.classList.add('active');
    }

    closeTransactionModal() { document.getElementById('transaction-modal').classList.remove('active'); }

    async saveTransaction() {
        const form = document.getElementById('transaction-form');
        const data = Object.fromEntries(new FormData(form).entries());
        data.recurring = form.elements.recurring.checked;

        const method = form.dataset.id ? 'PUT' : 'POST';
        const url = form.dataset.id ? `/api/transactions/${form.dataset.id}` : '/api/transactions';

        const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { this.closeTransactionModal(); this.refreshCurrentView(); }
    }

    editTransaction(id) {
        const tx = this.transactions.find(t => t.id === id);
        if (tx) this.openTransactionModal(tx);
    }

    async deleteTransaction(id) {
        if (!confirm('Delete this transaction?')) return;
        const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
        if (res.ok) this.refreshCurrentView();
    }

    openCategoryModal() { document.getElementById('category-modal').classList.add('active'); }
    closeCategoryModal() { document.getElementById('category-modal').classList.remove('active'); document.getElementById('category-form').reset(); }

    async saveCategory() {
        const data = Object.fromEntries(new FormData(document.getElementById('category-form')).entries());
        const res = await fetch('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { this.closeCategoryModal(); await this.loadCategories(); this.renderCategories(); }
    }

    async deleteCategory(id) {
        if (!confirm('Delete this category?')) return;
        const res = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
        if (res.ok) { await this.loadCategories(); this.renderCategories(); }
    }

    openBudgetModal() { document.getElementById('budget-modal').classList.add('active'); }
    closeBudgetModal() { document.getElementById('budget-modal').classList.remove('active'); document.getElementById('budget-form').reset(); }

    async saveBudget() {
        const data = Object.fromEntries(new FormData(document.getElementById('budget-form')).entries());
        data.month = this.currentMonth;
        data.year = this.currentYear;
        const res = await fetch('/api/budgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { this.closeBudgetModal(); this.loadBudgets(); }
    }

    async deleteBudget(id) {
        if (!confirm('Delete this budget?')) return;
        const res = await fetch(`/api/budgets/${id}`, { method: 'DELETE' });
        if (res.ok) this.loadBudgets();
    }

    exportCsv() {
        const m = this.currentMonth.toString().padStart(2, '0');
        const month = `${this.currentYear}-${m}`;
        window.location.href = `/api/transactions/export?month=${month}`;
    }

    async loadSummary() {
        try {
            const res = await fetch(`/api/summary?month=${this.currentMonth}&year=${this.currentYear}`);
            const data = await res.json();
            document.getElementById('summary-income').textContent = this.formatCurrency(data.income);
            document.getElementById('summary-expenses').textContent = this.formatCurrency(data.expenses);
            const netEl = document.getElementById('summary-net');
            netEl.textContent = this.formatCurrency(data.netSavings);
            netEl.className = 'stat-value ' + (data.netSavings >= 0 ? 'positive' : 'negative');
            document.getElementById('summary-top-cat').textContent = data.topCategory !== 'N/A' ? `${data.topCategory} (${this.formatCurrency(data.topCategoryAmount)})` : '—';
            const comp = document.getElementById('summary-comparison');
            if (data.prevExpenses > 0) {
                const arrow = data.pctChange > 0 ? '↑' : data.pctChange < 0 ? '↓' : '→';
                const cls = data.pctChange > 0 ? 'up' : data.pctChange < 0 ? 'down' : 'neutral';
                comp.innerHTML = `<span class="${cls}">${arrow} ${Math.abs(data.pctChange)}%</span> vs last month spending`;
            } else {
                comp.innerHTML = '<span class="neutral">No data from last month</span>';
            }
        } catch (err) { console.error('Summary error:', err); }
    }

    // ─── Recurring ───
    async checkRecurring() {
        try {
            const res = await fetch(`/api/transactions/recurring/status?month=${this.currentMonth}&year=${this.currentYear}`);
            const data = await res.json();
            const banner = document.getElementById("recurring-banner");
            if (data.pending > 0) {
                banner.style.display = "";
                document.getElementById("recurring-count").textContent = data.pending;
                const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                document.getElementById("recurring-month-name").textContent = months[this.currentMonth - 1] + " " + this.currentYear;
            } else {
                banner.style.display = "none";
            }
        } catch (err) { console.error("Recurring check error:", err); }
    }

    async generateRecurring() {
        try {
            const btn = document.getElementById("generateRecurringBtn");
            btn.disabled = true;
            btn.textContent = "Generating...";
            const res = await fetch(`/api/transactions/generate-recurring?month=${this.currentMonth}&year=${this.currentYear}`, { method: "POST" });
            const data = await res.json();
            btn.textContent = `✓ ${data.generated} generated`;
            setTimeout(() => { btn.disabled = false; btn.textContent = "Generate"; this.refreshCurrentView(); }, 1500);
        } catch (err) { console.error("Generate error:", err); }
    }

    formatCurrency(amount) {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
    }
}

const app = new BudgetApp();
