import { execFile } from 'node:child_process'

/** "ThinkPad X1 Carbon Gen 11", "Surface Laptop 5" — the name the maker gave
 *  the machine, from WMI, resolved once. A part number is the fallback; a
 *  guess is not. */
export function resolveWindowsModel(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$p = Get-CimInstance Win32_ComputerSystemProduct; $c = Get-CimInstance Win32_ComputerSystem; @($p.Version, $p.Name, $c.Model) | ConvertTo-Json -Compress',
      ],
      { timeout: 10_000, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve('PC')
          return
        }
        try {
          const raw = JSON.parse(stdout) as unknown
          const values = (Array.isArray(raw) ? raw : [raw]).filter((value): value is string => typeof value === 'string')
          // `Version` carries the marketing name on Lenovo and others; `Name`
          // and `Model` on the rest. The first one that is not a placeholder wins.
          const placeholder = /^(none|to be filled|default string|system product name|system version|not specified|)$/i
          const name = values.map((value) => value.trim()).find((value) => value && !placeholder.test(value))
          resolve(name ?? 'PC')
        } catch {
          resolve('PC')
        }
      },
    )
  })
}
