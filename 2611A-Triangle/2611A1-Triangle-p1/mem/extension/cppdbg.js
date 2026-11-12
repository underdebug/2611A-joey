
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const buildConfig = require('./config.json').cppdbg;

function getBuildOptions(projectDir) {
    const resolveDir = dir => path.resolve(projectDir, dir);
    return {
        compileArgs: buildConfig.includeDirs.flatMap(dir => ['-I', resolveDir(dir)]),
        linkArgs: [
            ...buildConfig.libraryDirs.flatMap(dir => ['-L', resolveDir(dir)]),
            ...buildConfig.libraries.map(library => `-l${library}`),
            ...buildConfig.linkArgs
        ]
    };
}

function replace_cpp(text){
    // Input:                   Output:
    // int x; // hello          int x; ········
    // run(); // test           run(); ·······
    // // comment               ··········
    text = text.replace(/\/\/[^\r\n]*/g, value => ' '.repeat(value.length));

    // Input:                   Output:
    // a /* note */ + b         a ·········· + b
    // a /* note                a ·······
    //    more */ + b               ·········· + b
    text = text.replace(/\/\*[\s\S]*?\*\//g, value => value.replace(/[^\r\n]/g, ' '));

    // Change MAIN( to main(
    text = text.replace(/\bMain(?=\s*\()/g, 'main');
    return text;
}

function replace_shader(text){
    if (!/^[ \t]*#version\b/m.test(text)){
        return text;
    } 

    // #version ... => #include "shader.h"
    text = text.replace(/^[ \t]*#version\b[^\r\n]*/, '#include "shader.h"');

    // main() => SHADER().
    text = text.replace(/\bmain\s*\(\s*\)/g, 'Shader()');
    return text;
}

function replace_kernel(text){
    // #include <cuda_...> => #include "kernel.h"
    text = text.replace(/^[ \t]*#[ \t]*include[ \t]*[<"]cuda_[^>"\r\n]*[>"]/gm, '#include "kernel.h"');

    // Use the same CPU declarations for CUDA libraries and Thrust headers.
    text = text.replace(/^[ \t]*#[ \t]*include[ \t]*[<"](?:cublas[^>"\r\n]*|cusparse[^>"\r\n]*|thrust\/[^>"\r\n]*)[>"]/gm, '#include "kernel.h"');
 
    // #include <device_launch_parameters.h> => #include "kernel.h"
    text = text.replace(/^[ \t]*#[ \t]*include[ \t]*[<"]device_launch_parameters\.h[>"]/gm, '#include "kernel.h"');
    return text;
}

function replace_kernel_func(text){
    // kernel<<<grid, block>>>(args) => run_kernel(dim3(grid), dim3(block), ...)
    // kernel<<<grid, block>>>( => kernel name and launch configuration
    const launch = /\b([A-Za-z_]\w*(?:::\w+)*)[ \t]*<<<([^\r\n]*?)>>>[ \t]*\(/g;
    // Matches => replacement ranges and generated calls
    const replacements = [];
    let match;

    while ((match = launch.exec(text)) !== null) {
        const configStart = match.index + match[0].indexOf('<<<') + 3;
        const config = match[2];
        let depth = 0;
        let comma = -1;
        for (let i = 0; i < config.length; i++) {
            if ('([{'.includes(config[i])) depth++;
            else if (')]}'.includes(config[i])) depth--;
            else if (config[i] === ',' && depth === 0) {
                if (comma !== -1) throw new Error('CPU replay supports only grid and block launch dimensions');
                comma = i;
            }
        }
        if (comma < 0) throw new Error('Expected grid and block dimensions in CUDA launch');

        const argsStart = launch.lastIndex;
        let end = argsStart;
        depth = 1;
        while (end < text.length && !/[\r\n]/.test(text[end]) && depth) {
            if (text[end] === '(') depth++;
            else if (text[end] === ')') depth--;
            end++;
        }
        if (depth) continue;

        const grid = text.slice(configStart, configStart + comma);
        const block = text.slice(configStart + comma + 1, configStart + config.length);
        const args = text.slice(argsStart, end - 1);
        replacements.push([match.index, end, `run_kernel(dim3(${grid}), dim3(${block}), [&]() { ${match[1]}(${args}); })`]);
        launch.lastIndex = end;
    }
    for (const [start, end, replacement] of replacements.reverse()) {
        text = text.slice(0, start) + replacement + text.slice(end);
    }
    return text;
}

function replace(text) {
    text = replace_cpp(text);
    text = replace_shader(text);
    text = replace_kernel(text);
    text = replace_kernel_func(text);
    return text;
}

// Read local quoted header references from a C++ source file.
function discoverHeaders(source) {
    const code = fs.readFileSync(source, 'utf8');
    const regex = /^\s*#\s*include\s*"([^"]+)"/gm;
    const headers = [];
    let match;

    while ((match = regex.exec(code)) !== null) {
        headers.push(match[1]);
    }

    return headers;
}

// Find a source file corresponding to a local header.
function findSource(header, sourceDir) {
    const base = header.replace(/\.(h|hpp|hh)$/i, '');
    for (const extension of ['.cu', '.cpp', '.cc', '.cxx']) {
        const source = path.resolve(sourceDir, `${base}${extension}`);
        if (fs.existsSync(source)) return source;
    }

    return null;
}

// Recursively collect source files referenced by local headers.
function collectSources(source, visited = new Set()) {
    source = path.resolve(source);

    if (visited.has(source)) {
        return visited;
    }

    visited.add(source);

    const sourceDir = path.dirname(source);
    const headers = discoverHeaders(source);

    for (const header of headers) {
        const cpp = findSource(header, sourceDir);

        if (cpp) {
            collectSources(cpp, visited);
        }
    }

    return visited;
}

// Generate CPU copies of sources and their local headers without changing the originals.
function generateCpuFile(source, buildDir, sourceRoot, generated = new Map(), changedFiles = new Set()) {
    source = path.resolve(source);
    if (generated.has(source)) return generated.get(source);

    let relative = path.relative(sourceRoot, source);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        relative = path.join('__external__', source.replace(/^([A-Za-z]:)?[/\\]+/, ''));
    }
    const destination = path.join(buildDir, relative);
    generated.set(source, destination);

    let code = fs.readFileSync(source, 'utf8');
    code = code.replace(/^(\s*#\s*include\s*)"([^"\r\n]+)"/gm, (match, prefix, header) => {
        const local = path.resolve(path.dirname(source), header);
        if (!fs.existsSync(local) || !fs.statSync(local).isFile()) return match;
        return prefix + JSON.stringify(generateCpuFile(local, buildDir, sourceRoot, generated, changedFiles));
    });

    code = replace(code);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const contents = `#line 1 ${JSON.stringify(source)}\n${code}`;
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== contents) {
        fs.writeFileSync(destination, contents);
        changedFiles.add(source);
    }
    return destination;
}

function hasChangedDependency(source, changedFiles, visited = new Set()) {
    source = path.resolve(source);
    if (changedFiles.has(source)) return true;
    if (visited.has(source)) return false;
    visited.add(source);

    for (const header of discoverHeaders(source)) {
        const local = path.resolve(path.dirname(source), header);
        if (fs.existsSync(local) && fs.statSync(local).isFile()
            && hasChangedDependency(local, changedFiles, visited)) {
            return true;
        }
    }

    return false;
}

// Compile one C++ source file into an object file.
function compileSource(source, buildDir, generatedDir, compileArgs, originalSource, changedFiles) {
    const object = path.join(buildDir, `${path.relative(generatedDir, source)}.o`);
    fs.mkdirSync(path.dirname(object), { recursive: true });

    if (fs.existsSync(object) && !hasChangedDependency(originalSource, changedFiles)) {
        return { object, compiled: false };
    }

    execFileSync(process.env.CXX || 'g++', [
        '-std=c++17',
        '-g',
        '-x', 'c++', // compile .cu file like .cpp NODELETE
        '-I', __dirname,
        ...compileArgs,
        '-c',
        source,
        '-o',
        object
    ], { encoding: 'utf8' });

    return { object, compiled: true };
}

// Link object files into the executable.
function linkObjects(objects, output, linkArgs) {
    execFileSync(process.env.CXX || 'g++', [
        ...objects,
        '-o',
        output,
        ...linkArgs
    ], { encoding: 'utf8' });
}

function prepareCpu(entry, buildDir) {
    entry = path.resolve(entry);
    const programName = path.basename(entry).replace(/_?\./g, '_');
    buildDir = path.resolve(buildDir);
    
    const objectDir = path.join(buildDir, 'cppdbg'); // object files
    const generatedDir = path.join(buildDir, 'cppdbg'); // generated source files
    const programDir = path.join(buildDir, 'cppdbg'); // executable

    const options = getBuildOptions(path.dirname(buildDir));
    fs.mkdirSync(objectDir, { recursive: true });

    const output = path.join(programDir, programName);
    const sources = [...collectSources(entry)];
    const generated = new Map();
    const changedFiles = new Set();
    const generatedSources = sources.map(source =>
        generateCpuFile(source, generatedDir, path.dirname(entry), generated, changedFiles)
    );
    const compileResults = generatedSources.map((source, index) =>
        compileSource(source, objectDir, generatedDir, options.compileArgs, sources[index], changedFiles)
    );

    if (!compileResults.some(result => result.compiled) && fs.existsSync(output)) {
        return output;
    }

    const objects = compileResults.map(result => result.object);
    linkObjects(objects, output, options.linkArgs);

    return output;
}

module.exports = { prepareCpu };
