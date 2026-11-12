
const vscode = require('vscode');
const jsonc = require('./jsonc-parser');

async function setLaunchJson() {
    if (!vscode.workspace.workspaceFolders?.length) return;

    const directory = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode');
    const uri = vscode.Uri.joinPath(directory, 'launch.json');
    const document = await vscode.workspace.openTextDocument(uri);
    const original = document ? document.getText() : '{}\n';
    const errors = [];
    const current = jsonc.parse(original.trim() ? original : '{}', errors, { allowTrailingComma: true });
    if (errors.length || !current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error('Cannot update launch.json: expected a valid JSON object.');
    }

    if (current.configurations !== undefined && !Array.isArray(current.configurations)) {
        throw new Error('Cannot update launch.json: configurations must be an array.');
    }

    const settings = {
        // console: 'internalConsole',
        // redirectOutput: true,
        internalConsoleOptions: 'openOnSessionStart'
    };

    let updated = original;
    const configurations = current.configurations || [];
    if (!configurations.length) {
        configurations.push(
            {
                name: 'CUDA-GDB',
                type: 'cuda-gdb',
                request: 'launch',
                program: '${workspaceFolder}/build/test',
                cwd: '${workspaceFolder}',
                preLaunchTask: 'CMake',
                ...settings
            },
            {
                name: 'GDB',
                type: 'cppdbg',
                request: 'launch',
                program: '${workspaceFolder}/build/test',
                cwd: '${workspaceFolder}',
                preLaunchTask: 'CMake',
                MIMode: 'gdb',
                miDebuggerPath: 'gdb',
                externalConsole: false,
                ...settings
            }
        );
        for (const [key, value] of Object.entries({
            version: current.version ?? '0.2.0', configurations
        })) {
            updated = jsonc.applyEdits(updated, jsonc.modify(updated, [key], value, {
                formattingOptions: { insertSpaces: true, tabSize: 4,
                    eol: original.includes('\r\n') ? '\r\n' : '\n' }
            }));
        }
    }
    for (const [index, config] of configurations.entries()) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new Error('Cannot update launch.json: each configuration must be an object.');
        }
        for (const [key, value] of Object.entries(settings)) {
            if (JSON.stringify(config[key]) !== JSON.stringify(value)) {
                updated = jsonc.applyEdits(updated, jsonc.modify(
                    updated, ['configurations', index, key], value, {
                        formattingOptions: { insertSpaces: true, tabSize: 4,
                            eol: original.includes('\r\n') ? '\r\n' : '\n' }
                    }
                ));
            }
        }
    }
    if (document && updated === original) return;

    if (document) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(document.positionAt(0),
            document.positionAt(original.length)), updated);
        if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
            throw new Error('Could not save launch.json.');
        }
    } else {
        await vscode.workspace.fs.createDirectory(directory);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
    }
}

async function setSettingJson() {
    if (!vscode.workspace.workspaceFolders?.length) return;

    const directory = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode');
    const uri = vscode.Uri.joinPath(directory, 'settings.json');
    const document = await vscode.workspace.openTextDocument(uri);
    const original = document ? document.getText() : '{}\n';
    const errors = [];
    const current = jsonc.parse(original.trim() ? original : '{}', errors, { allowTrailingComma: true });
    if (errors.length || !current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error('Cannot update settings.json: expected a valid JSON object.');
    }

    const settings = {
        "chat.disableAIFeatures": false,
        "C_Cpp.errorSquiggles": "disabled",
        "debug.console.collapseIdenticalLines": false,
        "debug.allowBreakpointsEverywhere": true,
        "debug.openDebug": "neverOpen",
        "debug.console.wordWrap": false,
        "editor.tabSize": 4,
        "editor.insertSpaces": true,
        "editor.detectIndentation": false,
        "files.associations": {
            "*.vert": "cpp",
            "*.frag": "cpp",
            "*.comp": "cpp",
            "*.glsl": "cpp"
        },
        "[javascript][json]": {
            "editor.tabSize": 4,
            "editor.insertSpaces": true,
            "editor.detectIndentation": false
        }
    }
    
    let updated = original;
    for (const [key, value] of Object.entries(settings)) {
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
            updated = jsonc.applyEdits(updated, jsonc.modify(updated, [key], value, {
                formattingOptions: { insertSpaces: true, tabSize: 4,
                    eol: original.includes('\r\n') ? '\r\n' : '\n' }
            }));
        }
    }
    if (updated === original) return;

    if (document) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(document.positionAt(0),
            document.positionAt(original.length)), updated);
        if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
            throw new Error('Could not save settings.json.');
        }
    } else {
        await vscode.workspace.fs.createDirectory(directory);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
    }
}

async function vscodeSettings() {
    for (const [filename, update] of [
        ['launch.json', setLaunchJson],
        ['settings.json', setSettingJson]
    ]) {
        try {
            await update();
        } catch (error) {
            console.error(`mem: Could not update ${filename}`, error);
        }
    }
}

module.exports = { vscodeSettings };
