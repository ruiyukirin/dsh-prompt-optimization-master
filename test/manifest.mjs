/**
 * dsh-prompt-optimization-master — manifest guard
 * Author: Kirin (ruiyukirin)
 *
 * The 0.3.2 release shipped because `dsh.compatibility` was declared, read by
 * nothing, and quietly aged out: the plugin kept working while the marketplace
 * called its host support "unknown". These checks turn that class of mistake
 * (a manifest field that looks authoritative but is inert) into a red build.
 *
 *   node test/manifest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let failures = 0
let checks = 0

function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

const pkg = readJson('package.json')

section('identity')
check('name is the published name', pkg.name === 'dsh-prompt-optimization-master', pkg.name)
check('version is plain semver', /^\d+\.\d+\.\d+$/.test(String(pkg.version)), pkg.version)
check('declared as an ESM package', pkg.type === 'module', pkg.type)
check('main points at the host half', pkg.main === './dsh/index.js', pkg.main)
check('main file exists', exists('dsh/index.js'))

section('host compatibility — the field the runtime actually reads')
check('engines.dsh is a non-empty string', typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.trim().length > 0, pkg.engines?.dsh)
// `<0.3.0` would reject DSH 0.3 the moment it ships; the runtime treats a range
// it cannot satisfy as a hard install failure, not a warning.
check('engines.dsh opens the 0.3 line', !/<0\.3\.0\s*$/.test(String(pkg.engines?.dsh ?? '')), pkg.engines?.dsh)
check('engines.node is still declared', typeof pkg.engines?.node === 'string', pkg.engines?.node)
check('the inert dsh.compatibility block is gone', pkg.dsh?.compatibility === undefined, pkg.dsh?.compatibility)

section('client half')
const clientEntry = pkg.exports?.['./client']
check('exports ./client', typeof clientEntry === 'string', clientEntry)
check('client file exists', typeof clientEntry === 'string' && exists(clientEntry), clientEntry)
const inject = pkg.dsh?.client?.inject
check('declares the locale injection', Array.isArray(inject) && inject.includes('@deepseek-ai/dsh-client-locale'), inject)
check('declares the web platform', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client?.platform)
check('wires the bundle patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', pkg.dsh?.bundle?.patch)

section('bundle patch')
check('cordis.patch.yml exists', exists('cordis.patch.yml'))
const patch = exists('cordis.patch.yml') ? readText('cordis.patch.yml') : ''
check('patch has exactly one top-level insert', (patch.match(/^- insert:/gm) || []).length === 1)
check('patch inserts a stable id', /^\s+- id: prompt-enhance$/m.test(patch))
// The specifier is what the client half registers itself as; a rename here
// silently breaks the settings page while the button keeps working.
check('patch mounts this package', patch.includes(`name: '${pkg.name}'`), pkg.name)

section('published file list')
const files = Array.isArray(pkg.files) ? pkg.files : []
for (const required of ['dsh', 'client', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  check(`files includes ${required}`, files.includes(required), files)
}
check('files never ships the tests', !files.includes('test'))

section('changelog')
const changelog = readText('CHANGELOG.md')
check('changelog documents the current version', changelog.includes(`## [${pkg.version}]`), pkg.version)
check('changelog keeps Unreleased at the top', /## \[Unreleased\]/.test(changelog))

section('readme')
const readme = readText('README.md')
check('README names engines.dsh', readme.includes('engines.dsh'))
check('README shows the npm install command', readme.includes(`dsh plugin --profile web add ${pkg.name}`))
check('README.en.md is kept in step', readText('README.en.md').includes(`dsh plugin --profile web add ${pkg.name}`))

console.log(`\n${checks - failures}/${checks} manifest checks passed`)
if (failures > 0) {
  console.log(`${failures} FAILED`)
  process.exit(1)
}
