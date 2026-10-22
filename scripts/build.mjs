#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argumentsFrom(argv) {
  const options = { manifest: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag !== '--manifest' && flag !== '--out') {
      throw new Error(`Opción desconocida: ${flag}. Usa --help para ver las opciones.`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Falta el valor de ${flag}.`);
    }
    const name = flag.slice(2);
    if (options[name] !== null) {
      throw new Error(`La opción ${flag} solo puede indicarse una vez.`);
    }
    options[name] = resolve(process.cwd(), value);
    i += 1;
  }
  return options;
}

function encodeJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function replaceOnce(template, placeholder, replacement) {
  const pieces = template.split(placeholder);
  if (pieces.length !== 2) {
    throw new Error(`La plantilla debe contener exactamente un marcador ${placeholder}.`);
  }
  return pieces[0] + replacement + pieces[1];
}

async function loadArchive(manifestPath, core) {
  if (!manifestPath) return { archive: [], sourceFiles: 0 };
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest)) {
    throw new Error('El manifiesto debe ser una lista de archivos con name y path.');
  }
  const files = manifest.filter((entry) => (
    entry !== null && typeof entry === 'object'
    && typeof entry.name === 'string'
    && /^conversations-\d{3}\.json$/.test(entry.name)
  )).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) {
    throw new Error('El manifiesto no contiene partes conversations-NNN.json.');
  }
  let archive = [];
  for (const entry of files) {
    if (typeof entry.path !== 'string' || !entry.path.trim()) {
      throw new Error(`Falta la ruta del archivo ${entry.name}.`);
    }
    const inputPath = resolve(dirname(manifestPath), entry.path);
    const payload = JSON.parse(await readFile(inputPath, 'utf8'));
    if (!Array.isArray(payload)) {
      throw new Error(`${entry.name} debe contener una lista de conversaciones.`);
    }
    const extracted = core.extractConversations(payload, basename(entry.name));
    archive = core.mergeConversations(archive, extracted);
  }
  return { archive, sourceFiles: files.length };
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function build() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.help) {
    console.log('Uso: node scripts/build.mjs [--manifest /ruta/archivos.json] [--out /ruta/Chinitex.html]');
    console.log('Sin opciones crea dist/Chinitex.html y dist/index.html sin conversaciones personales.');
    console.log('--manifest permite incluir las partes conversations-NNN.json declaradas en una lista {name,path}.');
    console.log('--out escribe solo el archivo indicado. Los datos incluidos permanecen en ese HTML.');
    return;
  }
  const corePath = resolve(projectRoot, 'src/core.mjs');
  const [template, styles, coreSource, appSource] = await Promise.all([
    readFile(resolve(projectRoot, 'src/index.html'), 'utf8'),
    readFile(resolve(projectRoot, 'src/styles.css'), 'utf8'),
    readFile(corePath, 'utf8'),
    readFile(resolve(projectRoot, 'src/app.mjs'), 'utf8'),
  ]);
  const core = await import(pathToFileURL(corePath).href);
  if (/^\s*import\s/m.test(coreSource)) {
    throw new Error('El core debe poder ejecutarse sin imports externos en el HTML final.');
  }
  const importStatement = /^\s*import\s+\*\s+as\s+Core\s+from\s+(['"])\.\/core\.mjs\1;?\s*$/m;
  if (!importStatement.test(appSource)) {
    throw new Error("app.mjs debe importar el core con: import * as Core from './core.mjs';");
  }
  const app = appSource.replace(importStatement, '');
  if (/^\s*import\s/m.test(app)) {
    throw new Error('La aplicación final no puede depender de otros imports.');
  }
  const exportNames = Object.keys(core);
  if (!exportNames.every((name) => /^[A-Za-z_$][\w$]*$/.test(name))) {
    throw new Error('El core contiene un nombre de exportación no compatible.');
  }
  const { archive, sourceFiles } = await loadArchive(options.manifest, core);
  const bootstrap = { archive, generatedAt: new Date().toISOString() };
  const bundle = `${coreSource}\nconst Core = Object.freeze({ ${exportNames.join(', ')} });\n${app}`
    .replace(/<\/script/gi, '<\\/script');
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: bundle, encoding: 'utf8' });
  let html = replaceOnce(template, '<!--APP_STYLES-->', `<style>\n${styles}\n</style>`);
  html = replaceOnce(html, '<!--APP_SCRIPT-->', (
    `<script type="application/json" id="archive-data">${encodeJson(bootstrap)}</script>\n`
    + `<script type="module">\n${bundle}\n</script>`
  ));
  const output = options.out || resolve(projectRoot, 'dist/Chinitex.html');
  await atomicWrite(output, html);
  if (!options.out) {
    await atomicWrite(resolve(projectRoot, 'dist/index.html'), html);
  }
  console.log(JSON.stringify({
    output,
    conversations: archive.length,
    sourceFiles,
    bytes: Buffer.byteLength(html, 'utf8'),
    mode: options.manifest ? 'archivo-con-datos' : 'aplicacion-vacia',
  }, null, 2));
}

build().catch((error) => {
  console.error(`No se pudo generar Chinitex: ${error.message}`);
  process.exitCode = 1;
});
