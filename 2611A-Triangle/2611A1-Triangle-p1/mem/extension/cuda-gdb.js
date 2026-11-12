// MIT License

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const buildConfig = require('./config.json')['cuda-gdb'];

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

    // main() => Shader().
    text = text.replace(/\bmain\s*\(\s*\)/g, 'Shader()');
    return text;
}

function replace(text) {
    text = replace_cpp(text);
    text = replace_shader(text);
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

// Generate copies of sources and local headers while keeping debug locations in the originals.
function generateGpuFile(source, buildDir, sourceRoot, generated = new Map(), changedFiles = new Set()) {
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
        return prefix + JSON.stringify(generateGpuFile(local, buildDir, sourceRoot, generated, changedFiles));
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

// Compile one CUDA or C++ source file into an object file.
function compileSource(source, buildDir, generatedDir, compileArgs, originalSource, changedFiles) {
    const object = path.join(buildDir, `${path.relative(generatedDir, source)}.o`);
    fs.mkdirSync(path.dirname(object), { recursive: true });

    if (fs.existsSync(object) && !hasChangedDependency(originalSource, changedFiles)) {
        return { object, compiled: false };
    }

    execFileSync(process.env.NVCC || 'nvcc', [
        '-g',
        '-G',
        ...compileArgs,
        '-c',
        source,
        '-o',
        object
    ], { stdio: 'inherit' });

    return { object, compiled: true };
}

// Link object files into the executable.
function linkObjects(objects, output, linkArgs) {
    execFileSync(process.env.NVCC || 'nvcc', [
        ...objects,
        '-o',
        output,
        ...linkArgs
    ], { stdio: 'inherit' });
}

function prepareGpu(entry, buildDir) {
    entry = path.resolve(entry);
    const programName = path.basename(entry).replace(/_?\./g, '_');
    buildDir = path.resolve(buildDir);

    const objectDir = path.join(buildDir, 'cuda-gdb'); // object files
    const generatedDir = path.join(buildDir, 'cuda-gdb'); // generated source files
    const programDir = path.join(buildDir, 'cuda-gdb'); // executable

    const options = getBuildOptions(path.dirname(buildDir));
    fs.mkdirSync(objectDir, { recursive: true });

    const sources = [...collectSources(entry)];
    const generated = new Map();
    const changedFiles = new Set();
    const generatedSources = sources.map(source =>
        generateGpuFile(source, generatedDir, path.dirname(entry), generated, changedFiles)
    );
    const compileResults = generatedSources.map((source, index) =>
        compileSource(source, objectDir, generatedDir, options.compileArgs, sources[index], changedFiles)
    );
    const output = path.join(programDir, programName);

    if (!compileResults.some(result => result.compiled) && fs.existsSync(output)) {
        return output;
    }

    const objects = compileResults.map(result => result.object);
    linkObjects(objects, output, options.linkArgs);

    return output;
}

module.exports = { prepareGpu };
