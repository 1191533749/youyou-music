import { describe, expect, it } from 'vitest'
import QRCode from 'qrcode'
import { encodeQR } from '../src/main/qrcode.js'

describe('QR encoding', () => {
  it('reproduces the reference library matrix for a login URL', () => {
    const text = 'https://music.163.com/login?codekey=11186a3d-e81d-4ac8-abd1-3243ee769113'
    const reference = QRCode.create(text, { errorCorrectionLevel: 'M' })
    const mine = encodeQR(text)
    expect(mine.size).toBe(reference.modules.size)
    for (let row = 0; row < mine.size; row += 1) {
      for (let col = 0; col < mine.size; col += 1) {
        expect(mine.modules[row][col]).toBe(reference.modules.get(row, col) === 1)
      }
    }
  })

  it('produces a square matrix with finder patterns in three corners', () => {
    const { size, modules } = encodeQR('https://music.163.com/login?codekey=abc')
    expect(size).toBeGreaterThanOrEqual(21)
    expect(modules.length).toBe(size)
    for (const row of modules) expect(row.length).toBe(size)
    // Each finder pattern is a 7x7 ring with a 3x3 core.
    for (const [row, col] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0]
    ]) {
      expect(modules[row][col]).toBe(true)
      expect(modules[row + 1][col + 1]).toBe(false)
      expect(modules[row + 3][col + 3]).toBe(true)
    }
  })
})
