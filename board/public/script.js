class LobstyBoard {
    constructor() {
        this.currentProject = null;
        this.projects = [];
        this.tasks = [];
        this.labels = [];
        this.draggedTask = null;
        this.touchDrag = null;
        this.quillEditor = null;
        this.currentView = 'board'; // board | calendar | archive
        this.calYear = new Date().getFullYear();
        this.calMonth = new Date().getMonth() + 1;
        this.calTasks = [];
        this.archivedTasks = [];
        this.init();
    }

    initTheme() {        const saved = localStorage.getItem("board-theme");        if (saved === "dark") {            document.documentElement.setAttribute("data-theme", "dark");            const meta = document.querySelector("meta[name=theme-color]");            if (meta) meta.setAttribute("content", "#0a0a0f");        }    }    toggleTheme() {        const isDark = document.documentElement.getAttribute("data-theme") === "dark";        if (isDark) {            document.documentElement.removeAttribute("data-theme");            localStorage.setItem("board-theme", "light");            const meta = document.querySelector("meta[name=theme-color]");            if (meta) meta.setAttribute("content", "#fafaf9");        } else {            document.documentElement.setAttribute("data-theme", "dark");            localStorage.setItem("board-theme", "dark");            const meta = document.querySelector("meta[name=theme-color]");            if (meta) meta.setAttribute("content", "#0a0a0f");        }    }
    async init() {
        this.initTheme();
        this.bindEvents();
        this.initQuill();
        await this.loadProjects();
        await this.loadLabels();
        this.initFilters();
        if (this.projects.length > 0) {
            this.selectProject(this.projects[0].id);
        } else {
            this.showWelcomeScreen();
        }
        this.setupColumnDots();
    }

    initQuill() {
        this.quillEditor = new Quill('#task-desc-editor', {
            theme: 'snow',
            placeholder: 'Add details...',
            modules: {
                toolbar: [
                    ['bold', 'italic', 'strike'],
                    [{ 'header': 1 }, { 'header': 2 }, { 'header': 3 }],
                    [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                    ['code-block'],
                    ['link'],
                    ['clean']
                ]
            }
        });
    }

    bindEvents() {
        document.getElementById("theme-toggle")?.addEventListener("click", () => this.toggleTheme());
        document.getElementById('new-project-btn').addEventListener('click', () => this.showProjectModal());
        document.getElementById('welcome-new-project-btn').addEventListener('click', () => this.showProjectModal());
        document.getElementById('new-task-btn').addEventListener('click', () => this.showTaskModal());
        document.getElementById('manage-labels-btn').addEventListener('click', () => this.showLabelsModal());
        this.bindModalEvents();
        this.bindSidebarEvents();
        document.getElementById('project-form').addEventListener('submit', (e) => this.handleProjectSubmit(e));
        document.getElementById('task-form').addEventListener('submit', (e) => this.handleTaskSubmit(e));
        document.getElementById('label-form').addEventListener('submit', (e) => this.handleLabelSubmit(e));
        document.getElementById('task-delete-btn').addEventListener('click', () => this.deleteTask());
        document.getElementById('doc-link-trigger').addEventListener('click', () => this.showDocInput());
        document.getElementById('subtask-add-btn').addEventListener('click', () => this.addSubtask());
        document.getElementById('subtask-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.addSubtask(); }
        });
        document.getElementById('doc-add-btn').addEventListener('click', () => this.addDocLink());
        document.getElementById('doc-cancel-btn').addEventListener('click', () => this.hideDocInput());
        document.getElementById('doc-url-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.addDocLink(); }
            if (e.key === 'Escape') this.hideDocInput();
        });

        // View toggles
        document.getElementById('view-board-btn').addEventListener('click', () => this.switchView('board'));
        document.getElementById('view-calendar-btn').addEventListener('click', () => this.switchView('calendar'));
        document.getElementById('show-calendar-btn').addEventListener('click', () => {
            this.closeSidebar();
            if (this.currentProject) this.switchView('calendar');
            else this.showGlobalCalendar();
        });
        document.getElementById('show-archive-btn').addEventListener('click', () => {
            this.closeSidebar();
            this.switchView('archive');
        });
        document.getElementById('archive-back-btn').addEventListener('click', () => this.switchView('board'));
        document.getElementById('show-stats-btn').addEventListener('click', () => { this.closeSidebar(); this.showStats(); });
        document.getElementById('stats-modal-close').addEventListener('click', () => this.closeStatsModal());
        document.getElementById('stats-modal').querySelector('.modal-backdrop').addEventListener('click', () => this.closeStatsModal());

        // Calendar nav
        document.getElementById('cal-prev').addEventListener('click', () => this.calNav(-1));
        document.getElementById('cal-next').addEventListener('click', () => this.calNav(1));
        document.getElementById('cal-today').addEventListener('click', () => {
            const now = new Date();
            this.calYear = now.getFullYear();
            this.calMonth = now.getMonth() + 1;
            this.loadCalendar();
        });
    }

    bindSidebarEvents() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        const toggle = document.getElementById('sidebar-toggle');
        const close = document.getElementById('sidebar-close');

        toggle.addEventListener('click', () => {
            sidebar.classList.add('open');
            overlay.classList.add('active');
        });

        close.addEventListener('click', () => this.closeSidebar());
        overlay.addEventListener('click', () => this.closeSidebar());
    }

    closeSidebar() {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('active');
    }

    bindModalEvents() {
        document.getElementById('project-modal-close').addEventListener('click', () => this.hideModal('project-modal'));
        document.getElementById('project-cancel-btn').addEventListener('click', () => this.hideModal('project-modal'));
        document.getElementById('task-modal-close').addEventListener('click', () => this.hideModal('task-modal'));
        document.getElementById('task-cancel-btn').addEventListener('click', () => this.hideModal('task-modal'));
        document.getElementById('labels-modal-close').addEventListener('click', () => this.hideModal('labels-modal'));
        document.getElementById('labels-close-btn').addEventListener('click', () => this.hideModal('labels-modal'));
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal-backdrop')) {
                const modal = e.target.closest('.modal');
                if (modal) this.hideModal(modal.id);
            }
        });
    }

    setupColumnDots() {
        const board = document.getElementById('kanban-board');
        const dots = document.querySelectorAll('.column-dots .dot');
        if (!board || !dots.length) return;

        board.addEventListener('scroll', () => {
            const scrollLeft = board.scrollLeft;
            const colWidth = board.querySelector('.column')?.offsetWidth || 300;
            const gap = 12;
            const idx = Math.round(scrollLeft / (colWidth + gap));
            dots.forEach((d, i) => d.classList.toggle('active', i === idx));
        });

        dots.forEach(dot => {
            dot.addEventListener('click', () => {
                const idx = parseInt(dot.dataset.col);
                const col = board.querySelectorAll('.column')[idx];
                if (col) col.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            });
        });
    }

    // ── View switching ──
    switchView(view) {
        this.currentView = view;
        const board = document.getElementById('kanban-board');
        const calendar = document.getElementById('calendar-view');
        const archive = document.getElementById('archive-view');
        const dots = document.getElementById('column-dots');
        const header = document.getElementById('project-header');
        const welcome = document.getElementById('welcome-screen');

        board.style.display = 'none';
        calendar.style.display = 'none';
        archive.style.display = 'none';
        dots.style.display = 'none';
        welcome.style.display = 'none';

        document.getElementById('view-board-btn').classList.toggle('active', view === 'board');
        document.getElementById('view-calendar-btn').classList.toggle('active', view === 'calendar');

        if (view === 'board') {
            if (this.currentProject) {
                header.style.display = 'flex';
                board.style.display = 'flex';
                dots.style.display = '';
                this.showFilterBar();
            } else {
                welcome.style.display = 'flex';
            }
        } else if (view === 'calendar') {
            this.hideFilterBar();
            header.style.display = 'flex';
            calendar.style.display = 'flex';
            this.loadCalendar();
        } else if (view === 'archive') {
            this.hideFilterBar();
            header.style.display = 'none';
            archive.style.display = 'flex';
            this.loadArchive();
        }
    }

    showGlobalCalendar() {
        // Show calendar even without a project selected
        document.getElementById('welcome-screen').style.display = 'none';
        document.getElementById('project-header').style.display = 'flex';
        this.currentView = 'calendar';
        document.getElementById('kanban-board').style.display = 'none';
        document.getElementById('archive-view').style.display = 'none';
        document.getElementById('calendar-view').style.display = 'flex';
        document.getElementById('column-dots').style.display = 'none';
        document.getElementById('view-board-btn').classList.remove('active');
        document.getElementById('view-calendar-btn').classList.add('active');
        this.loadCalendar();
    }

    // ── Calendar ──
    calNav(dir) {
        this.calMonth += dir;
        if (this.calMonth > 12) { this.calMonth = 1; this.calYear++; }
        if (this.calMonth < 1) { this.calMonth = 12; this.calYear--; }
        this.loadCalendar();
    }

    async loadCalendar() {
        const label = document.getElementById('cal-month-label');
        const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        label.textContent = `${months[this.calMonth - 1]} ${this.calYear}`;

        try {
            this.calTasks = await this.apiCall(`/api/calendar?year=${this.calYear}&month=${this.calMonth}`);
        } catch { this.calTasks = []; }

        this.renderCalendar();
    }

    renderCalendar() {
        const container = document.getElementById('cal-days');
        container.innerHTML = '';

        const firstDay = new Date(this.calYear, this.calMonth - 1, 1).getDay();
        const daysInMonth = new Date(this.calYear, this.calMonth, 0).getDate();
        const today = new Date();
        const isCurrentMonth = today.getFullYear() === this.calYear && today.getMonth() + 1 === this.calMonth;

        // Group tasks by day
        const tasksByDay = {};
        this.calTasks.forEach(t => {
            const day = parseInt(t.due_date.split('-')[2]);
            if (!tasksByDay[day]) tasksByDay[day] = [];
            tasksByDay[day].push(t);
        });

        // Empty cells before first day
        for (let i = 0; i < firstDay; i++) {
            const cell = document.createElement('div');
            cell.className = 'cal-day cal-day-empty';
            container.appendChild(cell);
        }

        for (let d = 1; d <= daysInMonth; d++) {
            const cell = document.createElement('div');
            cell.className = 'cal-day';
            if (isCurrentMonth && d === today.getDate()) cell.classList.add('cal-today');

            const num = document.createElement('span');
            num.className = 'cal-day-num';
            num.textContent = d;
            cell.appendChild(num);

            const dayTasks = tasksByDay[d] || [];
            dayTasks.forEach(task => {
                const chip = document.createElement('div');
                chip.className = 'cal-task';
                chip.style.borderLeftColor = task.project_color || '#6366f1';
                chip.title = `${task.title} (${task.project_name || 'Unknown'})`;

                const statusDot = document.createElement('span');
                statusDot.className = `priority-badge priority-${task.priority}`;
                chip.appendChild(statusDot);

                const titleSpan = document.createElement('span');
                titleSpan.className = 'cal-task-title';
                titleSpan.textContent = task.title;
                chip.appendChild(titleSpan);

                chip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showTaskModal(task);
                });
                cell.appendChild(chip);
            });

            container.appendChild(cell);
        }
    }

    // ── Archive ──
    async loadArchive() {
        try {
            this.archivedTasks = await this.apiCall('/api/archive');
        } catch { this.archivedTasks = []; }
        this.renderArchive();
    }

    renderArchive() {
        const container = document.getElementById('archive-list');
        const empty = document.getElementById('archive-empty');
        container.innerHTML = '';

        if (this.archivedTasks.length === 0) {
            empty.style.display = 'flex';
            return;
        }
        empty.style.display = 'none';

        this.archivedTasks.forEach(task => {
            const card = document.createElement('div');
            card.className = 'archive-card';

            const archivedDate = task.archived_at ? new Date(task.archived_at + 'Z').toLocaleDateString() : '';

            card.innerHTML = `
                <div class="archive-card-info">
                    <div class="archive-card-top">
                        <span class="priority-badge priority-${task.priority}"></span>
                        <h4>${this.escapeHtml(task.title)}</h4>
                    </div>
                    <div class="archive-card-meta">
                        <span class="archive-project" style="color: ${task.project_color || '#6366f1'}">${this.escapeHtml(task.project_name || 'Unknown')}</span>
                        <span class="archive-date">Archived ${archivedDate}</span>
                    </div>
                </div>
                <button class="btn btn-glass btn-sm archive-restore-btn" data-task-id="${task.id}">Restore</button>
            `;

            card.querySelector('.archive-restore-btn').addEventListener('click', () => this.restoreTask(task.id));
            container.appendChild(card);
        });
    }

    async restoreTask(taskId) {
        try {
            await this.apiCall(`/api/tasks/${taskId}/restore`, { method: 'PATCH', body: JSON.stringify({ status: 'todo' }) });
            this.showToast('Task restored');
            await this.loadArchive();
            if (this.currentProject) await this.loadTasks(this.currentProject.id);
        } catch {}
    }

    async apiCall(endpoint, options = {}) {
        try {
            const response = await fetch(endpoint, {
                headers: { 'Content-Type': 'application/json', ...options.headers },
                ...options
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            return response.status !== 204 ? await response.json() : null;
        } catch (error) {
            console.error('API call failed:', error);
            this.showError(error.message);
            throw error;
        }
    }

    async loadProjects() {
        this.projects = await this.apiCall('/api/projects');
        this.renderProjects();
    }

    async loadTasks(projectId) {
        this.tasks = await this.apiCall(`/api/projects/${projectId}/tasks`);
        this.renderTasks();
    }

    async loadLabels() {
        this.labels = await this.apiCall('/api/labels');
        if (this.filterState) this.renderFilterLabels();
    }

    async createProject(data) {
        const project = await this.apiCall('/api/projects', { method: 'POST', body: JSON.stringify(data) });
        this.projects.unshift(project);
        this.renderProjects();
        return project;
    }

    async createTask(data) {
        const task = await this.apiCall(`/api/projects/${this.currentProject.id}/tasks`, { method: 'POST', body: JSON.stringify(data) });
        await this.loadTasks(this.currentProject.id);
        return task;
    }

    async updateTask(taskId, data) {
        const task = await this.apiCall(`/api/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(data) });
        await this.loadTasks(this.currentProject.id);
        return task;
    }

    async moveTask(taskId, status, position = 0) {
        await this.apiCall(`/api/tasks/${taskId}/move`, { method: 'PATCH', body: JSON.stringify({ status, position }) });
        await this.loadTasks(this.currentProject.id);
    }

    async deleteTaskById(taskId) {
        await this.apiCall(`/api/tasks/${taskId}`, { method: 'DELETE' });
        await this.loadTasks(this.currentProject.id);
    }

    async createLabel(data) {
        const label = await this.apiCall('/api/labels', { method: 'POST', body: JSON.stringify(data) });
        this.labels.push(label);
        return label;
    }

    renderProjects() {
        const container = document.getElementById('projects-list');
        container.innerHTML = '';
        this.projects.forEach(project => {
            const item = document.createElement('div');
            item.className = 'project-item';
            item.dataset.projectId = project.id;
            if (this.currentProject && this.currentProject.id === project.id) item.classList.add('active');
            item.innerHTML = `
                <div class="project-item-dot" style="background:${project.color || '#6366f1'}"></div>
                <div class="project-item-text">
                    <h3>${this.escapeHtml(project.name)}</h3>
                    <p>${this.escapeHtml(project.description || '')}</p>
                </div>
            `;
            item.addEventListener('click', () => this.selectProject(project.id));
            container.appendChild(item);
        });
    }

    updateTaskCounts() {
        const columns = ['backlog', 'todo', 'in-progress', 'review', 'done'];
        columns.forEach(status => {
            const count = this.tasks.filter(task => task.status === status).length;
            const el = document.getElementById(`${status}-count`);
            if (el) el.textContent = count;
        });
    }

    renderTasks() {
        const columns = ['backlog', 'todo', 'in-progress', 'review', 'done'];
        columns.forEach(status => {
            const container = document.getElementById(`${status}-tasks`);
            container.innerHTML = '';
            const columnTasks = this.tasks.filter(task => task.status === status);
            columnTasks.forEach(task => {
                const card = this.createTaskCard(task);
                container.appendChild(card);
            });
            this.setupDropZone(container, status);
        });
        this.updateTaskCounts();
        if (this.filterState) this.applyFilters();
    }

    createTaskCard(task) {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.dataset.taskId = task.id;
        card.draggable = true;
        const labels = task.labels || [];
        const labelColors = task.label_colors || [];
        const docs = task.docs || [];

        // Due date display
        let dueHtml = '';
        if (task.due_date) {
            const due = new Date(task.due_date + 'T00:00:00');
            const now = new Date();
            now.setHours(0,0,0,0);
            const isOverdue = due < now && task.status !== 'done';
            const isSoon = !isOverdue && (due - now) <= 2 * 86400000 && task.status !== 'done';
            const cls = isOverdue ? 'due-overdue' : isSoon ? 'due-soon' : 'due-normal';
            const formatted = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            dueHtml = `<span class="due-badge ${cls}" title="Due ${task.due_date}">📅 ${formatted}</span>`;
        }

        card.innerHTML = `
            <h4>${this.escapeHtml(task.title)}</h4>
            ${task.description ? `<div class="task-desc-md">${task.description.startsWith('<') ? task.description : marked.parse(task.description)}</div>` : ''}
            ${docs.length > 0 ? `
                <div class="card-docs">
                    ${docs.map(doc => `
                        <a href="${this.escapeHtml(doc.url)}" target="_blank" rel="noopener noreferrer" class="card-doc-badge" title="${this.escapeHtml(doc.url)}">
                            <span class="card-doc-icon">📄</span>${this.escapeHtml(doc.title)}
                        </a>
                    `).join('')}
                </div>
            ` : ''}
            \${(task.subtask_count > 0) ? \`
                <div class="subtask-progress">
                    <span class="subtask-progress-text">✓ \${task.subtask_done}/\${task.subtask_count}</span>
                    <div class="subtask-bar"><div class="subtask-bar-fill" style="width:\${Math.round(task.subtask_done/task.subtask_count*100)}%"></div></div>
                </div>
            \` : ''}
            <div class="task-meta">
                <span class="priority-badge priority-${task.priority}" title="${task.priority}"></span>
                ${task.assignee ? `<span class="assignee-badge" title="${task.assignee}">${task.assignee === 'Lobsty' ? '🦞' : '👤'} ${task.assignee}</span>` : ''}
                ${dueHtml}
                <div class="task-labels">
                    ${labels.map((label, index) => `
                        <span class="label-tag" style="background-color: ${labelColors[index] || '#6366f1'}">${this.escapeHtml(label)}</span>
                    `).join('')}
                </div>
                <button class="card-link-doc-btn" title="Link Doc">📄</button>
            </div>
        `;

        card.querySelectorAll('.card-doc-badge').forEach(badge => {
            badge.addEventListener('click', (e) => e.stopPropagation());
        });

        card.querySelector('.card-link-doc-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.showTaskModal(task);
            setTimeout(() => this.showDocInput(), 150);
        });

        card.addEventListener('dragstart', (e) => {
            this.draggedTask = task;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', task.id);
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            this.draggedTask = null;
        });
        this.setupTouchDrag(card, task);
        card.addEventListener('click', () => this.showTaskModal(task));
        return card;
    }

    setupTouchDrag(card, task) {
        let startX, startY, moved = false, longPress = false, timer;
        card.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            startX = touch.clientX; startY = touch.clientY;
            moved = false; longPress = false;
            timer = setTimeout(() => {
                longPress = true;
                card.classList.add('drag-ghost');
                if (navigator.vibrate) navigator.vibrate(30);
            }, 400);
        }, { passive: true });

        card.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - startX);
            const dy = Math.abs(touch.clientY - startY);
            if (dx > 10 || dy > 10) {
                moved = true;
                if (!longPress) { clearTimeout(timer); return; }
            }
            if (longPress) {
                e.preventDefault();
                const el = document.elementFromPoint(touch.clientX, touch.clientY);
                if (el) {
                    const col = el.closest('.column');
                    document.querySelectorAll('.column-content').forEach(c => c.classList.remove('drag-over'));
                    if (col) {
                        col.querySelector('.column-content').classList.add('drag-over');
                        this.touchDrag = { task, targetStatus: col.dataset.status };
                    }
                }
            }
        }, { passive: false });

        card.addEventListener('touchend', (e) => {
            clearTimeout(timer);
            card.classList.remove('drag-ghost');
            document.querySelectorAll('.column-content').forEach(c => c.classList.remove('drag-over'));
            if (longPress && this.touchDrag && this.touchDrag.targetStatus !== task.status) {
                e.preventDefault();
                this.moveTask(task.id, this.touchDrag.targetStatus);
                this.touchDrag = null;
                return;
            }
            this.touchDrag = null;
        });
    }

    setupDropZone(container, status) {
        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            container.classList.add('drag-over');
        });
        container.addEventListener('dragleave', () => container.classList.remove('drag-over'));
        container.addEventListener('drop', async (e) => {
            e.preventDefault();
            container.classList.remove('drag-over');
            if (this.draggedTask && this.draggedTask.status !== status) {
                await this.moveTask(this.draggedTask.id, status);
            }
        });
    }

    async selectProject(projectId) {
        this.currentProject = this.projects.find(p => p.id == projectId);
        if (!this.currentProject) return;
        await this.loadTasks(projectId);
        this.currentView = 'board';
        document.getElementById('welcome-screen').style.display = 'none';
        document.getElementById('project-header').style.display = 'flex';
        document.getElementById('kanban-board').style.display = 'flex';
        document.getElementById('column-dots').style.display = '';
        document.getElementById('calendar-view').style.display = 'none';
        document.getElementById('archive-view').style.display = 'none';
        document.getElementById('view-board-btn').classList.add('active');
        document.getElementById('view-calendar-btn').classList.remove('active');
        document.getElementById('project-title').textContent = this.currentProject.name;
        this.showFilterBar();
        this.renderFilterLabels();
        document.getElementById('project-description').textContent = this.currentProject.description || '';
        this.renderProjects();
        this.closeSidebar();
    }

    showWelcomeScreen() {
        document.getElementById('welcome-screen').style.display = 'flex';
        document.getElementById('project-header').style.display = 'none';
        document.getElementById('kanban-board').style.display = 'none';
        document.getElementById('column-dots').style.display = 'none';
        document.getElementById('calendar-view').style.display = 'none';
        document.getElementById('archive-view').style.display = 'none';
        this.hideFilterBar();
    }

    showModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.style.display = 'flex';
        requestAnimationFrame(() => {
            const firstInput = modal.querySelector('input[type="text"], textarea');
            if (firstInput) firstInput.focus();
        });
    }

    hideModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.style.display = 'none';
        this.clearForm(modalId);
    }

    clearForm(modalId) {
        const modal = document.getElementById(modalId);
        const form = modal.querySelector('form');
        if (form) form.reset();
        modal.querySelectorAll('.label-checkbox').forEach(cb => {
            cb.classList.remove('selected');
            const input = cb.querySelector('input');
            if (input) input.checked = false;
        });
    }

    showProjectModal(project = null) {
        const title = document.getElementById('project-modal-title');
        if (project) {
            title.textContent = 'Edit Project';
            document.getElementById('project-name').value = project.name;
            document.getElementById('project-desc').value = project.description || '';
            document.getElementById('project-color').value = project.color || '#6366f1';
        } else {
            title.textContent = 'New Project';
        }
        this.showModal('project-modal');
    }

    showTaskModal(task = null) {
        const title = document.getElementById('task-modal-title');
        const deleteBtn = document.getElementById('task-delete-btn');
        if (task) {
            title.textContent = 'Edit Task';
            document.getElementById('task-title').value = task.title;
            if (this.quillEditor) {
                var desc = task.description || '';
                if (desc.startsWith('<')) { this.quillEditor.root.innerHTML = desc; }
                else { this.quillEditor.setText(desc || ''); }
            }
            document.getElementById('task-priority').value = task.priority;
            document.getElementById('task-status').value = task.status;
            document.getElementById('task-assignee').value = task.assignee || '';
            document.getElementById('task-due-date').value = task.due_date || '';
            deleteBtn.style.display = 'inline-flex';
            deleteBtn.dataset.taskId = task.id;
        } else {
            title.textContent = 'New Task';
            deleteBtn.style.display = 'none';
            document.getElementById('task-assignee').value = '';
            document.getElementById('task-due-date').value = '';
            delete deleteBtn.dataset.taskId;
        }
        this.renderTaskLabels(task);
        this.renderTaskDocs(task);
        this.hideDocInput();
        document.getElementById('doc-link-trigger').style.display = task ? 'inline-flex' : 'none';
        if (this.quillEditor && !deleteBtn.dataset.taskId && title.textContent === 'New Task') {
            this.quillEditor.setText('');
        }
        this.showModal('task-modal');
        if (task) {
            this.loadSubtasks(task.id);
        } else {
            this.renderSubtasks([]);
        }
    }

    async loadSubtasks(taskId) {
        try {
            const subtasks = await this.apiCall(\`/api/tasks/\${taskId}/subtasks\`);
            this.renderSubtasks(subtasks, taskId);
        } catch { this.renderSubtasks([], taskId); }
    }

    renderSubtasks(subtasks, taskId) {
        const container = document.getElementById('subtask-list');
        if (!container) return;
        container.innerHTML = '';
        subtasks.forEach(st => {
            const item = document.createElement('div');
            item.className = 'subtask-item' + (st.completed ? ' completed' : '');
            item.innerHTML = \`
                <input type="checkbox" class="subtask-checkbox" \${st.completed ? 'checked' : ''}>
                <span class="subtask-title">\${this.escapeHtml(st.title)}</span>
                <button type="button" class="subtask-delete" title="Delete">&times;</button>
            \`;
            item.querySelector('.subtask-checkbox').addEventListener('change', async () => {
                await this.apiCall(\`/api/subtasks/\${st.id}/toggle\`, { method: 'PUT' });
                if (taskId) this.loadSubtasks(taskId);
                if (this.currentProject) await this.loadTasks(this.currentProject.id);
            });
            item.querySelector('.subtask-delete').addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.apiCall(\`/api/subtasks/\${st.id}\`, { method: 'DELETE' });
                if (taskId) this.loadSubtasks(taskId);
                if (this.currentProject) await this.loadTasks(this.currentProject.id);
            });
            container.appendChild(item);
        });
    }

    async addSubtask() {
        const input = document.getElementById('subtask-input');
        const title = input.value.trim();
        if (!title) return;
        const taskId = document.getElementById('task-delete-btn').dataset.taskId;
        if (!taskId) { this.showError('Save the task first, then add subtasks'); return; }
        try {
            await this.apiCall(\`/api/tasks/\${taskId}/subtasks\`, { method: 'POST', body: JSON.stringify({ title }) });
            input.value = '';
            this.loadSubtasks(taskId);
            if (this.currentProject) await this.loadTasks(this.currentProject.id);
        } catch {}
    }

    renderTaskLabels(task = null) {
        const container = document.getElementById('task-labels');
        container.innerHTML = '';
        const taskLabels = task ? task.labels || [] : [];
        this.labels.forEach(label => {
            const labelDiv = document.createElement('div');
            labelDiv.className = 'label-checkbox';
            const isSelected = taskLabels.includes(label.name);
            if (isSelected) labelDiv.classList.add('selected');
            labelDiv.innerHTML = `
                <input type="checkbox" id="label-${label.id}" value="${label.id}" ${isSelected ? 'checked' : ''}>
                <label for="label-${label.id}" style="color: ${label.color}">${this.escapeHtml(label.name)}</label>
            `;
            labelDiv.addEventListener('click', (e) => {
                if (e.target.tagName !== 'INPUT') {
                    const checkbox = labelDiv.querySelector('input');
                    checkbox.checked = !checkbox.checked;
                }
                labelDiv.classList.toggle('selected', labelDiv.querySelector('input').checked);
            });
            container.appendChild(labelDiv);
        });
    }

    renderTaskDocs(task = null) {
        const container = document.getElementById('task-docs-list');
        container.innerHTML = '';
        const docs = task ? task.docs || [] : [];
        docs.forEach(doc => {
            const chip = document.createElement('div');
            chip.className = 'doc-chip';
            chip.innerHTML = `
                <a href="${this.escapeHtml(doc.url)}" target="_blank" rel="noopener noreferrer" class="doc-chip-link" title="${this.escapeHtml(doc.url)}">
                    <span class="doc-chip-icon">📄</span>
                    ${this.escapeHtml(doc.title)}
                </a>
                <button type="button" class="doc-chip-remove" data-doc-id="${doc.id}" title="Remove">&times;</button>
            `;
            chip.querySelector('.doc-chip-link').addEventListener('click', (e) => e.stopPropagation());
            chip.querySelector('.doc-chip-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeDocLink(doc.id);
            });
            container.appendChild(chip);
        });
    }

    showDocInput() {
        document.getElementById('doc-input-row').style.display = 'flex';
        document.getElementById('doc-link-trigger').style.display = 'none';
        document.getElementById('doc-url-input').value = '';
        document.getElementById('doc-url-input').focus();
    }

    hideDocInput() {
        document.getElementById('doc-input-row').style.display = 'none';
        const trigger = document.getElementById('doc-link-trigger');
        if (trigger) trigger.style.display = 'inline-flex';
    }

    extractDocTitle(url) {
        try {
            const parsed = new URL(url);
            const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
            if (!path) return parsed.hostname;
            const segments = path.split('/');
            const last = segments[segments.length - 1];
            return decodeURIComponent(last).replace(/[-_]/g, ' ');
        } catch { return url; }
    }

    async addDocLink() {
        const input = document.getElementById('doc-url-input');
        const url = input.value.trim();
        if (!url) return;
        if (!url.includes('docs.twray.dev')) {
            this.showError('Only docs.twray.dev URLs are allowed');
            return;
        }
        const taskId = document.getElementById('task-delete-btn').dataset.taskId;
        if (!taskId) { this.showError('Save the task first, then add doc links'); return; }
        const title = this.extractDocTitle(url);
        try {
            await this.apiCall(`/api/tasks/${taskId}/docs`, { method: 'POST', body: JSON.stringify({ url, title }) });
            const task = await this.apiCall(`/api/tasks/${taskId}`);
            this.renderTaskDocs(task);
            const idx = this.tasks.findIndex(t => t.id == taskId);
            if (idx !== -1) this.tasks[idx] = task;
            this.renderTasks();
            this.hideDocInput();
        } catch {}
    }

    async removeDocLink(docId) {
        const taskId = document.getElementById('task-delete-btn').dataset.taskId;
        if (!taskId) return;
        try {
            await this.apiCall(`/api/tasks/${taskId}/docs/${docId}`, { method: 'DELETE' });
            const task = await this.apiCall(`/api/tasks/${taskId}`);
            this.renderTaskDocs(task);
            const idx = this.tasks.findIndex(t => t.id == taskId);
            if (idx !== -1) this.tasks[idx] = task;
            this.renderTasks();
        } catch {}
    }

    showLabelsModal() {
        this.renderLabelsManager();
        this.showModal('labels-modal');
    }

    renderLabelsManager() {
        const container = document.getElementById('labels-list');
        container.innerHTML = '';
        this.labels.forEach(label => {
            const item = document.createElement('div');
            item.className = 'label-item';
            item.innerHTML = `
                <div class="label-preview">
                    <span class="label-color" style="background-color: ${label.color}"></span>
                    <span>${this.escapeHtml(label.name)}</span>
                </div>
            `;
            container.appendChild(item);
        });
    }

    async handleProjectSubmit(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = { name: formData.get('name'), description: formData.get('description'), color: formData.get('color') || '#6366f1' };
        try {
            const project = await this.createProject(data);
            this.hideModal('project-modal');
            if (this.projects.length === 1) this.selectProject(project.id);
            this.showToast(`Project "${data.name}" created`);
        } catch {}
    }

    async handleTaskSubmit(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const selectedLabels = Array.from(document.querySelectorAll('#task-labels input:checked'))
            .map(input => parseInt(input.value));
        const data = {
            title: formData.get('title'),
            description: this.quillEditor ? (this.quillEditor.root.innerHTML === '<p><br></p>' ? '' : this.quillEditor.root.innerHTML) : '',
            priority: formData.get('priority'),
            status: formData.get('status'),
            labels: selectedLabels,
            assignee: formData.get('assignee') || null,
            due_date: formData.get('due_date') || null
        };
        try {
            const taskId = document.getElementById('task-delete-btn').dataset.taskId;
            if (taskId) {
                await this.updateTask(taskId, data);
            } else {
                await this.createTask(data);
            }
            this.hideModal('task-modal');
            // Refresh calendar if visible
            if (this.currentView === 'calendar') this.loadCalendar();
        } catch {}
    }

    async handleLabelSubmit(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = { name: formData.get('name'), color: formData.get('color') };
        try {
            await this.createLabel(data);
            this.renderLabelsManager();
            e.target.reset();
        } catch {}
    }

    async deleteTask() {
        const taskId = document.getElementById('task-delete-btn').dataset.taskId;
        if (!taskId) return;
        if (confirm('Delete this task?')) {
            try {
                await this.deleteTaskById(taskId);
                this.hideModal('task-modal');
                this.showToast('Task deleted');
            } catch {}
        }
    }

    showToast(message, isError = false) {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast${isError ? ' error' : ''}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── Stats ──
    async showStats() {
        const modal = document.getElementById('stats-modal');
        const body = document.getElementById('stats-body');
        modal.style.display = 'flex';
        requestAnimationFrame(() => modal.classList.add('active'));
        body.innerHTML = '<div class="stats-loading">Loading stats...</div>';

        try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            this.renderStats(data, body);
        } catch (e) {
            body.innerHTML = '<div class="stats-loading">Failed to load stats.</div>';
        }
    }

    renderStats(data, container) {
        const { overview, projects } = data;
        const diff = overview.completedThisWeek - overview.completedLastWeek;
        const diffClass = diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'neutral';
        const diffText = diff > 0 ? `+${diff} vs last week` : diff < 0 ? `${diff} vs last week` : 'same as last week';

        const statusColors = { backlog: '#94a3b8', todo: '#60a5fa', 'in-progress': '#fbbf24', review: '#a78bfa', done: '#34d399' };
        const statusLabels = { backlog: 'Backlog', todo: 'To Do', 'in-progress': 'In Progress', review: 'Review', done: 'Done' };
        const totalByStatus = Object.values(overview.byStatus).reduce((a, b) => a + b, 0) || 1;

        let statusBarHtml = '';
        let legendHtml = '';
        for (const [s, c] of Object.entries(overview.byStatus)) {
            if (c === 0) continue;
            const pct = (c / totalByStatus * 100).toFixed(1);
            statusBarHtml += `<div class="status-bar-segment" style="width:${pct}%;background:${statusColors[s]||'#666'}" title="${statusLabels[s]||s}: ${c}">${c}</div>`;
            legendHtml += `<span style="--dot-color:${statusColors[s]||'#666'}"><span style="background:${statusColors[s]||'#666'};width:10px;height:10px;border-radius:50%;display:inline-block"></span> ${statusLabels[s]||s} (${c})</span>`;
        }

        let projectsHtml = '';
        projects.forEach(p => {
            const pct = p.total > 0 ? (p.done / p.total * 100).toFixed(0) : 0;
            const overdueTag = p.overdue > 0 ? ` · <span style="color:var(--red,#f87171)">${p.overdue} overdue</span>` : '';
            projectsHtml += `
                <div class="project-stat">
                    <div class="project-stat-header">
                        <div class="project-stat-name"><span class="dot" style="background:${p.color}"></span>${p.name}</div>
                        <div class="project-stat-counts">${p.done}/${p.total} done · ${p.inProgress} active${overdueTag}</div>
                    </div>
                    <div class="project-stat-bar"><div class="project-stat-bar-fill" style="width:${pct}%;background:${p.color}"></div></div>
                </div>`;
        });

        let priorityHtml = '';
        for (const [p, c] of Object.entries(overview.byPriority)) {
            priorityHtml += `<span class="priority-pill ${p}">${p}: ${c}</span>`;
        }

        container.innerHTML = `
            <div class="stats-cards">
                <div class="stat-card"><div class="stat-value">${overview.totalTasks}</div><div class="stat-label">Active Tasks</div></div>
                <div class="stat-card"><div class="stat-value">${overview.completedThisWeek}</div><div class="stat-label">Done This Week</div><div class="stat-sub ${diffClass}">${diffText}</div></div>
                <div class="stat-card ${overview.overdueTasks > 0 ? 'danger' : ''}"><div class="stat-value">${overview.overdueTasks}</div><div class="stat-label">Overdue</div></div>
                <div class="stat-card"><div class="stat-value">${overview.averageCompletionDays}d</div><div class="stat-label">Avg Completion</div></div>
            </div>
            <div class="stats-section">
                <h4>Status Distribution</h4>
                <div class="status-bar">${statusBarHtml}</div>
                <div class="status-bar-legend">${legendHtml}</div>
            </div>
            ${projects.length ? `<div class="stats-section"><h4>Project Progress</h4>${projectsHtml}</div>` : ''}
            ${priorityHtml ? `<div class="stats-section"><h4>Priority Breakdown</h4><div class="priority-pills">${priorityHtml}</div></div>` : ''}
        `;
    }

    closeStatsModal() {
        const modal = document.getElementById('stats-modal');
        modal.classList.remove('active');
        setTimeout(() => { modal.style.display = 'none'; }, 200);
    }


    // ── Filter state ──
    initFilters() {
        this.filterState = { search: '', priority: null, label: null };

        const searchInput = document.getElementById('filter-search');
        const toggleBtn = document.getElementById('filter-toggle-btn');
        const clearBtn = document.getElementById('filter-clear-btn');
        const options = document.getElementById('filter-options');

        searchInput.addEventListener('input', () => {
            this.filterState.search = searchInput.value.toLowerCase();
            this.applyFilters();
        });

        toggleBtn.addEventListener('click', () => {
            const isOpen = options.classList.toggle('open');
            toggleBtn.classList.toggle('active', isOpen);
        });

        // Priority pills
        document.querySelectorAll('#filter-priority .filter-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                const val = pill.dataset.priority;
                if (this.filterState.priority === val) {
                    this.filterState.priority = null;
                    pill.classList.remove('active');
                } else {
                    document.querySelectorAll('#filter-priority .filter-pill').forEach(p => p.classList.remove('active'));
                    this.filterState.priority = val;
                    pill.classList.add('active');
                }
                this.applyFilters();
            });
        });

        clearBtn.addEventListener('click', () => {
            this.clearFilters();
        });

        // Cmd/Ctrl+K shortcut
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                searchInput.focus();
                searchInput.select();
            }
        });
    }

    clearFilters() {
        this.filterState = { search: '', priority: null, label: null };
        document.getElementById('filter-search').value = '';
        document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        this.applyFilters();
    }

    renderFilterLabels() {
        const container = document.getElementById('filter-labels');
        container.innerHTML = '';
        this.labels.forEach(label => {
            const pill = document.createElement('button');
            pill.className = 'filter-pill';
            pill.dataset.label = label.name;
            pill.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${label.color};display:inline-block"></span> ${this.escapeHtml(label.name)}`;
            if (this.filterState && this.filterState.label === label.name) pill.classList.add('active');
            pill.addEventListener('click', () => {
                if (this.filterState.label === label.name) {
                    this.filterState.label = null;
                    pill.classList.remove('active');
                } else {
                    container.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
                    this.filterState.label = label.name;
                    pill.classList.add('active');
                }
                this.applyFilters();
            });
            container.appendChild(pill);
        });
    }

    showFilterBar() {
        const bar = document.getElementById('filter-bar');
        if (bar) bar.style.display = '';
    }

    hideFilterBar() {
        const bar = document.getElementById('filter-bar');
        if (bar) bar.style.display = 'none';
    }

    applyFilters() {
        const { search, priority, label } = this.filterState;
        const hasFilter = search || priority || label;
        let total = 0, matching = 0;

        document.querySelectorAll('.task-card').forEach(card => {
            const taskId = parseInt(card.dataset.taskId);
            const task = this.tasks.find(t => t.id === taskId);
            if (!task) return;

            total++;
            let visible = true;

            if (search) {
                const title = (task.title || '').toLowerCase();
                const desc = (task.description || '').toLowerCase();
                if (!title.includes(search) && !desc.includes(search)) visible = false;
            }

            if (priority && task.priority !== priority) visible = false;

            if (label) {
                const taskLabels = task.labels || [];
                if (!taskLabels.includes(label)) visible = false;
            }

            card.classList.toggle('filter-hidden', !visible);
            if (visible) matching++;
        });

        // Update count
        const countEl = document.getElementById('filter-count');
        if (hasFilter) {
            countEl.textContent = `${matching}/${total}`;
            countEl.classList.add('has-filter');
        } else {
            countEl.textContent = '';
            countEl.classList.remove('has-filter');
        }

        // Update clear button
        document.getElementById('filter-clear-btn').style.display = hasFilter ? '' : 'none';

        // Update column counts to reflect visible
        this.updateFilteredCounts();
    }

    updateFilteredCounts() {
        const columns = ['backlog', 'todo', 'in-progress', 'review', 'done'];
        columns.forEach(status => {
            const container = document.getElementById(`${status}-tasks`);
            if (!container) return;
            const visible = container.querySelectorAll('.task-card:not(.filter-hidden)').length;
            const el = document.getElementById(`${status}-count`);
            if (el) el.textContent = visible;
        });
    }

    showError(message) { this.showToast(message, true); }
}



document.addEventListener('DOMContentLoaded', () => { new LobstyBoard(); });
