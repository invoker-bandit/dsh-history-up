/**
 * Prepares `test/.build/` so the Host half can be imported without installing
 * its two real dependencies.
 *
 * `index.js` imports `zod` for the projection schemas and `@deepseek-ai/schemastery`
 * for the `Config` schema. Stands-in covering the handful of builders the plugin
 * uses are enough to execute the fold, and they keep this repository free of a
 * `node_modules` directory. The schemastery stand-in is deliberately faithful
 * about `.default()` and its bounds, because the tests assert on them; the zod
 * stand-in stays permissive. Both schemas are validated by the real packages
 * once the bundle is installed.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const build = `${here}.build`

rmSync(build, { recursive: true, force: true })
mkdirSync(`${build}/node_modules/zod`, { recursive: true })

cpSync(`${here}../index.js`, `${build}/plugin.mjs`)

writeFileSync(
  `${build}/node_modules/zod/index.js`,
  `const scalar = (type) => ({ type, parse: (v) => v })
export const z = {
  object: (shape) => ({
    kind: 'object',
    shape,
    parse: (v) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('not an object')
      for (const k of Object.keys(shape)) if (!(k in v)) throw new TypeError(\`missing \${k}\`)
      return v
    },
  }),
  array: (sub) => ({ kind: 'array', parse: (v) => { if (!Array.isArray(v)) throw new TypeError('not an array'); return v } }),
  number: () => scalar('number'),
  string: () => scalar('string'),
}
`,
)

writeFileSync(
  `${build}/node_modules/zod/package.json`,
  `${JSON.stringify({ name: 'zod', version: '0.0.0-test-stub', type: 'module', main: 'index.js' }, null, 2)}\n`,
)

// The schemastery stand-in keeps real bound/default behaviour, because
// `Config` is the contract the Plugins panel renders a form from. A real
// schemastery schema is a callable that validates and resolves, so this one is
// callable too rather than exposing a `resolve()` the library does not have.
// Its rejection messages copy the real wording ("expected number >= 1 but got
// 0") so a test that passes here is asserting the contract the Loader applies.
mkdirSync(`${build}/node_modules/@deepseek-ai/schemastery`, { recursive: true })
writeFileSync(
  `${build}/node_modules/@deepseek-ai/schemastery/index.js`,
  `const number = () => {
  let min = -Infinity
  let max = Infinity
  let step = null
  let fallback
  // Real schemastery schemas carry a \`meta\` object and a string \`type\`;
  // \`dsh-settings\` and \`dsh-app-boot\` read both, so the stand-in has them.
  const meta = { volatile: false }
  const schema = (v, path = '$') => {
    if (v === undefined) {
      if (fallback !== undefined) return fallback
      throw new Error(\`\${path} expected a value\`)
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(\`\${path} expected number but got \${String(v)}\`)
    if (v < min) throw new Error(\`\${path} expected number >= \${String(min)} but got \${String(v)}\`)
    if (v > max) throw new Error(\`\${path} expected number <= \${String(max)} but got \${String(v)}\`)
    if (step !== null && !Number.isInteger(v / step)) throw new Error(\`\${path} expected number multiple of \${String(step)} but got \${String(v)}\`)
    return v
  }
  schema.type = 'number'
  schema.meta = meta
  schema[Symbol.for('schemastery')] = true
  schema.min = (n) => { min = n; return schema }
  schema.max = (n) => { max = n; return schema }
  schema.step = (n) => { step = n; return schema }
  schema.default = (d) => { fallback = d; return schema }
  schema.volatile = () => { meta.volatile = true; return schema }
  return schema
}
export default {
  number,
  object: (shape) => {
    // A volatile field resolves to a CELL carrying \`get()\`, not the bare value
    // (real schemastery: \`config.fontSize.get()\`). Modelling that here is what
    // stops a reader that forgets \`get()\` from passing against the stub while
    // breaking on the installed package.
    const cell = value => ({ get: () => value })
    const wrapped = {}
    for (const [key, sub] of Object.entries(shape)) {
      const resolve = sub
      const field = (v, path = \`$\${key}\`) => {
        const value = resolve(v, path)
        if (value === undefined) return undefined
        return sub.meta.volatile ? cell(value) : value
      }
      field.meta = sub.meta
      wrapped[key] = field
    }
    const schema = (v, path = '$') => {
      const input = v === undefined || v === null ? {} : v
      if (typeof input !== 'object' || Array.isArray(input)) throw new Error(\`\${path} expected an object\`)
      const out = {}
      for (const [key, sub] of Object.entries(wrapped)) {
        const value = sub(input[key], \`\${path}.\${key}\`)
        if (value !== undefined) out[key] = value
      }
      return out
    }
    schema.type = 'object'
    schema.meta = { volatile: false }
    schema.dict = wrapped
    schema[Symbol.for('schemastery')] = true
    return schema
  },
}
`,
)
writeFileSync(
  `${build}/node_modules/@deepseek-ai/schemastery/package.json`,
  `${JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test-stub', type: 'module', main: 'index.js' }, null, 2)}\n`,
)
