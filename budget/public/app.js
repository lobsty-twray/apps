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
        
        this.init();
    }

    async init() {
        this.initEventListeners();
        this.initDateSelectors();
        await this.loadCategories();
        this.switchView('dashboard');
    }

    initEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const view = e.target.dataset.view;
                this.switchView(view);
            });
        });

        // Date selectors
        document.getElementById('monthSelect').addEventListener('change', (e) => {
            this.currentMonth = parseInt(e.target.value);
            this.refreshCurrentView();
        });

        document.getElementById('yearSelect').addEventListener('change', (e) => {
            this.currentYear = parseInt(e.target.value);
            this.refreshCurrentView();
        });

        // Filters
        document.getElementById('typeFilter').addEventListener('change', () => {
            this.loadTransactions();
        });

        document.getElementById('categoryFilter').addEventListener('change', () => {
            this.loadTransactions();
        });

        // Forms
        document.getElementById('transaction-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveTransaction();
        });

        document.getElementById('category-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveCategory();
        });

        document.getElementById('budget-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveBudget();
        });

        // Modal close on background click
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        });
    }

    initDateSelectors() {
        const monthSelect = document.getElementById('monthSelect');
        const yearSelect = document.getElementById('yearSelect');
        
        monthSelect.value = this.currentMonth;
        
        // Populate year selector
        const currentYear = new Date().getFullYear();
        for (let year = currentYear - 5; year <= currentYear + 1; year++) {
            const option = document.createElement('option');
            option.value = year;
            option.textContent = year;
            if (year === this.currentYear) option.selected = true;
            yearSelect.appendChild(option);
        }
    }

    async switchView(viewName) {
        // Update navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-view="${viewName}"]`).classList.add('active');

        // Update views
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });
        document.getElementById(`${viewName}-view`).classList.add('active');

        this.currentView = viewName;

        // Load view data
        switch (viewName) {
            case 'dashboard':
                await this.loadDashboard();
                break;
            case 'transactions':
                await this.loadTransactions();
                break;
            case 'categories':
                await this.loadCategories();
                this.renderCategories();
                break;
            case 'budgets':
                await this.loadBudgets();
                break;
            case 'trends':
                await this.loadTrends();
                break;
        }
    }

    async refreshCurrentView() {
        await this.switchView(this.currentView);
    }

    async loadDashboard() {
        try {
            const response = await fetch(`/api/dashboard?month=${this.currentMonth}&year=${this.currentYear}`);
            const data = await response.json();

            document.getElementById('total-income').textContent = this.formatCurrency(data.income);
            document.getElementById('total-expenses').textContent = this.formatCurrency(data.expenses);
            
            const netSavings = document.getElementById('net-savings');
            netSavings.textContent = this.formatCurrency(data.netSavings);
            netSavings.className = `amount ${data.netSavings >= 0 ? 'income' : 'expense'}`;

            this.renderCategoryChart(data.categoryBreakdown);
        } catch (error) {
            console.error('Error loading dashboard:', error);
        }
    }

    renderCategoryChart(categoryData) {
        const ctx = document.getElementById('categoryChart').getContext('2d');
        
        if (this.categoryChart) {
            this.categoryChart.destroy();
        }

        if (categoryData.length === 0) {
            ctx.font = '16px system-ui';
            ctx.fillStyle = '#999';
            ctx.textAlign = 'center';
            ctx.fillText('No expenses this month', ctx.canvas.width / 2, ctx.canvas.height / 2);
            return;
        }

        this.categoryChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: categoryData.map(item => item.name),
                datasets: [{
                    data: categoryData.map(item => item.total),
                    backgroundColor: categoryData.map(item => item.color),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: '#ffffff',
                            font: {
                                size: 14
                            },
                            generateLabels: function(chart) {
                                const data = chart.data;
                                return data.labels.map((label, i) => ({
                                    text: `${label}: ${this.formatCurrency(data.datasets[0].data[i])}`,
                                    fillStyle: data.datasets[0].backgroundColor[i],
                                    hidden: false,
                                    index: i
                                }));
                            }.bind(this)
                        }
                    }
                }
            }
        });
    }

    async loadTransactions() {
        try {
            const typeFilter = document.getElementById('typeFilter').value;
            const categoryFilter = document.getElementById('categoryFilter').value;
            
            let url = `/api/transactions?month=${this.currentMonth}&year=${this.currentYear}`;
            if (typeFilter) url += `&type=${typeFilter}`;
            if (categoryFilter) url += `&category=${categoryFilter}`;

            const response = await fetch(url);
            this.transactions = await response.json();
            this.renderTransactions();
            this.updateCategoryFilter();
        } catch (error) {
            console.error('Error loading transactions:', error);
        }
    }

    renderTransactions() {
        const container = document.getElementById('transaction-list');
        
        if (this.transactions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">💳</div>
                    <p>No transactions found</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.transactions.map(transaction => `
            <div class="transaction-item">
                <div class="transaction-info">
                    <div class="transaction-icon" style="background-color: ${transaction.category_color}20; color: ${transaction.category_color};">
                        ${transaction.category_icon}
                    </div>
                    <div class="transaction-details">
                        <h4>${transaction.description || transaction.category_name}</h4>
                        <div class="transaction-meta">
                            ${transaction.category_name} • ${new Date(transaction.date).toLocaleDateString()}
                            ${transaction.recurring ? ' • Recurring' : ''}
                        </div>
                    </div>
                </div>
                <div class="transaction-amount ${transaction.type}">
                    ${transaction.type === 'income' ? '+' : '-'}${this.formatCurrency(transaction.amount)}
                </div>
                <div class="transaction-actions">
                    <button class="btn btn-small btn-secondary" onclick="app.editTransaction(${transaction.id})">Edit</button>
                    <button class="btn btn-small btn-danger" onclick="app.deleteTransaction(${transaction.id})">Delete</button>
                </div>
            </div>
        `).join('');
    }

    updateCategoryFilter() {
        const categoryFilter = document.getElementById('categoryFilter');
        const currentValue = categoryFilter.value;
        
        categoryFilter.innerHTML = '<option value="">All Categories</option>';
        this.categories.forEach(category => {
            const option = document.createElement('option');
            option.value = category.id;
            option.textContent = category.name;
            if (category.id.toString() === currentValue) option.selected = true;
            categoryFilter.appendChild(option);
        });
    }

    async loadCategories() {
        try {
            const response = await fetch('/api/categories');
            this.categories = await response.json();
            this.updateTransactionCategorySelects();
            this.updateBudgetCategorySelect();
        } catch (error) {
            console.error('Error loading categories:', error);
        }
    }

    renderCategories() {
        const container = document.getElementById('category-grid');
        
        container.innerHTML = this.categories.map(category => `
            <div class="category-item">
                <div class="category-icon" style="color: ${category.color};">${category.icon}</div>
                <div class="category-name">${category.name}</div>
                <div class="category-type">${category.type}</div>
                ${!category.is_default ? `
                    <div class="category-actions">
                        <button class="btn btn-small btn-danger" onclick="app.deleteCategory(${category.id})">×</button>
                    </div>
                ` : ''}
            </div>
        `).join('');
    }

    updateTransactionCategorySelects() {
        const selects = document.querySelectorAll('#transaction-category-select');
        selects.forEach(select => {
            const currentValue = select.value;
            select.innerHTML = '';
            
            this.categories.forEach(category => {
                const option = document.createElement('option');
                option.value = category.id;
                option.textContent = `${category.icon} ${category.name}`;
                if (category.id.toString() === currentValue) option.selected = true;
                select.appendChild(option);
            });
        });
    }

    updateBudgetCategorySelect() {
        const select = document.getElementById('budget-category-select');
        const currentValue = select.value;
        
        select.innerHTML = '';
        this.categories.filter(c => c.type === 'expense' || c.type === 'both').forEach(category => {
            const option = document.createElement('option');
            option.value = category.id;
            option.textContent = `${category.icon} ${category.name}`;
            if (category.id.toString() === currentValue) option.selected = true;
            select.appendChild(option);
        });
    }

    async loadBudgets() {
        try {
            const response = await fetch(`/api/budgets?month=${this.currentMonth}&year=${this.currentYear}`);
            this.budgets = await response.json();
            this.renderBudgets();
        } catch (error) {
            console.error('Error loading budgets:', error);
        }
    }

    renderBudgets() {
        const container = document.getElementById('budget-list');
        
        if (this.budgets.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">🎯</div>
                    <p>No budget limits set</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.budgets.map(budget => {
            const percentage = (budget.spent / budget.amount) * 100;
            const progressClass = percentage < 70 ? 'low' : percentage < 90 ? 'medium' : 'high';
            
            return `
                <div class="budget-item">
                    <div class="budget-header">
                        <div class="budget-info">
                            <span style="color: ${budget.category_color}; font-size: 1.2rem;">
                                ${this.categories.find(c => c.id === budget.category_id)?.icon || '🏷️'}
                            </span>
                            <span>${budget.category_name}</span>
                        </div>
                        <button class="btn btn-small btn-danger" onclick="app.deleteBudget(${budget.id})">Delete</button>
                    </div>
                    <div class="budget-progress">
                        <div class="progress-bar">
                            <div class="progress-fill ${progressClass}" style="width: ${Math.min(percentage, 100)}%"></div>
                        </div>
                        <div class="progress-text">
                            <span>Spent: ${this.formatCurrency(budget.spent)}</span>
                            <span>Limit: ${this.formatCurrency(budget.amount)}</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    async loadTrends() {
        try {
            const response = await fetch('/api/trends?months=6');
            const trends = await response.json();
            this.renderTrendsChart(trends);
        } catch (error) {
            console.error('Error loading trends:', error);
        }
    }

    renderTrendsChart(trendsData) {
        const ctx = document.getElementById('trendsChart').getContext('2d');
        
        if (this.trendsChart) {
            this.trendsChart.destroy();
        }

        this.trendsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: trendsData.map(item => {
                    const date = new Date(item.month + '-01');
                    return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
                }),
                datasets: [
                    {
                        label: 'Income',
                        data: trendsData.map(item => item.income),
                        borderColor: '#00b894',
                        backgroundColor: '#00b894',
                        tension: 0.4
                    },
                    {
                        label: 'Expenses',
                        data: trendsData.map(item => item.expenses),
                        borderColor: '#e17055',
                        backgroundColor: '#e17055',
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: '#999',
                            callback: function(value) {
                                return '$' + value.toLocaleString();
                            }
                        },
                        grid: {
                            color: '#333'
                        }
                    },
                    x: {
                        ticks: {
                            color: '#999'
                        },
                        grid: {
                            color: '#333'
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: '#ffffff'
                        }
                    }
                }
            }
        });
    }

    // Modal functions
    openTransactionModal(transaction = null) {
        const modal = document.getElementById('transaction-modal');
        const form = document.getElementById('transaction-form');
        const title = document.getElementById('transaction-modal-title');
        
        if (transaction) {
            title.textContent = 'Edit Transaction';
            form.elements.type.value = transaction.type;
            form.elements.amount.value = transaction.amount;
            form.elements.category_id.value = transaction.category_id;
            form.elements.description.value = transaction.description || '';
            form.elements.date.value = transaction.date;
            form.elements.recurring.checked = transaction.recurring;
            form.dataset.id = transaction.id;
        } else {
            title.textContent = 'Add Transaction';
            form.reset();
            form.elements.date.value = new Date().toISOString().split('T')[0];
            delete form.dataset.id;
        }
        
        modal.classList.add('active');
    }

    closeTransactionModal() {
        document.getElementById('transaction-modal').classList.remove('active');
    }

    async saveTransaction() {
        const form = document.getElementById('transaction-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        data.recurring = form.elements.recurring.checked;
        
        try {
            const method = form.dataset.id ? 'PUT' : 'POST';
            const url = form.dataset.id ? `/api/transactions/${form.dataset.id}` : '/api/transactions';
            
            const response = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            
            if (response.ok) {
                this.closeTransactionModal();
                this.refreshCurrentView();
            }
        } catch (error) {
            console.error('Error saving transaction:', error);
        }
    }

    async editTransaction(id) {
        const transaction = this.transactions.find(t => t.id === id);
        if (transaction) {
            this.openTransactionModal(transaction);
        }
    }

    async deleteTransaction(id) {
        if (confirm('Are you sure you want to delete this transaction?')) {
            try {
                const response = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
                if (response.ok) {
                    this.refreshCurrentView();
                }
            } catch (error) {
                console.error('Error deleting transaction:', error);
            }
        }
    }

    openCategoryModal() {
        document.getElementById('category-modal').classList.add('active');
    }

    closeCategoryModal() {
        document.getElementById('category-modal').classList.remove('active');
        document.getElementById('category-form').reset();
    }

    async saveCategory() {
        const form = document.getElementById('category-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        
        try {
            const response = await fetch('/api/categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            
            if (response.ok) {
                this.closeCategoryModal();
                await this.loadCategories();
                this.renderCategories();
            }
        } catch (error) {
            console.error('Error saving category:', error);
        }
    }

    async deleteCategory(id) {
        if (confirm('Are you sure you want to delete this category?')) {
            try {
                const response = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
                if (response.ok) {
                    await this.loadCategories();
                    this.renderCategories();
                }
            } catch (error) {
                console.error('Error deleting category:', error);
            }
        }
    }

    openBudgetModal() {
        const form = document.getElementById('budget-form');
        form.elements.month.value = this.currentMonth;
        form.elements.year.value = this.currentYear;
        document.getElementById('budget-modal').classList.add('active');
    }

    closeBudgetModal() {
        document.getElementById('budget-modal').classList.remove('active');
        document.getElementById('budget-form').reset();
    }

    async saveBudget() {
        const form = document.getElementById('budget-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        data.month = this.currentMonth;
        data.year = this.currentYear;
        
        try {
            const response = await fetch('/api/budgets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            
            if (response.ok) {
                this.closeBudgetModal();
                this.loadBudgets();
            }
        } catch (error) {
            console.error('Error saving budget:', error);
        }
    }

    async deleteBudget(id) {
        if (confirm('Are you sure you want to delete this budget?')) {
            try {
                const response = await fetch(`/api/budgets/${id}`, { method: 'DELETE' });
                if (response.ok) {
                    this.loadBudgets();
                }
            } catch (error) {
                console.error('Error deleting budget:', error);
            }
        }
    }

    formatCurrency(amount) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(amount);
    }
}

// Global functions for onclick handlers
function openTransactionModal() { app.openTransactionModal(); }
function closeTransactionModal() { app.closeTransactionModal(); }
function openCategoryModal() { app.openCategoryModal(); }
function closeCategoryModal() { app.closeCategoryModal(); }
function openBudgetModal() { app.openBudgetModal(); }
function closeBudgetModal() { app.closeBudgetModal(); }

// Initialize app when DOM is loaded
const app = new BudgetApp();