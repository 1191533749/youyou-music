/**
 * QR code rendering.
 *
 * The renderer draws the login QR code, so the main process hands it the module
 * matrix and React renders a table of divs. Routing it through the `qrcode`
 * package rather than a hand-rolled encoder is deliberate: the QR spec's mask
 * selection and format info are easy to get subtly wrong, and a wrong QR code
 * is a login the user cannot complete.
 */
import QRCode from 'qrcode'

export interface QRMatrix {
  /** Number of modules per side. */
  size: number
  /** Row-major booleans; true means a dark module. */
  modules: boolean[][]
}

/** Encodes `text` as a QR module matrix (byte mode, ECC level M). */
export function encodeQR(text: string): QRMatrix {
  const symbol = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const size = symbol.modules.size
  const modules: boolean[][] = []
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = []
    for (let col = 0; col < size; col += 1) {
      line.push(symbol.modules.get(row, col) === 1)
    }
    modules.push(line)
  }
  return { size, modules }
}
