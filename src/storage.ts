import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function readOptional(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (!missing(error)) throw error
  }
}

async function syncDirectory(path: string) {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function prepareDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (missing(error)) {
      await prepareDirectory(dirname(path))
      await prepareDirectory(path)
      return
    }
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await syncDirectory(dirname(path))
  await syncDirectory(path)
}

export async function replaceFile(path: string, contents: string) {
  const temporary = join(dirname(path), '.' + randomUUID() + '.tmp')
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(contents)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
