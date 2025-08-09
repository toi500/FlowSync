# FlowSync – Multi-Instance Flowise Sync & Versioning

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node.js Version](https://img.shields.io/badge/Node.js-18+-blue.svg)

**FlowSync** is a Node.js utility designed to back up and version-control flows from multiple Flowise instances to a remote Git repository. It provides a way for users and teams to keep a versioned history of their flows, synced automatically. The script can be run locally or deployed as a background service using Docker.

---

## Core Functionality

*   **Maintains API as Source of Truth:** If the backup repository is manually edited, the script will overwrite those changes with the latest data from the Flowise API on the next sync.
*   **Archives Deleted Flows:** When a flow is deleted in the Flowise UI, its corresponding file is moved to an archive folder (`deleted/`) instead of being permanently removed from the repository.
*   **Unique Filename Generation:** Prevents file conflicts by creating a unique filename for each flow using its name and a short version of its ID (e.g., `flowname_a1b2c3d4.json`).
*   **Subfolder Organization by Type:** Automatically sorts flows into subfolders based on their `type` (e.g., `agentflow`, `chatflow`).
*   **Multi-Instance Sync:** Can be configured to sync flows from multiple Flowise instances into a single repository.
*   **Docker Support:** Includes a `Dockerfile` for deployment as a background service.

## How It Works

The script runs on a set interval and performs the following steps for each sync cycle:
1.  **Resets Local State:** It first forces its local repository to match the remote one (`git reset --hard`), wiping any manual changes and preventing conflicts.
2.  **Fetches from API:** It connects to each enabled Flowise instance and fetches the current list of all chatflows.
3.  **Detects Changes:** It compares the API data to its last known state, identifying new, updated, and deleted flows.
4.  **Writes & Archives:**
    - New and updated flows are saved to `flows/<instance>/<type>/`.
    - Deleted flows are moved to `flows/<instance>/<type>/deleted/`.
5.  **Commits & Pushes:** All changes are committed and pushed to your private remote repository.

---

## Prerequisites

1.  **Node.js v18+**
2.  **Git** installed on the machine running the script.
3.  A **private Git repository** (e.g., on GitHub, GitLab) to securely store your flow backups.

---

## Local Usage

### 1. Installation

```sh
git clone https://github.com/toi500/FlowSync
cd FlowSync
npm install
```

### 2. Configuration

Create a `.env` file in the root of the project. You can copy `.env.example` to get started.

```sh
cp .env.example .env
```

Now, edit the `.env` file with your details:

```env
# The URL of your PRIVATE Git repository where flows will be saved.
# Choose one of the formats below.
#
# HTTPS (recommended for services like Coolify/Render):
# You'll need to create a GitHub Personal Access Token with 'repo' scope.
GIT_REMOTE_URL='https://<YOUR_GITHUB_TOKEN>@github.com/<your-username>/<your-private-repo>.git'
#
# SSH (recommended for local use or servers with SSH keys):
# GIT_REMOTE_URL='git@github.com:<your-username>/<your-private-repo>.git'


# The interval in minutes for how often to check for flow updates.
SYNC_INTERVAL_MINUTES=1


# A JSON array of the Flowise instances to sync.
# TIP: This must be a valid, single-line JSON string. Use an online "JSON Minifier" to format it correctly if you have trouble.
FLOWISE_INSTANCES_JSON='[{"name":"production","url":"https://your-prod-url.com","apiKey":"your-prod-api-key","enabled":true},{"name":"development","url":"http://localhost:3000","apiKey":"your-dev-api-key","enabled":true}]'
```

### 3. Running the Sync

```sh
npm start```
The script will perform an initial sync and then continue to run in the background, checking for updates periodically.

---

## Deployment (Docker)

FlowSync is designed to be deployed as a long-running service.

### 1. Build the Docker image:
```sh
docker build -t flowsync .
```

### 2. Run the Docker container:
Make sure your configured `.env` file is in the current directory.
```sh
docker run -d --name flowsync-service --env-file .env flowsync
```
The service will now be running in the background. To view logs, use `docker logs -f flowsync-service`.

---

## Repository Structure

After running, your private backup repository will be structured like this. (Note: The script adds a unique ID to each filename to prevent conflicts).

```
MyFlows/
├── flows/
│   └── production/
│       ├── agentflow/
│       │   ├── MyFlow1.json
│       │   ├── MyFlow2.json
│       │   └── deleted/
│       │       └── MyFlow3.json
│       │
│       └── chatflow/
│           └── MyFlow4.json
│
└── .flow_state_production.json
```

---

## License

This project is licensed under the **MIT License**.
