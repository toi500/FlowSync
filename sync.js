require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');

const REPO_PATH = __dirname;
const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 1;

const runCommand = (command, suppressErrors = false) => new Promise((resolve, reject) => {
    exec(command, { cwd: REPO_PATH }, (err, stdout, stderr) => {
        if (err) { 
            if (!suppressErrors) console.error(`Command failed: ${stderr}`); 
            return reject(err); 
        }
        resolve(stdout.trim());
    });
});

const ensureGitRepo = async () => {
    try {
        await runCommand('git rev-parse --is-inside-work-tree', true);
    } catch {
        console.log('  -> Initializing git repository...');
        await runCommand('git init');
        await runCommand('git checkout -B main');
        // Create README.md with warning
    const readmePath = path.join(REPO_PATH, 'README.md');
    const warning = `# Automated FlowSync Backup Repository\n\n**This repository is managed automatically by the FlowSync service.**\n\nAll files and their history are generated based on the state of your configured Flowise instances. Manual changes made directly to this repository will be overwritten on the next sync cycle.\n\nTo modify a flow, please use the Flowise UI. FlowSync will detect the change and commit the new version automatically.\n`;
    await fs.writeFile(readmePath, warning);
    await runCommand('git config user.name "FlowSync Bot"');
    await runCommand('git config user.email "bot@flowsync.io"');
    await runCommand('git add README.md');
    await runCommand('git commit -m "Add README warning for manual edits"');
    }
};

const ensureGitRemote = async () => {
    const remote = process.env.GIT_REMOTE_URL;
    if (!remote) {
        console.warn('  -> No GIT_REMOTE_URL configured. Using existing remote or add one manually.');
        return;
    }

    try {
        const currentRemote = await runCommand('git remote get-url origin', true);
        if (currentRemote !== remote) {
            console.log('  -> Updating git remote origin to use GIT_REMOTE_URL');
            await runCommand(`git remote set-url origin ${remote}`);
        }
    } catch {
        console.log('  -> Setting git remote origin from GIT_REMOTE_URL');
        await runCommand(`git remote add origin ${remote}`);
    }
};

const remoteHasBranch = async (remote = 'origin', branch = 'main') => {
    try {
        await runCommand('git rev-parse --is-inside-work-tree', true);
        await runCommand(`git remote get-url ${remote}`, true);
        const out = await runCommand(`git ls-remote --heads ${remote} ${branch}`, true);
        return out && out.trim().length > 0;
    } catch {
        return false;
    }
};

const loadInstancesConfig = async () => {
    if (!process.env.FLOWISE_INSTANCES_JSON) {
        throw new Error('FLOWISE_INSTANCES_JSON env variable is required.');
    }
    let instances;
    try {
        let jsonString = process.env.FLOWISE_INSTANCES_JSON;
        if (jsonString.includes('\\"')) {
            jsonString = jsonString.replace(/\\"/g, '"');
        }
        instances = JSON.parse(jsonString);
    } catch (err) {
        throw new Error('FLOWISE_INSTANCES_JSON env is not valid JSON.');
    }
    const enabledInstances = instances.filter(instance => instance.enabled);
    if (enabledInstances.length === 0) {
        throw new Error('No enabled instances found in configuration. Please enable at least one instance.');
    }
    return enabledInstances;
};

const getLastKnownState = async (instanceName) => {
    try {
        const stateFile = path.join(REPO_PATH, `.flow_state_${instanceName}.json`);
        return JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    } catch { return {}; }
};

const saveState = (state, instanceName) => {
    const stateFile = path.join(REPO_PATH, `.flow_state_${instanceName}.json`);
    return fs.writeFile(stateFile, JSON.stringify(state, null, 2));
};

const syncInstanceFlows = async (instance) => {

    console.log(`  -> Syncing flows from instance: ${instance.name} (${instance.url})`);
    
    const instanceDir = path.join(REPO_PATH, 'flows', instance.name);

    const apiUrl = instance.url.replace(/\/+$/, '') + '/api/v1/chatflows';
    const response = await fetch(apiUrl, {
        headers: { 'Authorization': `Bearer ${instance.apiKey}` }
    });

    const rawBody = await response.text();
    if (!response.ok) {
        console.error(`  -> API response error for ${instance.name}:`, rawBody);
        throw new Error(`API request failed for ${instance.name} with status ${response.status}: ${rawBody}`);
    }
    let flows;
    try {
        flows = JSON.parse(rawBody);
    } catch (jsonErr) {
        console.error(`  -> API did not return valid JSON for ${instance.name}. Response was:`, rawBody);
        throw jsonErr;
    }

    const lastState = await getLastKnownState(instance.name);
    const currentState = { ...lastState };
    const changedFiles = [];
    const movedFiles = [];

    for (const flow of flows) {
        if (!flow.flowData) continue;
        const { id, name, flowData, updatedDate, type } = flow;

        const flowType = (type || 'uncategorized').toLowerCase();
        const typeDir = path.join(instanceDir, flowType);
        await fs.mkdir(typeDir, { recursive: true });

    const safeName = name.replace(/[\s\/]/g, '_');
    const last4 = id.slice(-4);
    const uniqueFileName = `${safeName}_id_${last4}.json`;
        
        if (!lastState[id] || lastState[id].updatedDate !== updatedDate) {
            console.log(`    -> Change detected in flow: '${name}' (Type: ${flowType}, Saving to ${uniqueFileName})`);
            const filePath = path.join(typeDir, uniqueFileName);
            const formattedFlowData = JSON.stringify(JSON.parse(flowData), null, 4);
            await fs.writeFile(filePath, formattedFlowData);
            changedFiles.push(`flows/${instance.name}/${flowType}/${uniqueFileName}`);
        }

        currentState[id] = { updatedDate, name: safeName, fileName: uniqueFileName, type: flowType };
    }

    const currentFlowIds = new Set(flows.map(f => f.id));
    const lastKnownIds = Object.keys(lastState);

    for (const id of lastKnownIds) {
        if (!currentFlowIds.has(id)) {
            const flowState = lastState[id];
            const fileNameToMove = flowState.fileName || `${flowState.name}_id_${id.slice(-4)}.json`;
            
            const sourceTypeDir = path.join(instanceDir, flowState.type || 'uncategorized');
            const sourcePath = path.join(sourceTypeDir, fileNameToMove);

            const deletedDir = path.join(sourceTypeDir, 'deleted');
            const destinationPath = path.join(deletedDir, fileNameToMove);

            console.log(`    -> Archiving deleted flow: '${fileNameToMove}' from ${flowState.type} folder`);

            try {
                await fs.mkdir(deletedDir, { recursive: true });
                await runCommand(`git mv "${sourcePath}" "${destinationPath}"`);
                movedFiles.push(destinationPath);
                delete currentState[id];
            } catch (moveError) {
                console.warn(`    -> Could not archive ${fileNameToMove}, it may have been manually removed.`);
                delete currentState[id];
            }
        }
    }

    if (changedFiles.length > 0 || movedFiles.length > 0) {
        await saveState(currentState, instance.name);
        console.log(`    -> ${changedFiles.length} flows updated, ${movedFiles.length} flows archived for ${instance.name}`);
    } else {
        console.log(`    -> No changes detected for ${instance.name}`);
    }

    return { 
        instanceName: instance.name, 
        changedFiles, 
        movedFiles,
        stateFile: `.flow_state_${instance.name}.json` 
    };
};


const syncFlows = async () => {
    console.log(`[${new Date().toLocaleString()}] Starting multi-instance flow sync check...`);
    
    await ensureGitRepo();
    await ensureGitRemote();

    try {
        const hasMain = await remoteHasBranch('origin', 'main');
        if (hasMain) {
            console.log('  -> Fetching and resetting to latest remote state to ensure consistency...');
            await runCommand('git fetch origin');
            await runCommand('git reset --hard origin/main');
        }
    } catch (error) {
        console.error(`  -> CRITICAL: Pre-sync with remote failed: ${error.message}. Aborting this cycle.`);
        return;
    }

    let instances;
    try {
        instances = await loadInstancesConfig();
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
    if (instances.length === 0) {
        console.log("  -> No enabled instances found. Please check your configuration.");
        return;
    }
    console.log(`  -> Found ${instances.length} enabled instance(s): ${instances.map(i => i.name).join(', ')}`);
    
    const flowsDir = path.join(REPO_PATH, 'flows');
    await fs.mkdir(flowsDir, { recursive: true });
    const allChangedFiles = [];
    const allMovedFiles = [];
    const allStateFiles = [];

    for (const instance of instances) {
        try {
            const result = await syncInstanceFlows(instance);
            allChangedFiles.push(...result.changedFiles);
            allMovedFiles.push(...result.movedFiles);

            if (result.changedFiles.length > 0 || result.movedFiles.length > 0) {
                allStateFiles.push(result.stateFile);
            }
        } catch (error) {
            console.error(`  -> Failed to sync instance ${instance.name}: ${error.message}`);
        }
    }

    if (allChangedFiles.length > 0 || allMovedFiles.length > 0) {
        try {
            console.log("  -> Committing changes...");
            await runCommand('git config --global user.name "FlowSync Bot"');
            await runCommand('git config --global user.email "bot@flowsync.io"');

            const filesToAdd = [...allChangedFiles, ...allStateFiles].join(' ');
            if (filesToAdd.trim()) {
                await runCommand(`git add ${filesToAdd}`);
            }

            const commitParts = [];
            if (allChangedFiles.length > 0) commitParts.push(`${allChangedFiles.length} updated`);
            if (allMovedFiles.length > 0) commitParts.push(`${allMovedFiles.length} archived`);
            const commitMessage = `Sync: ${commitParts.join(', ')} flow(s)`;

            await runCommand(`git commit -m "${commitMessage}"`);

            console.log("  -> Pushing to remote repository...");
            try {
                await runCommand('git push -u origin main', true);
                console.log("  -> Multi-instance sync successful!");
            } catch (pushError) {
                const errorMsg = pushError.message.toLowerCase();
                if (
                    errorMsg.includes("origin does not appear to be a git repository") ||
                    errorMsg.includes("could not read from remote repository") ||
                    errorMsg.includes("permission denied") ||
                    errorMsg.includes("denied to") ||
                    errorMsg.includes("unable to access") ||
                    errorMsg.includes("error: 403")
                ) {
                    console.error("Error: No valid git remote configured or you do not have permission to push. Set GIT_REMOTE_URL in your .env file or add a remote manually.");
                    console.log("Your flows have still been saved locally and are up to date on your machine.");
                }
                // Only show raw error for unexpected push errors
                else {
                    console.error(`  -> Git push process failed: ${pushError.message}`);
                }
            }
        } catch (error) {
            console.error(`Error: ${error.message}`);
        }
    } else {
        console.log("  -> No changes detected across all instances.");
    }
};

syncFlows().catch(err => {
    console.error("A critical error occurred:", err);
});
setInterval(() => {
    syncFlows().catch(err => {
        console.error("A critical error occurred during scheduled sync:", err);
    });
}, SYNC_INTERVAL_MINUTES * 60 * 1000);