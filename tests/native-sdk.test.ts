import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareNativeSdk } from '../scripts/prepare-native-sdk.mjs'

it('rejects a corrupt SDK before extracting or installing any package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-sdk-integrity-'))
  try {
    const archive = join(root, 'corrupt.tgz')
    await writeFile(archive, 'not the published SDK')
    await expect(prepareNativeSdk(join(root, 'sdk'), archive)).rejects.toThrow('checksum')
    expect((await readdir(join(root, 'sdk'))).sort()).toEqual(['package.json', 'pnpm-lock.yaml'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses to replace another SDK manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-sdk-ownership-'))
  try {
    const original = JSON.stringify({ name: 'another-workspace', private: true })
    await writeFile(join(root, 'package.json'), original)
    await expect(prepareNativeSdk(root)).rejects.toThrow('Refusing to change')
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(original)
    expect(await readdir(root)).toEqual(['package.json'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
