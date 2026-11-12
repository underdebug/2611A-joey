
LOG = 0; // 10/29 2026

const vscode = require('vscode');
const { registerShaderDefinitions } = require('./definitions.js');
const path = require('path');
const fs = require('fs');
const { prepareGpu } = require('./cuda-gdb.js');
const { prepareCpu } = require('./cppdbg.js');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function printOutput(message) {
    const config = vscode.workspace.getConfiguration('editor', {
        languageId: 'Log'
    });

    await config.update('fontSize', 15, vscode.ConfigurationTarget.Global, true);
    await config.update('lineHeight', 20, vscode.ConfigurationTarget.Global, true);

    if (!log.outputChannel) {
        log.outputChannel = vscode.window.createOutputChannel('mem');
    }
    log.outputChannel.appendLine(message);
    log.outputChannel.show(true);
}

function printTerminal(message) {
    if (!log.terminal) {
        const emitter = new vscode.EventEmitter();
        const pending = [];
        let opened = false;

        log.writeTerminal = text => {
            if (opened) emitter.fire(text);
            else pending.push(text);
        };

        log.terminal = vscode.window.createTerminal({
            name: 'mem',
            pty: {
                onDidWrite: emitter.event,
                open() {
                    opened = true;
                    for (const text of pending) emitter.fire(text);
                    pending.length = 0;
                },
                close() {
                    opened = false;
                    log.terminal = undefined;
                    emitter.dispose();
                }
            }
        });
    }

    //log.terminal.show(true);
    log.writeTerminal(message.replace(/\r?\n/g, '\r\n') + '\r\n');
}

function log(...args) {
    const stack = new Error().stack;
    const caller = stack.split('\n')[2];

    const m = caller?.match(/:(\d+):\d+\)?$/);
    const line = m ? m[1] : '';

    const fn = caller?.match(/^\s*at\s+(.+?)\s+\(/);
    const name = fn ? fn[1] : '<anonymous>';

    const message = `${String(line).padStart(3)} ${name.padEnd(13)} ${args.join(' ')}`;
    
    if (vscode.debug.activeDebugSession) {
        vscode.debug.activeDebugConsole.appendLine(message);
    }
    else{
        printOutput(message);
        //printTerminal(message);
    }
}

async function printStack(session) {
    const editor = vscode.window.activeTextEditor;
    const line = editor ? editor.selection.active.line + 1 : '?';

    let stack;
    try {
        LOG && log('printStack', line);
        const item = vscode.debug.activeStackItem;
        let threadId = item && item.session === session ? item.threadId : undefined;
        // Read CUDA-GDB's current stack without selecting a DAP host thread
        // or frame, which would replace the device focus before reading locals.
        if (session.type === 'cuda-gdb') {
            const script = [
                'import gdb',
                'import os',
                'frame = gdb.newest_frame()',
                'names = []',
                'for index in range(3):',
                '    if frame is None:',
                '        break',
                "    name = (frame.name() or '').strip()",
                "    name = name.replace('(anonymous namespace)::', '').split('(', 1)[0].strip().rsplit('::', 1)[-1] or '??'",
                '    symtab = frame.find_sal().symtab',
                "    source = os.path.basename(symtab.filename) if symtab else ''",
                "    names.append(name + '.' + source if source else name)",
                '    frame = frame.older()',
                `print(${JSON.stringify(line)}, ' <-- '.join(names) or '(no stack)')`
            ].join('\n');
            const response = await session.customRequest('evaluate', {
                expression: `-exec python exec(${JSON.stringify(script)}, {})`,
                context: 'repl'
            });
            if (response && response.result) {
                vscode.debug.activeDebugConsole.appendLine(response.result);
            }
            return;
        }
        if (threadId === undefined) {
            const response = await session.customRequest('threads');
            threadId = response.threads && response.threads[0] && response.threads[0].id;
        }
        if (threadId === undefined) {
            stack = '(no thread)';
        } else {
            const response = await session.customRequest('stackTrace', {
                threadId,
                startFrame: 0,
                levels: 3
            });
            stack = (response.stackFrames || []).slice(0, 3)
                .map(frame => {
                    const name = (frame.name || '').trim();
                    const shortName = name.replace(/\(anonymous namespace\)::/g, '')
                        .replace(/\(.*$/, '').trim().split('::').pop() || '??';
                    const source = frame.source && (frame.source.name || frame.source.path);
                    const file = source ? path.basename(source.replace(/\\/g, '/')) : '';
                    return file ? `${shortName}.${file}` : shortName;
                })
                .join(' <-- ') || '(no stack)';
        }
        vscode.debug.activeDebugConsole.appendLine(`${line} ${stack}`);
    } catch (e) {
        log('Error printStack', line, stack, e.message);
    }
}

async function getFrameId(session) {
    // Let Nsight evaluate commands in its current CUDA focus. A DAP frame
    // selection can switch to a host architecture, which cannot read CUDA
    // DWARF registers (including the 0x40000000 register range).
    if (session.type === 'cuda-gdb') return undefined;
    const item = vscode.debug.activeStackItem;
    if (item && item.session === session && typeof item.frameId === 'number') {
        return item.frameId;
    }
    try {
        let tid = item && item.session === session && typeof item.threadId === 'number' ? item.threadId : undefined;
        if (tid === undefined) {
            const threads = await session.customRequest('threads');
            tid = threads && threads.threads && threads.threads[0] && threads.threads[0].id;
        }
        if (tid === undefined) return undefined;
        const st = await session.customRequest('stackTrace', {
            threadId: tid, startFrame: 0, levels: 1
        });
        return st && st.stackFrames && st.stackFrames[0] && st.stackFrames[0].id;
    } catch (e) {
        return undefined;
    }
}

async function getProjectPath() {
    const editor = vscode.window.activeTextEditor;
    const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder.uri.fsPath;
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders[0]) return folders[0].uri.fsPath;
    if (editor) return path.dirname(editor.document.uri.fsPath);
    throw new Error('Open a file or workspace first.');
}

async function getFilePath() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return undefined; }

    return path.dirname(editor.document.uri.fsPath);
}

async function initialMem(session) {
    const editor = vscode.window.activeTextEditor;
    const frameId = await getFrameId(session);
    LOG && log('initialMem', 'getFrameId', frameId);

    const PROJECT_PATH = session.workspaceFolder?.uri.fsPath || await getProjectPath();
    const projectMem = path.join(PROJECT_PATH, 'mem', 'extension', 'mem.py');
    const installedMem = path.join(__dirname, 'mem.py');
    const memPath = fs.existsSync(projectMem) && fs.statSync(projectMem).isFile()
        ? projectMem : installedMem;

    const expr = `-exec python import os, sys, importlib.util; PROJECT_PATH=${JSON.stringify(PROJECT_PATH)}; os.environ['PROJECT_PATH']=PROJECT_PATH; spec=importlib.util.spec_from_file_location('mem', ${JSON.stringify(memPath)}); mem=importlib.util.module_from_spec(spec); sys.modules['mem']=mem; spec.loader.exec_module(mem); from mem import *;`; // NOMODIFY, NODELETE
    LOG && log('initialMem', expr);

    try {
        const response = await session.customRequest('evaluate', {
            expression: expr,
            context: 'repl',
            frameId: frameId
        });
        if (response && response.result) {
            vscode.debug.activeDebugConsole.appendLine(response.result);
        }
    } catch (e) {
        log('Error initialMem', expr, e.message);
        throw e;
    }
}

async function runPython(editor) {
    try {
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const started = await vscode.debug.startDebugging(folder, {
            name: 'Python: Current File (Ctrl+F8)',
            type: 'debugpy',
            request: 'launch',
            program: editor.document.uri.fsPath,
            cwd: path.dirname(editor.document.uri.fsPath),
            console: 'internalConsole',
            internalConsoleOptions: 'openOnSessionStart',
            redirectOutput: true,
            noDebug: true
        });
        if (!started) {
            vscode.window.showErrorMessage('mem: Could not run the Python file.');
        }
    } catch (e) {
        log('Error runPython', e.message);
        vscode.window.showErrorMessage(`mem: ${e.message}`);
    }
}

function tokenText() {
    const editor = vscode.window.activeTextEditor;
    const pos = editor.selection.active;

    const range = editor.document.getWordRangeAtPosition(pos);
    LOG && log('memCppCpp', 'pos', pos, 'range', range);
    if (!range)
        return ""

    let text = editor.document.getText(range);
    let left = editor.document.lineAt(range.start.line).text.slice(0, range.start.character);
    let match;
    while ((match = left.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(\.|->)\s*$/))) {
        text = match[1] + match[2] + text;
        left = left.slice(0, match.index);
    }

    LOG && log('tokenText', pos.line + 1, text);
    return text;
}

async function runExec_source(session, sourceText) {
    const sourceArgs = sourceText.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([A-Za-z_]\w*)(?:\s+(.+))?)?$/);

    if (!sourceArgs) {
        log('mem: Use source <file> [function_name [arguments...]]. Quote paths containing spaces.');
        return true;
    }

    const filename = sourceArgs[1] || sourceArgs[2] || sourceArgs[3];
    const functionName = sourceArgs[4];
    const functionArgs = sourceArgs[5] ? sourceArgs[5].trim().split(/\s+/) : [];

    if (functionName && !/\.py$/i.test(filename)) {
        log('mem: Function calls require a Python (.py) script.', filename);
        return true;
    }

    const editor = vscode.window.activeTextEditor;
    const currentPath = editor ? path.dirname(editor.document.uri.fsPath) : undefined;
    const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const projectPath = (session.workspaceFolder || folder)?.uri.fsPath || process.env.PROJECT_PATH || currentPath;
    const relativePath = filename.replace(/^[/\\]+/, '');

    const candidates = [
        currentPath && path.resolve(currentPath, filename),
        path.isAbsolute(filename) && filename,
        projectPath && path.join(projectPath, relativePath),
        projectPath && path.join(projectPath, 'src', relativePath)
    ].filter(Boolean);
    const sourcePath = candidates.find(candidate =>
        fs.existsSync(candidate) && fs.statSync(candidate).isFile());

    if (!sourcePath) {
        log(`mem: Script not found: ${filename}`);
        return true;
    }

    const normalizedPath = sourcePath.replace(/\\/g, '/');
    const expr = /\.py$/i.test(normalizedPath)
        ? `-exec python __file__ = ${JSON.stringify(normalizedPath)}; exec(compile(open(__file__, 'rb').read(), __file__, 'exec'), globals())${functionName ? `; ${functionName}(*${JSON.stringify(functionArgs)})` : ''}`
        : `-exec source ${normalizedPath}`;

    const frameId = await getFrameId(session);
    LOG && log(expr);

    const response = await session.customRequest('evaluate', {
        expression: expr,
        context: 'repl',
        frameId: frameId
    });

    if (response && response.result) {
        log(response.result);
    }

    return true;
}

async function runExec(text) {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
        vscode.window.showErrorMessage('mem: Start a debug session before running -exec commands.');
        return true;
    }

    text = text.trim().replace(/^(?:\/{2,}|\/\*)\s*/, '')
        .replace(/\s*\*\/\s*$/, '').trim();
    // Ignore standalone source annotations when executing debugger commands.
    text = text.replace(/\b(?:READONLY|NODELETE|NOMODIFY)\b/g, '')
        .replace(/\s*(?:\/\/|#)[\s,]*$/, '').trim();
    const match = text.match(/^-?exec\s+(.+)$/);
    if (!match) return false;

    let command = match[1];
    const source = command.match(/^source\s+(.+)$/);
    if (source) {
        return await runExec_source(session, source[1]);
    } else if (command.match(/^break\b/)) {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.document.isClosed && !await editor.document.save()) return true;
        try {
            LOG && log("toggleBreakpoint");
            await toggleBreakpoint();
        } catch (error) {
            vscode.debug.activeDebugConsole.appendLine(`toggleBreakpoint: ${error.message || error}`);
        }
    } else {
        const expr = `-exec ${command}`;
        const frameId = await getFrameId(session);
        LOG && log(expr);
        const response = await session.customRequest('evaluate', {
            expression: expr,
            context: 'repl',
            frameId: frameId
        });
        if (response && response.result) {
            vscode.debug.activeDebugConsole.appendLine(response.result);
        }
    }
    return true;
}

async function aware(session) {
    const frameId = await getFrameId(session);

    const kernelDimensions = [
        "import gdb, re",
        "import numpy as np",
        "try:",
        "    kernels_output = gdb.execute('info cuda kernels', to_string=True)",
        "",
        "    kernels_match = re.search(",
        "        r'^\\s*\\*[^\\n]*?(\\(\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\))\\s+'",
        "        r'(\\(\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\))',",
        "        kernels_output, re.MULTILINE)",
        "",
        "    BLOCK, KERNEL = (",
        "        [np.array([int(value) for value in group.strip('()').split(',')])",
        "         for group in kernels_match.groups()]",
        "        if kernels_match else (np.zeros(3, dtype=int), np.zeros(3, dtype=int))",
        "    )",
        "",
        "    kernel_output = gdb.execute('cuda block thread', to_string=True)",
        "",
        "    kernel_match = re.search(",
        "        r'(\\(\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\)),?\\s+(?:thread\\s+)?'",
        "        r'(\\(\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\))',",
        "        kernel_output, re.MULTILINE)",
        "",
        "    block, kernel = (",
        "        [np.array([int(value) for value in group.strip('()').split(',')])",
        "         for group in kernel_match.groups()]",
        "        if kernel_match else (np.zeros(3, dtype=int), np.zeros(3, dtype=int))",
        "    )",
        "",
        "    id = block * KERNEL + kernel if kernels_match and kernel_match else None",
        "",
        "    with np.printoptions(formatter={'int_kind': lambda value: str(value)}):",
        "        print(id, '/', block, kernel, '/', BLOCK, KERNEL, '<-- kernel')",
        "except gdb.error:",
        "    pass"
    ].join('\n');
    try {
        const expr = `-exec python exec(${JSON.stringify(kernelDimensions)})`;
        const response = await session.customRequest('evaluate', {
            expression: expr,
            context: 'repl',
            frameId: frameId
        });
        if (response && typeof response.result === 'string' && response.result.length > 0) {
            vscode.debug.activeDebugConsole.appendLine(response.result);
        }
    } catch (error) {
        vscode.debug.activeDebugConsole.appendLine(`aware(): ${error.message || error}`);
    }
    return true;
}

async function memCppCpp(session) {
    const editor = vscode.window.activeTextEditor;
    const line = editor.selection.active.line + 1;
    const frameId = await getFrameId(session);
    let text;
    if (editor.selection.isEmpty) {
        text = editor.document.lineAt(editor.selection.active.line).text;
        if (!await runExec(text)) {  // -EXEC NODELETE
            text = tokenText();
            if (text) { // TOKEN NODELETE
                const expression = `value = mem('${text}'); printf(value, '${text}', ${line})`;
                const expr = `-exec python exec(${JSON.stringify(expression)})`;
                const response = await session.customRequest('evaluate', {
                    expression: expr,
                    context: 'repl',
                    frameId: frameId
                });
                if (response && typeof response.result === 'string' && response.result.length > 0) {
                    vscode.debug.activeDebugConsole.appendLine(response.result);
                }
            }
        }
    } else { // SELECTION
        text = editor.document.getText(editor.selection);
        const isParameter = /^\S+$/.test(text.trim());

        if (isParameter) {
            const expression = `value = mem('${text}'); printf(value, '${text}', ${line})`;
            const expr = `-exec python exec(${JSON.stringify(expression)})`;
            const response = await session.customRequest('evaluate', {
                expression: expr,
                context: 'repl',
                frameId: frameId
            });
            if (response && typeof response.result === 'string' && response.result.length > 0) {
                vscode.debug.activeDebugConsole.appendLine(response.result);
            }
        } else {
            const lines = text.split(/\r?\n/).map(line => line.replace(/\s+$/, ''));

            const valid_lines = [];
            for (const line of lines.map(line => line.trim())) {
                if (line !== '' && !await runExec(line)) { // -EXEC NODELETE
                    valid_lines.push(line);
                }
            }

            if (valid_lines.length > 0) {
                let expression = valid_lines.join(" \n");
                const expr = `-exec python exec(${JSON.stringify(expression)})`;
                const response = await session.customRequest('evaluate', {
                    expression: expr,
                    context: 'repl',
                    frameId: frameId
                });
                if (response && typeof response.result === 'string' && response.result.length > 0) {
                    vscode.debug.activeDebugConsole.appendLine(response.result);
                }
            }
        }
    }
}

async function memCppPython(session) {
    const editor = vscode.window.activeTextEditor;
    const frameId = await getFrameId(session);

    let text;
    if (editor.selection.isEmpty) { // ALL TEXT NODELETE
        text = editor.document.getText();
        LOG && log('memCppPython', 'editor.document.getText()', text);
    } else { // SELECTION NODELETE
        text = editor.document.getText(editor.selection);
        LOG && log('memCppPython', 'editor.document.getText(editor.selection)', text);
    }

    // Keep the Python source intact and avoid passing its quotes and newlines
    // through the debugger adapter's command parser.
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    const expr = `-exec python exec(__import__('base64').b64decode('${encoded}'))`;
    LOG && log('memCppPython', expr);

    try {
        const response = await session.customRequest('evaluate', {
            expression: expr,
            context: 'repl',
            frameId: frameId
        });
        if (response && typeof response.result === 'string' && response.result.length > 0) {
            vscode.debug.activeDebugConsole.appendLine(response.result);
        }
    } catch (e) {
        log('Error memCppPython', expr, e.message);
    }
}

async function memPythonPython(session) {
    const editor = vscode.window.activeTextEditor;
    // if (!editor.selection.isEmpty) {
    //     await vscode.commands.executeCommand('editor.debug.action.selectionToRepl');
    //     return;
    // }

    const frameId = await getFrameId(session);
    let expression;

    if (editor.selection.isEmpty) {
        const pos = editor.selection.active;
        const range = editor.document.getWordRangeAtPosition(pos);
        if (range) { // TOKEN
            const text = editor.document.getText(range);
            LOG && log('memCppPython TOKEN', 'range', JSON.stringify(range));
            LOG && log('memCppPython TOKEN', 'text', text);

            const inspectCode = [
                'import numpy as np',
                'display = value',
                "size = ''",
                'try:',
                '    data = np.asarray(value)',
                '    if isinstance(value, (list, tuple)) or hasattr(value, "shape"):',
                "        size = list(data.shape) if data.shape else ''",
                '    if np.issubdtype(data.dtype, np.number):',
                '        display = data.round(3) if data.shape else data.round(3).item()',
                '    if isinstance(display, np.ndarray):',
                '        display = np.array2string(display, max_line_width=200, threshold=100, edgeitems=50, precision=3, suppress_small=True)',
                'except (TypeError, ValueError):',
                '    size = "ragged" if isinstance(value, (list, tuple)) else ""',
                'lines = str(display).splitlines()',
                'if len(lines) > 20:',
                '    display = "\\n".join(lines[:10] + ["..."] + lines[-10:])',
                'print(display, label, size, location)'
            ].join('\n');
            expression = `exec(${JSON.stringify(inspectCode)}, {'value': ${text}, 'label': ${JSON.stringify(`<= ${text}`)}, 'location': ${JSON.stringify(`⌊${pos.line + 1}⌉`)}})`;

        } else { // ALL TEXT
            expression = editor.document.getText();
            LOG && log('memPythonPython', 'editor.document.getText()', expression);

        }
    } else { // SELECTION
        expression = editor.document.getText(editor.selection);
        LOG && log('memPythonPython', 'editor.document.getText(editor.selection)', expression);
    }

    const expr = expression;
    LOG && log('memPythonPython', expr);

    try {
        const response = await session.customRequest('evaluate', {
            expression: expr,
            context: 'repl',
            frameId: frameId
        });
        if (response && typeof response.result === 'string' && response.result.length > 0) {
            vscode.debug.activeDebugConsole.appendLine(response.result);
        }
    } catch (e) {
        log('Error memPythonPython', expr, e.message);
    }
}

async function debugPython(editor) {
    try {
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const started = await vscode.debug.startDebugging(folder, {
            name: 'Python: Current File (F8)',
            type: 'debugpy',
            request: 'launch',
            program: editor.document.uri.fsPath,
            cwd: path.dirname(editor.document.uri.fsPath),
            console: 'internalConsole',
            internalConsoleOptions: 'openOnSessionStart',
            redirectOutput: true,
            noDebug: false
        });
        if (!started) {
            vscode.window.showErrorMessage('mem: Could not start the Python debugger.');
        }
    } catch (e) {
        log('Error debugPython', e.message);
        vscode.window.showErrorMessage(`mem: ${e.message}`);
    }
}

async function cmdMem() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        log('vscode.window.activeTextEditor; !editor return');
        return;
    }

    if (!await editor.document.save()) return;

    let isPythonFile = true;
    {
        const langId = editor.document.languageId;
        const ext = path.extname(editor.document.uri.fsPath).toLowerCase();
        isPythonFile = langId === 'python' || ext === '.py';
    }
    LOG && log('isPythonFile', isPythonFile);

    const session = vscode.debug.activeDebugSession;
    if (!session) {
        if (isPythonFile) {
            log('!session runPython(editor)');
            await runPython(editor);
        }
        LOG && log('!session return');
        return;
    }

    let isPythonProgram = false;
    {
        const session_type = (session.type || '').toLowerCase();
        if (['debugpy', 'python', 'pythonexperimental'].includes(session_type)) {
            isPythonProgram = true;
        }
    }
    LOG && log('isPythonProgram', isPythonProgram);

    if (!isPythonProgram) { // C++ program
        if (!isPythonFile) { // C++ program, C++ file
            LOG && log('memCppCpp(session) C++ program, C++ file')
            await initialMem(session);
            await printStack(session);

            if (editor.selection.isEmpty) {
                const commandText = editor.document.lineAt(editor.selection.active.line).text;
                if (!/[\r\n]/.test(commandText) && await runExec(commandText)) return;
            }

            await memCppCpp(session);

        } else { // C++ program, Python file
            LOG && log('memCppPython(session) C++ program, Python file')
            await initialMem(session);
            await printStack(session);
            await memCppPython(session);
        }

    } else { // Python program
        if (isPythonFile) { // Python program, Python file
            LOG && log('memPythonPython(session) Python program, Python file')
            await printStack(session)
            await memPythonPython(session);
        }
    }
}

function isPythonFile(filename) { return /\.py$/i.test(filename); }
function isCppFile(filename) { return /\.(c|cc|cpp|h|hpp)$/i.test(filename); }
function isShaderFile(filename) { return /\.(vert|frag|comp|glsl)$/i.test(filename); }
function isKernelFile(filename) { return /\.(cu|cuh)$/i.test(filename); }

async function createCppTest(sourcefile, testfile) {
    const includePath = path.relative(path.dirname(testfile), sourcefile).replace(/\\/g, '/');
    const wrapper = `#include <stdio.h>\n#include "${includePath}"\n\nint main() {\n    printf("hello mingjie!");\n    return 0;\n}\n`;
    try {
        await fs.promises.writeFile(testfile, wrapper, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
        if (e.code !== 'EEXIST') {
            log('Error creating common C++ wrapper', e.message);
            vscode.window.showErrorMessage(`mem: ${e.message}`);
            return;
        }
    }
}

async function createShaderTest(sourcefile, testfile) {
    const includePath = path.relative(path.dirname(testfile), sourcefile).replace(/\\/g, '/');
    const wrapper = `#include <stdio.h>\n#include "${includePath}"\n\nint main() {\n    printf("hello mingjie!");\n    shader();\n    return 0;\n}\n`;
    try {
        await fs.promises.writeFile(testfile, wrapper, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
        if (e.code !== 'EEXIST') {
            log('Error creating shader C++ wrapper', e.message);
            vscode.window.showErrorMessage(`mem: ${e.message}`);
            return;
        }
    }
}

async function createKernelTest(sourcefile, testfile) {
    const header = sourcefile.replace(/\.cu$/, '.cuh');
    const includePath = path.relative(path.dirname(testfile),
        fs.existsSync(header) ? header : sourcefile).replace(/\\/g, '/');
    const wrapper = `#include <stdio.h>\n#include "kernel.h"\n#include "${includePath}"\n\nint main() {\n    printf("hello mingjie!");\n    return 0;\n}\n`;
    try {
        await fs.promises.writeFile(testfile, wrapper, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
        if (e.code !== 'EEXIST') {
            log('Error creating kernel C++ wrapper', e.message);
            vscode.window.showErrorMessage(`mem: ${e.message}`);
            return;
        }
    }
}

async function createKernelGpuTest(sourcefile, testfile) {
    const header = sourcefile.replace(/\.cu$/, '.cuh');
    const includePath = path.relative(path.dirname(testfile),
        fs.existsSync(header) ? header : sourcefile).replace(/\\/g, '/');
    const wrapper = `#include <stdio.h>\n#include <cuda_runtime.h>\n#include "${includePath}"\n\nint main() {\n    printf("hello mingjie!");\n    return 0;\n}\n`;
    try {
        await fs.promises.writeFile(testfile, wrapper, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
        if (e.code !== 'EEXIST') {
            log('Error creating kernel GPU test', e.message);
            vscode.window.showErrorMessage(`mem: ${e.message}`);
            return;
        }
    }
}

function isTestFile(filename) {
    if (isShaderFile(filename)) return false;
    const contents = fs.readFileSync(filename, 'utf8');
    return contents.includes('main(') || contents.includes('Main(');
}

async function debugCppDbg(source) {
    LOG && log('start debugCudaGdb', source);
    if (!await vscode.workspace.saveAll()) return false;
    LOG && log('vscode.workspace.saveAll()');

    if (!isTestFile(source)) {
        const testfile = `${source}_.cc`;
        if (fs.existsSync(testfile)) {
            LOG && log("exist file", testfile);
            source = testfile;
        } else if (isShaderFile(source)) {
            LOG && log("createShaderTest", testfile);
            await createShaderTest(source, testfile);
            return;
        } else if (isKernelFile(source)) {
            LOG && log("createKernelTest", testfile);
            await createKernelTest(source, testfile);
            return;
        } else if (isCppFile(source)) {
            LOG && log("createCppTest", testfile);
            await createCppTest(source, testfile);
            return;
        } else {
            LOG && log("return", testfile);
            return;
        }
    }

    const filePath = path.dirname(source); // file path
    LOG && log('filePath', filePath);

    const filename = path.basename(source); // filename
    LOG && log('filename', filename);

    const projectPath = await getProjectPath(); // project path
    LOG && log('projectPath', projectPath);

    const buildPath = path.join(projectPath, 'build');
    log('buildPath', buildPath);

    const application = prepareCpu(source, buildPath);
    log('application', application);

    log('vscode.debug.startDebugging', 'CPPDBG', filename);
    const started = await vscode.debug.startDebugging(undefined, {
        name: `CPPDBG ${filename}`,
        type: 'cppdbg',
        request: 'launch',
        program: application,
        cwd: filePath,
        MIMode: 'gdb',
        miDebuggerPath: process.env.GDB || 'gdb',
        internalConsoleOptions: 'openOnSessionStart',
        stopAtEntry: false
    });

    if (!started) {
        vscode.window.showErrorMessage('mem: Could not start the C++ debugger. Check that the C/C++ extension is enabled.');
    }

    log('vscode.debug.startDebugging', 'CPPDBG', started);
    return started;
}

async function cmdCppDbg() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        log('vscode.window.activeTextEditor; !editor return');
        return;
    }

    const filename = editor.document.uri.fsPath;
    LOG && log('filename', filename);

    if (await isPythonFile(filename)) { // python file
        LOG && log('debugPython', 'isPythonFile:true', filename)
        await debugPython(editor);
    } else {
        await debugCppDbg(filename);
    }
}

async function debugCudaGdb(source) {
    LOG && log('start debugCudaGdb', source);
    if (!await vscode.workspace.saveAll()) return false;
    LOG && log('vscode.workspace.saveAll()');

    if (!isTestFile(source)) {
        const testfile = `${source}_.cu`;
        if (fs.existsSync(testfile)) {
            LOG && log("exist file", testfile);
            source = testfile;
        } else if (isShaderFile(source)) {
            LOG && log("createShaderTest", testfile);
            await createShaderTest(source, testfile);
            return;
        } else if (isKernelFile(source)) {
            LOG && log("createKernelTest", testfile);
            await createKernelGpuTest(source, testfile);
            return;
        } else if (isCppFile(source)) {
            LOG && log("createCppTest", testfile);
            await createCppTest(source, testfile);
            return;
        } else {
            LOG && log("return", testfile);
            return;
        }
    }

    const filePath = path.dirname(source); // file path
    LOG && log('filePath', filePath);

    const filename = path.basename(source); // filename
    LOG && log('filename', filename);

    const projectPath = await getProjectPath(); // project path
    LOG && log('projectPath', projectPath);

    const buildPath = path.join(projectPath, 'build');
    log('buildPath', buildPath);

    const application = prepareGpu(source, buildPath);
    log('application', application);

    log('vscode.debug.startDebugging', 'CUDA-GDB', filename);
    const started = await vscode.debug.startDebugging(undefined, {
        name: `CUDA-GDB ${filename}`,
        type: 'cuda-gdb',
        request: 'launch',
        program: application,
        cwd: filePath,
        debuggerPath: process.env.CUDA_GDB || '/usr/local/cuda/bin/cuda-gdb',
        internalConsoleOptions: 'openOnSessionStart',
        stopAtEntry: false
    });

    if (!started) {
        log('Could not start the CUDA-GDB debugger.');
    }

    log('vscode.debug.startDebugging', 'CUDA-GDB', started);
    return started;
}

async function cmdCudaGdb() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        log('vscode.window.activeTextEditor; !editor return');
        return;
    }

    const filename = editor.document.uri.fsPath;
    LOG && log('filename', filename);

    if (await isPythonFile(filename)) { // python file
        LOG && log('debugPython', 'isPythonFile:true', filename)
        await debugPython(editor);
    } else {
        await debugCudaGdb(filename);
    }
}

function expandCondition(editor, condition) {
    // Expand global thread coordinates only inside a CUDA kernel body.
    const source = editor.document.getText().slice(0,
        editor.document.offsetAt(editor.selection.active));
    const clean = source.replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
        value => value.replace(/[^\r\n]/g, ' ')
    );
    const inKernel = [...clean.matchAll(/\b__global__\b[^;{}]*\{/g)].some(kernel => {
        let depth = 1;
        for (let i = kernel.index + kernel[0].length; i < clean.length; i++) {
            if (clean[i] === '{') depth++;
            if (clean[i] === '}' && --depth === 0) return false;
        }
        return true;
    });
    if (inKernel) {
        condition = condition.replace(/\bidx\s*\.\s*([xyz])\b/g,
            (_, axis) => `(blockIdx.${axis} * blockDim.${axis} + threadIdx.${axis})`)
            .replace(/(?<![=!<>])=(?!=)/g, '==');
    }
    return condition;
}

async function toggleBreakpoint() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    let text = editor.document.lineAt(editor.selection.active.line).text;
    text = text.trim().replace(/^(?:\/{2,}|\/\*)\s*/, '')
        .replace(/\s*\*\/\s*$/, '').trim();

    const match = text.match(/^-?exec\s+break(?:\s|$)/);
    if (!match) {
        LOG && log("normal breakpoint: editor.debug.action.toggleBreakpoint");
        await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
        return false;
    }

    text = text.slice(match.index).trim();

    if (/^-?exec\s+break(?:\s|$)/.test(text)) {
        // -exec break [if] expression (optionally quoted)
        let condition = text.replace(/^-?exec\s+break\s*/, '').trim();
        for (let pass = 0; pass < 2; pass++) {
            if (condition.length >= 2 &&
                ((condition.startsWith("'") && condition.endsWith("'")) ||
                    (condition.startsWith('"') && condition.endsWith('"')))) {
                condition = condition.slice(1, -1).trim();
            }
            if (pass === 0) condition = condition.replace(/^if\s+/, '').trim();
        }

        condition = expandCondition(editor, condition);

        const line = editor.selection.active.line;
        const uri = editor.document.uri;
        const existing = vscode.debug.breakpoints.filter(breakpoint =>
            breakpoint instanceof vscode.SourceBreakpoint &&
            breakpoint.location.uri.toString() === uri.toString() &&
            breakpoint.location.range.start.line === line
        );

        log(`-exec break ${uri.fsPath}:${line + 1}`, condition);

        if (existing.length > 0) {
            vscode.debug.removeBreakpoints(existing);
        } else {
            vscode.debug.addBreakpoints([
                new vscode.SourceBreakpoint(
                    new vscode.Location(uri, new vscode.Position(line, 0)),
                    true, condition || undefined
                )
            ]);
        }
    }
}

async function install() {
    if (!await vscode.workspace.saveAll()) return;

    const extensionPath = (vscode.workspace.workspaceFolders || [])
        .filter(folder => folder.uri.scheme === 'file')
        .map(folder => path.join(folder.uri.fsPath, 'mem', 'extension'))
        .find(dir => fs.existsSync(path.join(dir, 'install.sh')));
    if (!extensionPath) {
        vscode.window.showErrorMessage('mem: Open the project containing mem/extension/install.sh.');
        return;
    }
    const installFile = path.join(extensionPath, 'install.sh');

    LOG && log('extensionPath', extensionPath);
    LOG && log('install', installFile);

    let stdout, stderr;
    try {
        ({ stdout, stderr } = await execFileAsync(
            'bash',
            [installFile],
            { cwd: extensionPath, maxBuffer: 10 * 1024 * 1024 }
        ));
    } catch (error) {
        vscode.window.showErrorMessage(`mem: Installation failed: ${error.stderr || error.message}`);
        return;
    }

    if (stdout) log(stdout.trimEnd());
    if (stderr) log(stderr.trimEnd());

    await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function activate(context) {
    try {
        registerShaderDefinitions(vscode, context);
    } catch (error) {
        console.error('mem: Error registering shader definitions', error);
    }

    const memCmd = vscode.commands.registerCommand('mem', async () => { // F8
        try {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.document.isClosed && !await editor.document.save()) return;
            await cmdMem();
        } catch (error) {
            console.error('mem: Error running cmdMem', error);
            log('Error running cmdMem', error.message || error);
            vscode.window.showErrorMessage(`mem: ${error.message || error}`);
        }
    });

    const cudaGdbCmd = vscode.commands.registerCommand('cuda-gdb', async () => { // F4
        try {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.document.isClosed && !await editor.document.save()) return;
            await cmdCudaGdb();
        } catch (error) {
            log('Error activate::cmdCudaGdb', error.message || error);
            vscode.window.showErrorMessage(`mem: ${error.message || error}`);
        }
    });

    const cppDbgCmd = vscode.commands.registerCommand('cppdbg', async () => { // F6
        try {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.document.isClosed && !await editor.document.save()) return;
            await cmdCppDbg();
        } catch (error) {
            log('Error activate::cmdCppDbg', error.message || error);
            const detail = error.stderr ? String(error.stderr).trim() : (error.message || String(error));
            vscode.window.showErrorMessage(`mem: ${detail}`);
        }
    });

    // Keep the stop shortcuts bound even after the session has ended so that
    // repeated presses cannot resolve to another debug command.
    const stopCmd = vscode.commands.registerCommand('stop', async () => {
        const session = vscode.debug.activeDebugSession;
        if (!session) return;
        try {
            await vscode.debug.stopDebugging(session);
        } catch (error) {
            vscode.window.showErrorMessage(`mem: ${error.message || error}`);
        }
    });

    const toggleBreakpointCmd = vscode.commands.registerCommand('toggleBreakpoint', async () => { // F9
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.document.isClosed && !await editor.document.save()) return;
        try {
            LOG && log("toggleBreakpoint");
            await toggleBreakpoint();
        } catch (error) {
            vscode.debug.activeDebugConsole.appendLine(`toggleBreakpoint: ${error.message || error}`);
        }
    });

    const stepOverCmd = vscode.commands.registerCommand('stepOver', async () => { // F10
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.document.isClosed && !await editor.document.save()) return;

        try {
            await vscode.commands.executeCommand('workbench.action.debug.stepOver');
        } catch (error) {
            vscode.debug.activeDebugConsole.appendLine(`stepOver: ${error.message || error}`);
            const session = vscode.debug.activeDebugSession;
            if (session) {
                await aware(session);
                await vscode.commands.executeCommand('workbench.action.debug.stepOver');
            }
        }
    });

    const installCmd = vscode.commands.registerCommand('install', async () => {
        try {
            await install();
        } catch (error) {
            log('Error activate::install', error.message || error);
        }
    });

    context.subscriptions.push(memCmd, cudaGdbCmd, cppDbgCmd, stopCmd, toggleBreakpointCmd, stepOverCmd, installCmd);
}

function deactivate() {}
module.exports = { activate, deactivate };
