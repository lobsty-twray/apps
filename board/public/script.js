class LobstyBoard {
    constructor() {
        this.currentProject = null;
        this.projects = [];
        this.tasks = [];
        this.labels = [];
        this.draggedTask = null;
        this.init();
    }

    async init() {
        this.bindEvents();
        await this.loadProjects();
        await this.loadLabels();
        if (this.projects.length > 0) {
            this.selectProject(this.projects[0].id);
        } else {
            this.showWelcomeScreen();
        }
    }

    bindEvents() {
        document.getElementById('new-project-btn').addEventListener('click', () => this.showProjectModal());
        document.getElementById('welcome-new-project-btn').addEventListener('click', () => this.showProjectModal());
        document.getElementById('new-task-btn').addEventListener('click', () => this.showTaskModal());
        document.getElementById('manage-labels-btn').addEventListener('click', () => this.showLabelsModal());
        this.bindModalEvents();
        document.getElementById('project-form').addEventListener('submit', (e) => this.handleProjectSubmit(e));
        document.getElementById('task-form').addEventListener('submit', (e) => this.handleTaskSubmit(e));
        document.getElementById('label-form').addEventListener('submit', (e) => this.handleLabelSubmit(e));
        document.getElementById('task-delete-btn').addEventListener('click', () => this.deleteTask());
    }

    bindModalEvents() {
        document.getElementById('project-modal-close').addEventListener('click', () => this.hideModal('project-modal'));
        document.getElementById('project-cancel-btn').addEventListener('click', () => this.hideModal('project-modal'));
        document.getElementById('task-modal-close').addEventListener('click', () => this.hideModal('task-modal'));
        document.getElementById('task-cancel-btn').addEventListener('click', () => this.hideModal('task-modal'));
        document.getElementById('labels-modal-close').addEventListener('click', () => this.hideModal('labels-modal'));
        document.getElementById('labels-close-btn').addEventListener('click', () => this.hideModal('labels-modal'));
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal') || e.target.classList.contains('modal-backdrop')) {
                const modal = e.target.closest('.modal');
                if (modal) this.hideModal(modal.id);
            }
        });
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
            if (this.currentProject && this.currentProject.id === project.id) {
                item.classList.add('active');
            }
            item.innerHTML = `<h3>${this.escapeHtml(project.name)}</h3><p>${this.escapeHtml(project.description || '')}</p>`;
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
    }

    createTaskCard(task) {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.dataset.taskId = task.id;
        card.draggable = true;
        const labels = task.labels || [];
        const labelColors = task.label_colors || [];
        card.innerHTML = `
            <h4>${this.escapeHtml(task.title)}</h4>
            ${task.description ? `<p>${this.escapeHtml(task.description)}</p>` : ''}
            <div class="task-meta">
                <span class="priority-badge priority-${task.priority}" title="${task.priority} priority"></span>
                <div class="task-labels">
                    ${labels.map((label, index) => `
                        <span class="label-tag" style="background-color: ${labelColors[index] || '#2383e2'}">${this.escapeHtml(label)}</span>
                    `).join('')}
                </div>
            </div>
        `;
        card.addEventListener('dragstart', (e) => {
            this.draggedTask = task;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            this.draggedTask = null;
        });
        card.addEventListener('click', () => this.showTaskModal(task));
        return card;
    }

    setupDropZone(container, status) {
        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            container.classList.add('drag-over');
        });
        container.addEventListener('dragleave', () => {
            container.classList.remove('drag-over');
        });
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
        document.getElementById('welcome-screen').style.display = 'none';
        document.getElementById('project-header').style.display = 'flex';
        document.getElementById('kanban-board').style.display = 'flex';
        document.getElementById('project-title').textContent = this.currentProject.name;
        document.getElementById('project-description').textContent = this.currentProject.description || '';
        this.renderProjects();
    }

    showWelcomeScreen() {
        document.getElementById('welcome-screen').style.display = 'flex';
        document.getElementById('project-header').style.display = 'none';
        document.getElementById('kanban-board').style.display = 'none';
    }

    showModal(modalId) {
        document.getElementById(modalId).style.display = 'flex';
        setTimeout(() => {
            const firstInput = document.querySelector(`#${modalId} input[type="text"], #${modalId} textarea`);
            if (firstInput) firstInput.focus();
        }, 100);
    }

    hideModal(modalId) {
        document.getElementById(modalId).style.display = 'none';
        this.clearForm(modalId);
    }

    clearForm(modalId) {
        const modal = document.getElementById(modalId);
        const form = modal.querySelector('form');
        if (form) form.reset();
        const labelCheckboxes = modal.querySelectorAll('.label-checkbox');
        labelCheckboxes.forEach(cb => {
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
            document.getElementById('task-desc').value = task.description || '';
            document.getElementById('task-priority').value = task.priority;
            document.getElementById('task-status').value = task.status;
            deleteBtn.style.display = 'inline-flex';
            deleteBtn.dataset.taskId = task.id;
        } else {
            title.textContent = 'New Task';
            deleteBtn.style.display = 'none';
            delete deleteBtn.dataset.taskId;
        }
        this.renderTaskLabels(task);
        this.showModal('task-modal');
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
        const data = { name: formData.get('name'), description: formData.get('description') };
        try {
            const project = await this.createProject(data);
            this.hideModal('project-modal');
            if (this.projects.length === 1) this.selectProject(project.id);
        } catch (error) {}
    }

    async handleTaskSubmit(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const selectedLabels = Array.from(document.querySelectorAll('#task-labels input:checked'))
            .map(input => parseInt(input.value));
        const data = {
            title: formData.get('title'),
            description: formData.get('description'),
            priority: formData.get('priority'),
            status: formData.get('status'),
            labels: selectedLabels
        };
        try {
            const taskId = document.getElementById('task-delete-btn').dataset.taskId;
            if (taskId) {
                await this.updateTask(taskId, data);
            } else {
                await this.createTask(data);
            }
            this.hideModal('task-modal');
        } catch (error) {}
    }

    async handleLabelSubmit(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = { name: formData.get('name'), color: formData.get('color') };
        try {
            await this.createLabel(data);
            this.renderLabelsManager();
            e.target.reset();
        } catch (error) {}
    }

    async deleteTask() {
        const taskId = document.getElementById('task-delete-btn').dataset.taskId;
        if (!taskId) return;
        if (confirm('Are you sure you want to delete this task?')) {
            try {
                await this.deleteTaskById(taskId);
                this.hideModal('task-modal');
            } catch (error) {}
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showError(message) {
        alert(`Error: ${message}`);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new LobstyBoard();
});
