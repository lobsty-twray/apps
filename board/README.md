# 🦞 Lobsty Board

A Jira-like kanban project tracker with a clean dark UI.

## Features

- **Projects**: Organize tasks into projects (Infrastructure, Apps, YouTube, etc.)
- **Kanban Board**: Drag & drop tasks between columns (Backlog, Todo, In Progress, Review, Done)
- **Tasks**: Full task management with title, description, priority levels, and labels/tags
- **Persistent Storage**: SQLite database with Docker volume persistence
- **Clean Dark UI**: Modern dark theme with #0f0f0f background and #646cff accent color
- **Responsive Design**: Works on desktop, tablet, and mobile

## Tech Stack

- **Frontend**: Vanilla JavaScript with drag-and-drop functionality
- **Backend**: Node.js + Express
- **Database**: better-sqlite3 (SQLite)
- **Deployment**: Docker with volume persistence

## API Endpoints

### Projects
- List all projects
- Create new project
- Get project details
- Update project
- Delete project

### Tasks
- Get tasks for project
- Create new task
- Get task details
- Update task
- Move task between columns
- Delete task

### Labels
- List all labels
- Create new label

## Database Schema

- **projects**: id, name, description, created_at, updated_at
- **tasks**: id, project_id, title, description, status, priority, position, created_at, updated_at
- **labels**: id, name, color, created_at
- **task_labels**: task_id, label_id (junction table)

## Deployment

The application runs in a Docker container on port 3000 (mapped to 8091 on the host).
The SQLite database is stored in a Docker volume for persistence across container restarts.

## Usage

1. Create your first project
2. Add tasks to the project with priorities and labels
3. Drag tasks between columns as they progress
4. Click on tasks to edit details
5. Use labels to categorize and filter tasks

Built with ❤️ for efficient project management.
